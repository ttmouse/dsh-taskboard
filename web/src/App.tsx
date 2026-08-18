import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  isAutomationModel,
  isAutomationReasoningEffort,
  isSupportedModelEffort,
  type AutomationModel,
  type AutomationReasoningEffort,
} from "../../shared/taskboard-automation-options.mjs";
import {
  ApiError,
  addTaskRelation,
  archiveTask as archiveTaskRequest,
  createTask as createTaskRequest,
  getTaskboardRevision,
  getWorkflowWorkspace,
  getTaskboardMetadata,
  getProjectAutomation,
  getClaimModels,
  listArchivedTasks,
  listDevelopmentContexts,
  listDeviceWorkspaces,
  updateProjectAutomation,
  listProjects,
  listTasks,
  moveTask as moveTaskRequest,
  removeTaskRelation,
  restoreTask as restoreTaskRequest,
  deleteArchivedTask as deleteArchivedTaskRequest,
  setCurrentUserActor,
  uploadAttachment,
  updateTask as updateTaskRequest,
  resolveTaskboardUrl,
} from "./api";
import { isDshThreadId } from "./threads";
import {
  actorForAssigneeTarget,
  assigneeTargetForActor,
} from "./actors";
import { BoardColumn, STATUS_DETAILS } from "./components/BoardColumn";
import { AiChat, type AiChatOpenThreadRequest } from "./components/AiChat";
import { BoardSettingsMenu } from "./components/BoardSettingsMenu";
import { DashboardView } from "./components/DashboardView";
import { HiddenColumns } from "./components/HiddenColumns";
import {
  resolveInlineMediaMarkdown,
  type PendingInlineImage,
} from "./components/InlineMediaComposer";
import { IssueListView } from "./components/IssueListView";
import { LinearIcon } from "./components/LinearIcon";
import { ProjectAutomationMenu } from "./components/ProjectAutomationMenu";
import { TaskContextMenu } from "./components/TaskContextMenu";
import { TaskDetail } from "./components/TaskDetail";
import { TaskEditor } from "./components/TaskEditor";
import { TaskFilterMenu } from "./components/TaskFilterMenu";
import { TaskboardIcon } from "./components/TaskboardIcon";
import { buildIssueUrl, readIssueIdentifier } from "./issueRoute";
import { DEFAULT_LABELS } from "./labels";
import {
  getTaskboardI18n,
  resolveTaskboardLanguage,
  TaskboardLanguageProvider,
} from "./i18n";
import { getThemeTarget, onTaskboardThemeChange, publishTheme } from "./themeTarget";
import {
  getTaskboardLocation,
  taskboardPushState,
  taskboardReplaceState,
} from "./taskboardUrl";
import {
  EMPTY_TASK_FILTERS,
  matchesTaskFilters,
  matchesTaskSearch,
  readTaskFilters,
  taskFilterCount,
  writeTaskFilters,
} from "./taskFilters";
import {
  TASK_STATUSES,
  type ActorIdentity,
  type AiChatThread,
  type DevelopmentScan,
  type HostContext,
  type IssueRelationType,
  type Project,
  type Task,
  type TaskboardMetadata,
  type TaskDraft,
  type TaskStatus,
  type WorkflowOption,
} from "./types";
import {
  normalizeCodexThreadId,
  taskCardPresentation,
  type TaskCardPresentation,
  type TaskConversationItem,
} from "./taskConversations";
import {
  DEFAULT_WORKFLOW_OPTIONS,
  readLegacyWorkflowWorkspace,
  workflowOptionsFromWorkspace,
} from "./workflowStore";
// The poller stays in ESM JavaScript so its lifecycle can be tested directly with node:test.
// @ts-expect-error The module's option contract is enforced by its focused node tests.
import { createRevisionPoller, getRevisionPollingInterval } from "./revisionPolling.mjs";

type ConnectionState = "connecting" | "live" | "reconnecting";
type Theme = "light" | "dark";
type BoardView = "dashboard" | "issues" | "list" | "gantt" | "workflow";
type GanttZoom = "day" | "week" | "month";
const SHOW_WORKFLOW_BOARD_ENTRY = false;
const GANTT_ZOOM_OPTIONS: GanttZoom[] = ["day", "week", "month"];

const WorkflowBoard = lazy(() => import("./components/WorkflowBoard").then((module) => ({
  default: module.WorkflowBoard,
})));
const GanttView = lazy(() => import("./components/GanttView").then((module) => ({
  default: module.GanttView,
})));

interface EditorState {
  task: Task | null;
  status: TaskStatus;
}

interface ContextMenuState {
  taskId: string;
  x: number;
  y: number;
}

interface ProjectChoice {
  id: string;
  name: string;
  issueCount: number;
  inCodex: boolean;
  persisted: boolean;
}

interface UndoOperation {
  id: number;
  message: string;
  undo: () => Promise<void>;
}

interface UndoNotice {
  id: number;
  message: string;
}

type ColumnVisibilityByProject = Record<string, Partial<Record<TaskStatus, boolean>>>;
type ProjectAutomationStatus = "ACTIVE" | "PAUSED";
type AutomationQuotaState = "available" | "blocked" | "unknown" | "unavailable";
type AutomationIntervalMinutes = 5 | 10 | 15 | 30 | 60;

interface AutomationQuotaStatus {
  state: AutomationQuotaState;
  checkedAt: number;
  resetsAt?: number;
  reason?: "api-key";
}

interface ProjectAutomationRecord {
  automationId?: string;
  codexProjectId: string;
  /** 遗留字段：旧 Reasonix 心跳宿主记录（本地缓存仅用于兼容，不再使用）。 */
  host?: string;
  status: ProjectAutomationStatus;
  enabledByUser: boolean;
  quotaAware: boolean;
  quota?: AutomationQuotaStatus;
  intervalMinutes: AutomationIntervalMinutes;
  /** 认领模型：'' = 跟随 agent-default-model，否则为模型 id。 */
  model: string;
  reasoningEffort: AutomationReasoningEffort;
  /** 认领前置检查命令（'' = 未配置附加检查；内建统一检查始终开启）。 */
  checkCommand?: string;
}

type ProjectAutomations = Record<string, ProjectAutomationRecord>;

interface AutomationHostItem {
  id: string;
  status: ProjectAutomationStatus;
  model: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
  rrule: string;
}

interface AutomationHostResponse {
  requestId: string;
  ok: boolean;
  item?: AutomationHostItem;
  items?: AutomationHostItem[];
  quota?: AutomationQuotaStatus;
  policy?: {
    automationId?: string;
    enabledByUser: boolean;
    quotaAware: boolean;
    intervalMinutes: AutomationIntervalMinutes;
    model: AutomationModel;
    reasoningEffort: AutomationReasoningEffort;
  };
  error?: string;
}

interface PendingAutomationRequest {
  resolve: (response: AutomationHostResponse) => void;
  reject: (error: Error) => void;
  timeoutId: number;
}

const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

const LAST_PROJECT_KEY = "taskboard.lastProjectId";
const FAVORITE_PROJECTS_KEY = "taskboard.favoriteProjectIds";
const DEVICE_WORKSPACE_PATHS_KEY = "taskboard.deviceWorkspacePaths.v1";
const SHOW_EMPTY_COLUMNS_KEY = "taskboard.showEmptyColumns.v1";
const COLUMN_VISIBILITY_KEY = "taskboard.columnVisibility.v1";
const PROJECT_AUTOMATIONS_KEY = "taskboard.projectAutomations.v1";
/** DeepSeek Harness Web GUI 地址：dsh 心跳线程的"查看对话"指向其会话浏览页。 */
const DSH_WEB_URL = "http://127.0.0.1:3080";
const DEFAULT_AUTOMATION_OPTIONS = {
  enabledByUser: false,
  quotaAware: false,
  intervalMinutes: 5,
  model: "gpt-5.5",
  reasoningEffort: "high",
  checkCommand: "",
  host: "reasonix",
} as const;

/** Reasonix 心跳任务 id：与 server/heartbeat-automation.mjs 的 heartbeatTaskId 保持一致。 */
function heartbeatTaskIdFor(projectId: string): string {
  return `taskboard_claim_${projectId}`;
}

const EVENT_NAMES = [
  "task.created",
  "task.updated",
  "task.moved",
  "task.archived",
  "task.restored",
  "task.relation.updated",
  "comment.created",
  "comment.updated",
  "comment.deleted",
  "attachment.created",
  "attachment.deleted",
  "project.created",
  "workflow.updated",
] as const;

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

function getInitialTheme(): Theme {
  const fromQuery = getTaskboardLocation().searchParams.get("theme");
  if (isTheme(fromQuery)) return fromQuery;
  const stored = window.localStorage.getItem("taskboard.theme");
  if (isTheme(stored)) return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readFavoriteProjectIds(): Set<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(FAVORITE_PROJECTS_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function readDeviceWorkspacePaths(): Record<string, string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(DEVICE_WORKSPACE_PATHS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string" && entry[1].trim().length > 0
    )));
  } catch {
    return {};
  }
}

function readShowEmptyColumns(): boolean {
  return window.localStorage.getItem(SHOW_EMPTY_COLUMNS_KEY) === "true";
}

function readProjectAutomations(): ProjectAutomations {
  try {
    const value = JSON.parse(window.localStorage.getItem(PROJECT_AUTOMATIONS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: ProjectAutomations = {};
    for (const [projectId, record] of Object.entries(value)) {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      const candidate = record as Partial<ProjectAutomationRecord>;
      const model = candidate.model ?? "gpt-5.5";
      const reasoningEffort = candidate.reasoningEffort ?? "high";
      const enabledByUser = candidate.enabledByUser ?? candidate.status === "ACTIVE";
      const quotaAware = candidate.quotaAware ?? false;
      const host = candidate.host === "reasonix" || candidate.host === "dsh"
        ? candidate.host
        : "reasonix";
      if (
        (candidate.automationId !== undefined && typeof candidate.automationId !== "string")
        || typeof candidate.codexProjectId !== "string"
        || (candidate.status !== "ACTIVE" && candidate.status !== "PAUSED")
        || !isAutomationIntervalMinutes(candidate.intervalMinutes ?? 5)
        || !isAutomationModel(model)
        || !isAutomationReasoningEffort(reasoningEffort)
        || !isSupportedModelEffort(model, reasoningEffort)
        || (candidate.status === "ACTIVE" && !candidate.automationId)
        || typeof enabledByUser !== "boolean"
        || typeof quotaAware !== "boolean"
      ) continue;
      const quota = isAutomationQuotaStatus(candidate.quota) ? candidate.quota : undefined;
      result[projectId] = {
        automationId: candidate.automationId,
        codexProjectId: candidate.codexProjectId,
        host,
        status: candidate.status,
        enabledByUser,
        quotaAware,
        ...(quota ? { quota } : {}),
        intervalMinutes: candidate.intervalMinutes ?? 5,
        model,
        reasoningEffort,
      };
    }
    return result;
  } catch {
    return {};
  }
}

function isAutomationQuotaStatus(value: unknown): value is AutomationQuotaStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AutomationQuotaStatus>;
  return (
    (candidate.state === "available"
      || candidate.state === "blocked"
      || candidate.state === "unknown"
      || candidate.state === "unavailable")
    && Number.isFinite(candidate.checkedAt)
    && (candidate.resetsAt === undefined || Number.isFinite(candidate.resetsAt))
    && (candidate.reason === undefined || candidate.reason === "api-key")
  );
}

function isAutomationHostPolicy(
  value: AutomationHostResponse["policy"] | undefined,
): value is NonNullable<AutomationHostResponse["policy"]> {
  return Boolean(
    value
    && (value.automationId === undefined || typeof value.automationId === "string")
    && typeof value.enabledByUser === "boolean"
    && typeof value.quotaAware === "boolean"
    && isAutomationIntervalMinutes(value.intervalMinutes)
    && isAutomationModel(value.model)
    && isAutomationReasoningEffort(value.reasoningEffort)
    && isSupportedModelEffort(value.model, value.reasoningEffort),
  );
}

function isAutomationIntervalMinutes(value: unknown): value is AutomationIntervalMinutes {
  return value === 5 || value === 10 || value === 15 || value === 30 || value === 60;
}

function intervalMinutesFromRrule(value: string): AutomationIntervalMinutes | null {
  const match = /^RRULE:FREQ=MINUTELY;INTERVAL=(5|10|15|30|60)$/.exec(value);
  return match ? Number(match[1]) as AutomationIntervalMinutes : null;
}

function readColumnVisibilityByProject(): ColumnVisibilityByProject {
  try {
    const value = JSON.parse(window.localStorage.getItem(COLUMN_VISIBILITY_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: ColumnVisibilityByProject = {};
    for (const [projectId, visibilityValue] of Object.entries(value)) {
      if (!visibilityValue || typeof visibilityValue !== "object" || Array.isArray(visibilityValue)) continue;
      const visibility: Partial<Record<TaskStatus, boolean>> = {};
      for (const status of TASK_STATUSES) {
        const visible = (visibilityValue as Record<string, unknown>)[status];
        if (typeof visible === "boolean") visibility[status] = visible;
      }
      result[projectId] = visibility;
    }
    return result;
  } catch {
    return {};
  }
}

function workspaceName(path?: string): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong while loading your issues.";
}

function isAutomationHostItem(value: unknown): value is AutomationHostItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<AutomationHostItem>;
  return (
    typeof item.id === "string"
    && (item.status === "ACTIVE" || item.status === "PAUSED")
    && isAutomationModel(item.model)
    && isAutomationReasoningEffort(item.reasoningEffort)
    && isSupportedModelEffort(item.model, item.reasoningEffort)
    && typeof item.rrule === "string"
    && intervalMinutesFromRrule(item.rrule) !== null
  );
}

function isLocalTaskboardOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    return (protocol === "http:" || protocol === "https:")
      && (hostname === "127.0.0.1" || hostname === "localhost");
  } catch {
    return false;
  }
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt),
  );
}

function taskToDraft(task: Task): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    labels: task.labels,
    workflowId: task.workflowId,
    developmentContext: task.developmentContext,
    startDate: task.startDate,
    dueDate: task.dueDate,
    recurrence: task.recurrence,
  };
}

interface LocalRealtimeSyncProps {
  selectedProjectId: string;
  detailTaskId: string | null;
  refreshProjectList: () => Promise<void>;
  refreshTasks: (
    projectId: string,
    options?: { quiet?: boolean; signal?: AbortSignal },
  ) => Promise<void>;
  refreshWorkflowOptions: (projectId: string, signal?: AbortSignal) => Promise<void>;
  setConnection: Dispatch<SetStateAction<ConnectionState>>;
  setCommentsRevision: Dispatch<SetStateAction<number>>;
  setAttachmentsRevision: Dispatch<SetStateAction<number>>;
}

function LocalRealtimeSync({
  selectedProjectId,
  detailTaskId,
  refreshProjectList,
  refreshTasks,
  refreshWorkflowOptions,
  setConnection,
  setCommentsRevision,
  setAttachmentsRevision,
}: LocalRealtimeSyncProps) {
  useEffect(() => {
    const source = new EventSource(resolveTaskboardUrl("/api/events"));
    let refreshTimer: number | undefined;
    let refreshProjectsPending = false;
    let refreshTasksPending = false;

    const scheduleRefresh = (options: { projects?: boolean; tasks?: boolean }) => {
      refreshProjectsPending ||= options.projects === true;
      refreshTasksPending ||= options.tasks === true;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (refreshProjectsPending) void refreshProjectList();
        if (refreshTasksPending && selectedProjectId) {
          void refreshTasks(selectedProjectId, { quiet: true });
        }
        refreshProjectsPending = false;
        refreshTasksPending = false;
      }, 120);
    };

    const handleEvent = (event: Event) => {
      const message = event as MessageEvent<string>;
      let payload: { projectId?: string; taskId?: string } = {};
      try {
        payload = JSON.parse(message.data) as { projectId?: string; taskId?: string };
      } catch {
        // A malformed event should not interrupt later updates.
      }
      const affectsSelectedProject = Boolean(selectedProjectId)
        && (!payload.projectId || payload.projectId === selectedProjectId);
      if (event.type === "project.created") {
        scheduleRefresh({ projects: true });
        return;
      }
      if (event.type.startsWith("task.")) {
        scheduleRefresh({ projects: true, tasks: affectsSelectedProject });
        return;
      }
      if (!affectsSelectedProject) return;
      if (event.type === "workflow.updated") {
        if (selectedProjectId) void refreshWorkflowOptions(selectedProjectId);
        return;
      }
      if (event.type.startsWith("comment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setCommentsRevision((current) => current + 1);
        }
        scheduleRefresh({ tasks: true });
        return;
      }
      if (event.type.startsWith("attachment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setAttachmentsRevision((current) => current + 1);
          setCommentsRevision((current) => current + 1);
        }
      }
    };

    EVENT_NAMES.forEach((name) => source.addEventListener(name, handleEvent));
    source.onopen = () => {
      setConnection("live");
      scheduleRefresh({ projects: true, tasks: Boolean(selectedProjectId) });
      if (selectedProjectId) void refreshWorkflowOptions(selectedProjectId);
      if (detailTaskId) {
        setCommentsRevision((current) => current + 1);
        setAttachmentsRevision((current) => current + 1);
      }
    };
    source.onerror = () => setConnection("reconnecting");

    return () => {
      window.clearTimeout(refreshTimer);
      EVENT_NAMES.forEach((name) => source.removeEventListener(name, handleEvent));
      source.close();
    };
  }, [
    detailTaskId,
    refreshProjectList,
    refreshTasks,
    refreshWorkflowOptions,
    selectedProjectId,
    setAttachmentsRevision,
    setCommentsRevision,
    setConnection,
  ]);

  return null;
}

export function App() {
  const query = useMemo(() => new URLSearchParams(getTaskboardLocation().search), []);
  const embedded = query.get("host") === "codex";
  // host=dsh enables the parent-message protocol (theme sync etc.) while
  // keeping automation on the direct local API path.
  const hostMode = query.get("host");
  const hostMessaging = hostMode === "codex" || hostMode === "dsh";
  const undoShortcut = navigator.userAgent.includes("Macintosh") ? "⌘Z" : "Ctrl+Z";
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [hostContext, setHostContext] = useState<HostContext | null>(null);
  const language = resolveTaskboardLanguage(
    hostContext?.language ?? query.get("lang") ?? navigator.language,
  );
  const { locale, text } = getTaskboardI18n(language);
  const [developmentScan, setDevelopmentScan] = useState<DevelopmentScan>({ workspacePath: null, contexts: [] });
  const [developmentScanLoading, setDevelopmentScanLoading] = useState(false);
  const [manageTaskboardSkillPath, setManageTaskboardSkillPath] = useState("");
  const [taskboardMetadata, setTaskboardMetadata] = useState<TaskboardMetadata | null>(null);
  const [localAiChatAvailable, setLocalAiChatAvailable] = useState(false);
  const [aiThreads, setAiThreads] = useState<AiChatThread[]>([]);
  const [aiOpenThreadRequest, setAiOpenThreadRequest] = useState<AiChatOpenThreadRequest | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [hasLoadedTasks, setHasLoadedTasks] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(readTaskFilters);
  const [showEmptyColumns, setShowEmptyColumns] = useState(readShowEmptyColumns);
  const [columnVisibilityByProject, setColumnVisibilityByProject] = useState(readColumnVisibilityByProject);
  const [boardView, setBoardView] = useState<BoardView>("issues");
  const [ganttZoom, setGanttZoom] = useState<GanttZoom>("week");
  const [ganttHideCompleted, setGanttHideCompleted] = useState(false);
  const [ganttTodayRequest, setGanttTodayRequest] = useState(0);
  const [ganttViewMenuOpen, setGanttViewMenuOpen] = useState(false);
  const [processingNow, setProcessingNow] = useState(() => Date.now());
  const [restoringTaskId, setRestoringTaskId] = useState<string | null>(null);
  const [deletingArchivedTaskId, setDeletingArchivedTaskId] = useState<string | null>(null);
  const [pendingArchivedTaskDelete, setPendingArchivedTaskDelete] = useState<Task | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [detailTaskIdentifier, setDetailTaskIdentifier] = useState<string | null>(
    () => readIssueIdentifier(getTaskboardLocation().search),
  );
  const [commentsRevision, setCommentsRevision] = useState(0);
  const [attachmentsRevision, setAttachmentsRevision] = useState(0);
  const [workflowRevision, setWorkflowRevision] = useState(0);
  const [workflowOptions, setWorkflowOptions] = useState<WorkflowOption[]>(DEFAULT_WORKFLOW_OPTIONS);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [draggedTaskHeight, setDraggedTaskHeight] = useState(0);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);
  const [settlingTaskId, setSettlingTaskId] = useState<string | null>(null);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [openingThreadTaskId, setOpeningThreadTaskId] = useState<string | null>(null);
  const issueListRef = useRef<HTMLDivElement>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [favoriteProjectIds, setFavoriteProjectIds] = useState(readFavoriteProjectIds);
  const [deviceWorkspacePaths, setDeviceWorkspacePaths] = useState(readDeviceWorkspacePaths);
  const [projectAutomations, setProjectAutomations] = useState(readProjectAutomations);
  /** 认领模型目录：组合值 provider::model。 */
  const [claimModelChoices, setClaimModelChoices] = useState<string[]>([]);
  const [claimModelLabels, setClaimModelLabels] = useState<Record<string, string>>({});
  const [automationPending, setAutomationPending] = useState(false);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const [announcement, setAnnouncementValue] = useState("");
  const [undoNotice, setUndoNotice] = useState<UndoNotice | null>(null);
  const tasksRequestRef = useRef(0);
  const tasksRef = useRef<Task[]>([]);
  const undoSequenceRef = useRef(0);
  const undoStackRef = useRef<UndoOperation[]>([]);
  const undoInFlightRef = useRef(false);
  const dragRegionRef = useRef<HTMLDivElement>(null);
  const selectedProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;

  const revisionPollingInterval = getRevisionPollingInterval(taskboardMetadata);
  const pendingAutomationRequestsRef = useRef(new Map<string, PendingAutomationRequest>());
  const automationRequestInFlightRef = useRef(false);
  const projectAutomationsRef = useRef(projectAutomations);

  const setAnnouncement = useCallback((message: string) => {
    setUndoNotice(null);
    setAnnouncementValue(message);
  }, []);

  const rememberDeviceWorkspacePath = useCallback((projectId: string, workspacePath: string) => {
    const normalizedPath = workspacePath.trim();
    setDeviceWorkspacePaths((current) => {
      if (current[projectId] === normalizedPath || (!normalizedPath && !(projectId in current))) {
        return current;
      }
      const next = { ...current };
      if (normalizedPath) next[projectId] = normalizedPath;
      else delete next[projectId];
      window.localStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const currentUser = hostContext?.user ?? DEFAULT_USER_ACTOR;
  const selectedDeviceWorkspacePath = deviceWorkspacePaths[selectedProjectId];
  const selectedProjectAutomation = projectAutomations[selectedProjectId];
  const automationProjectContext = useMemo(() => {
    // Reasonix 独立模式（浏览器直接使用）：自动认领通过本地心跳任务实现，
    // workspacePath 取项目自身路径即可，菜单可用。
    if (!embedded || window.parent === window) {
      if (!selectedProject) return { unavailableReason: "请先选择项目" };
      const workspacePath = deviceWorkspacePaths[selectedProject.id]
        ?? selectedProject.workspacePath
        ?? null;
      if (!workspacePath) {
        return { unavailableReason: "该项目未设置本地目录，无法开启自动认领" };
      }
      return { workspacePath, codexProjectId: selectedProject.id, unavailableReason: null };
    }
    if (!isLocalTaskboardOrigin(window.location.origin)) {
      return { unavailableReason: "仅本地任务面板可用" };
    }
    if (!selectedProject) return { unavailableReason: "请先选择项目" };

    // ChatGPT cloud projects (`g-p-*`) are visible in the shared sidebar, but
    // Codex automations only accept local Codex project IDs. Treating a cloud
    // project as a direct match makes the native API reject the request (432).
    const isLocalCodexProject = (projectId: string) => !projectId.startsWith("g-p-");
    const directCodexProject = isLocalCodexProject(selectedProject.id)
      && hostContext?.projects?.some((project) => project.id === selectedProject.id);
    const workspacePath = deviceWorkspacePaths[selectedProject.id]
      ?? selectedProject.workspacePath
      ?? (
        directCodexProject && hostContext?.projectId === selectedProject.id
          ? hostContext.workspacePath
          : undefined
      );
    const codexProjectId = directCodexProject
      ? selectedProject.id
      : hostContext?.projects?.find(
        (project) => (
          isLocalCodexProject(project.id)
          && deviceWorkspacePaths[project.id] === workspacePath
        ),
      )?.id;

    if (!workspacePath || !codexProjectId) {
      return { unavailableReason: "请先在 Codex 中添加并映射该项目目录" };
    }
    if (!manageTaskboardSkillPath) {
      return { unavailableReason: "任务面板还没有读取到 Skill 路径" };
    }
    return { workspacePath, codexProjectId, unavailableReason: null };
  }, [
    deviceWorkspacePaths,
    embedded,
    hostContext,
    manageTaskboardSkillPath,
    selectedProject,
  ]);
  const detailTask = detailTaskIdentifier
    ? tasks.find((task) => task.identifier === detailTaskIdentifier) ?? null
    : null;
  const detailTaskId = detailTask?.id ?? null;
  const contextMenuTask = contextMenu
    ? tasks.find((task) => task.id === contextMenu.taskId) ?? null
    : null;
  const availableLabels = useMemo(
    () => [...new Set([
      ...DEFAULT_LABELS.map((label) => label.name),
      ...tasks.flatMap((task) => task.labels),
    ])],
    [tasks],
  );
  const projectChoices = useMemo<ProjectChoice[]>(() => {
    const persistedById = new Map(projects.map((project) => [project.id, project]));
    const seen = new Set<string>();
    const choices: ProjectChoice[] = [];
    for (const project of hostContext?.projects ?? []) {
      if (!project.id || !project.name || seen.has(project.id)) continue;
      seen.add(project.id);
      choices.push({
        id: project.id,
        name: persistedById.get(project.id)?.name ?? project.name,
        issueCount: persistedById.get(project.id)?.issueCount ?? 0,
        inCodex: true,
        persisted: persistedById.has(project.id),
      });
    }
    for (const project of projects) {
      if (seen.has(project.id)) continue;
      choices.push({
        id: project.id,
        name: project.name,
        issueCount: project.issueCount,
        inCodex: false,
        persisted: true,
      });
    }
    return choices.sort((left, right) => (
      Number(favoriteProjectIds.has(right.id)) - Number(favoriteProjectIds.has(left.id))
    ));
  }, [favoriteProjectIds, hostContext?.projects, projects]);
  const projectsWithIssues = useMemo(
    () => projectChoices.filter((project) => project.issueCount > 0),
    [projectChoices],
  );
  const projectsWithoutIssues = useMemo(
    () => projectChoices.filter((project) => project.issueCount === 0),
    [projectChoices],
  );
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const writeProjectAutomation = useCallback((
    projectId: string,
    record: ProjectAutomationRecord | null | undefined,
  ) => {
    setProjectAutomations((current) => {
      if (
        record
        && current[projectId]?.automationId === record.automationId
        && current[projectId]?.codexProjectId === record.codexProjectId
        && current[projectId]?.host === record.host
        && current[projectId]?.status === record.status
        && current[projectId]?.enabledByUser === record.enabledByUser
        && current[projectId]?.quotaAware === record.quotaAware
        && JSON.stringify(current[projectId]?.quota) === JSON.stringify(record.quota)
        && current[projectId]?.intervalMinutes === record.intervalMinutes
        && current[projectId]?.model === record.model
        && current[projectId]?.reasoningEffort === record.reasoningEffort
      ) {
        return current;
      }
      const next = { ...current };
      if (record) next[projectId] = record;
      else delete next[projectId];
      projectAutomationsRef.current = next;
      window.localStorage.setItem(PROJECT_AUTOMATIONS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const sendAutomationRequest = useCallback((
    operation: "ensure-active" | "pause" | "list" | "apply-policy",
    options: Pick<
      ProjectAutomationRecord,
      "enabledByUser" | "quotaAware" | "intervalMinutes" | "model" | "reasoningEffort"
    >,
    automationId?: string,
  ) => {
    if (
      !selectedProject
      || !automationProjectContext.codexProjectId
      || !automationProjectContext.workspacePath
    ) {
      return Promise.reject(new Error(
        automationProjectContext.unavailableReason ?? "无法读取项目自动化信息",
      ));
    }
    const requestId = window.crypto.randomUUID();
    const response = new Promise<AutomationHostResponse>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingAutomationRequestsRef.current.delete(requestId);
        reject(new Error("Codex 自动化没有响应，请稍后重试"));
      }, 10_000);
      pendingAutomationRequestsRef.current.set(requestId, { resolve, reject, timeoutId });
    });
    window.parent.postMessage({
      type: "taskboard:automation-request",
      payload: {
        requestId,
        operation,
        taskboardProjectId: selectedProjectId,
        codexProjectId: automationProjectContext.codexProjectId,
        projectName: selectedProject.name,
        workspacePath: automationProjectContext.workspacePath,
        skillPath: manageTaskboardSkillPath,
        ...(automationId ? { automationId } : {}),
        enabledByUser: options.enabledByUser,
        quotaAware: options.quotaAware,
        intervalMinutes: options.intervalMinutes,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      },
    }, "*");
    return response;
  }, [
    automationProjectContext,
    manageTaskboardSkillPath,
    selectedProject,
    selectedProjectId,
  ]);

  const reconcileProjectAutomation = useCallback(async () => {
    if (automationProjectContext.unavailableReason) {
      setAutomationError(null);
      return;
    }
    if (!selectedProjectId || !automationProjectContext.codexProjectId || automationRequestInFlightRef.current) return;
    // Reasonix 独立模式：从本地心跳任务读取状态
    if (!embedded || window.parent === window) {
      automationRequestInFlightRef.current = true;
      setAutomationPending(true);
      setAutomationError(null);
      try {
        const previous = projectAutomationsRef.current[selectedProjectId];
        const result = await getProjectAutomation(selectedProjectId);
        writeProjectAutomation(selectedProjectId, {
          automationId: heartbeatTaskIdFor(selectedProjectId),
          codexProjectId: selectedProjectId,
          status: result.enabled ? "ACTIVE" : "PAUSED",
          enabledByUser: result.enabled,
          quotaAware: previous?.quotaAware ?? false,
          intervalMinutes: isAutomationIntervalMinutes(result.intervalMinutes)
            ? result.intervalMinutes
            : previous?.intervalMinutes ?? DEFAULT_AUTOMATION_OPTIONS.intervalMinutes,
          model: result.model ?? previous?.model ?? "",
          reasoningEffort: previous?.reasoningEffort ?? DEFAULT_AUTOMATION_OPTIONS.reasoningEffort,
          checkCommand: result.checkCommand ?? previous?.checkCommand ?? "",
        });
      } catch (error) {
        setAutomationError(error instanceof Error ? error.message : "无法读取自动认领状态");
      } finally {
        automationRequestInFlightRef.current = false;
        setAutomationPending(false);
      }
      return;
    }
    const stored = projectAutomationsRef.current[selectedProjectId];
    automationRequestInFlightRef.current = true;
    setAutomationPending(true);
    setAutomationError(null);
    try {
      const options = stored ?? {
        status: "PAUSED" as const,
        ...DEFAULT_AUTOMATION_OPTIONS,
      };
      const response = await sendAutomationRequest(
        stored ? "apply-policy" : "list",
        options,
        stored?.automationId,
      );
      const items = Array.isArray(response.items)
        ? response.items.filter(isAutomationHostItem)
        : [];
      if (!stored) {
        const policy = isAutomationHostPolicy(response.policy) ? response.policy : null;
        if (!policy) return;
        const item = items.find((candidate) => candidate.id === policy.automationId)
          ?? (items.length === 1 ? items[0] : undefined);
        writeProjectAutomation(selectedProjectId, {
          automationId: item?.id ?? policy.automationId,
          codexProjectId: automationProjectContext.codexProjectId,
          status: item?.status ?? "PAUSED",
          enabledByUser: policy.enabledByUser,
          quotaAware: policy.quotaAware,
          intervalMinutes: policy.intervalMinutes,
          model: policy.model,
          reasoningEffort: policy.reasoningEffort,
        });
        return;
      }
      const item = (isAutomationHostItem(response.item) ? response.item : undefined)
        ?? items.find((item) => item.id === stored?.automationId)
        ?? (items.length === 1 ? items[0] : undefined);
      if (!item) {
        if (stored) {
          writeProjectAutomation(selectedProjectId, {
            ...stored,
            automationId: undefined,
            status: "PAUSED",
            ...(response.quota ? { quota: response.quota } : {}),
          });
        }
        return;
      }
      const intervalMinutes = intervalMinutesFromRrule(item.rrule);
      if (!intervalMinutes) return;
      writeProjectAutomation(selectedProjectId, {
        automationId: item.id,
        codexProjectId: automationProjectContext.codexProjectId,
        status: item.status,
        enabledByUser: stored.enabledByUser,
        quotaAware: stored.quotaAware,
        ...(response.quota ? { quota: response.quota } : {}),
        intervalMinutes,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
      });
    } catch (error) {
      setAutomationError(error instanceof Error ? error.message : "无法读取自动化状态");
    } finally {
      automationRequestInFlightRef.current = false;
      setAutomationPending(false);
    }
  }, [
    automationProjectContext,
    selectedProjectId,
    sendAutomationRequest,
    writeProjectAutomation,
  ]);

  const saveProjectAutomation = useCallback(async (options: {
    enabledByUser: boolean;
    quotaAware: boolean;
    intervalMinutes: AutomationIntervalMinutes;
    model: string;
    reasoningEffort: AutomationReasoningEffort;
    checkCommand: string;
  }) => {
    const stored = projectAutomations[selectedProjectId];
    if (
      !selectedProjectId
      || automationProjectContext.unavailableReason
      || !automationProjectContext.codexProjectId
      || automationRequestInFlightRef.current
    ) return;
    // DSH 原生模式：自动认领开关直接写看板数据库，由 claim-sweep 作业驱动。
    if (!embedded || window.parent === window) {
      if (automationRequestInFlightRef.current) return;
      automationRequestInFlightRef.current = true;
      setAutomationPending(true);
      setAutomationError(null);
      const previousRecord = stored;
      try {
        const result = await updateProjectAutomation(selectedProjectId, {
          enabled: options.enabledByUser,
          intervalMinutes: options.intervalMinutes,
          automationModel: options.model || null,
          checkCommand: options.checkCommand || null,
        });
        writeProjectAutomation(selectedProjectId, {
          automationId: heartbeatTaskIdFor(selectedProjectId),
          codexProjectId: selectedProjectId,
          status: result.enabled ? "ACTIVE" : "PAUSED",
          enabledByUser: result.enabled,
          quotaAware: false,
          intervalMinutes: isAutomationIntervalMinutes(result.intervalMinutes)
            ? result.intervalMinutes
            : options.intervalMinutes,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          checkCommand: result.checkCommand ?? options.checkCommand,
        });
      } catch (error) {
        writeProjectAutomation(selectedProjectId, previousRecord);
        setAutomationError(error instanceof Error ? error.message : "无法更新自动认领");
      } finally {
        automationRequestInFlightRef.current = false;
        setAutomationPending(false);
      }
      return;
    }
    const previousRecord = stored;
    automationRequestInFlightRef.current = true;
    setAutomationPending(true);
    setAutomationError(null);
    try {
      const response = await sendAutomationRequest("apply-policy", options, stored?.automationId);
      const item = isAutomationHostItem(response.item) ? response.item : undefined;
      writeProjectAutomation(selectedProjectId, {
        automationId: item?.id,
        codexProjectId: automationProjectContext.codexProjectId,
        status: item?.status ?? "PAUSED",
        enabledByUser: options.enabledByUser,
        quotaAware: options.quotaAware,
        ...(response.quota ? { quota: response.quota } : {}),
        intervalMinutes: options.intervalMinutes,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      });
    } catch (error) {
      writeProjectAutomation(selectedProjectId, previousRecord);
      setAutomationError(error instanceof Error ? error.message : "无法更新自动化");
    } finally {
      automationRequestInFlightRef.current = false;
      setAutomationPending(false);
    }
  }, [
    automationProjectContext,
    projectAutomations,
    selectedProjectId,
    sendAutomationRequest,
    writeProjectAutomation,
  ]);

  function openTaskDetail(task: Pick<Task, "identifier" | "projectId">) {
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(task.identifier);
    const currentIssue = readIssueIdentifier(getTaskboardLocation().search);
    const boardUrl = buildIssueUrl(getTaskboardLocation().href, task.projectId, null);
    if (!currentIssue) {
      taskboardReplaceState(window.history.state, boardUrl);
    }
    const detailUrl = buildIssueUrl(
      currentIssue ? getTaskboardLocation().href : boardUrl.href,
      task.projectId,
      task.identifier,
    );
    taskboardPushState(window.history.state, detailUrl);
  }

  function closeTaskDetail() {
    setDetailTaskIdentifier(null);
    const url = buildIssueUrl(getTaskboardLocation().href, selectedProjectId || null, null);
    taskboardReplaceState(window.history.state, url);
  }

  useEffect(() => {
    function syncRouteFromLocation() {
      const url = getTaskboardLocation();
      const routeProjectId = url.searchParams.get("project") ?? "";
      setDetailTaskIdentifier(readIssueIdentifier(url.search));
      if (routeProjectId === selectedProjectId) return;
      setBoardView("issues");
      setSelectedProjectId(routeProjectId);
      if (routeProjectId) window.localStorage.setItem(LAST_PROJECT_KEY, routeProjectId);
      else window.localStorage.removeItem(LAST_PROJECT_KEY);
    }

    window.addEventListener("popstate", syncRouteFromLocation);
    return () => window.removeEventListener("popstate", syncRouteFromLocation);
  }, [selectedProjectId]);

  useEffect(() => {
    const target = getThemeTarget();
    target.dataset.theme = theme;
    target.dataset.embedded = String(embedded);
    target.style.colorScheme = theme;
    publishTheme(theme);
    if (!embedded) window.localStorage.setItem("taskboard.theme", theme);
  }, [embedded, theme]);

  useEffect(() => onTaskboardThemeChange((next) => setTheme(next)), []);

  useEffect(() => {
    writeTaskFilters(filters);
  }, [filters]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    function closeProjectMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-project-switcher]")) setProjectMenuOpen(false);
    }
    function closeProjectMenuWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setProjectMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeProjectMenu);
    window.addEventListener("keydown", closeProjectMenuWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeProjectMenu);
      window.removeEventListener("keydown", closeProjectMenuWithEscape);
    };
  }, [projectMenuOpen]);

  useEffect(() => {
    setAutomationError(null);
    void reconcileProjectAutomation();
  }, [selectedProjectId, reconcileProjectAutomation]);

  useEffect(() => {
    if (!hostMessaging || window.parent === window) return;

    function receiveHostMessage(event: MessageEvent) {
      if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
      const message = event.data as { type?: string; payload?: unknown; theme?: unknown };

      if (message.type === "taskboard:automation-response" && message.payload) {
        const payload = message.payload as Partial<AutomationHostResponse>;
        if (typeof payload.requestId !== "string") return;
        const pending = pendingAutomationRequestsRef.current.get(payload.requestId);
        if (!pending) return;
        window.clearTimeout(pending.timeoutId);
        pendingAutomationRequestsRef.current.delete(payload.requestId);
        if (payload.ok) pending.resolve(payload as AutomationHostResponse);
        else pending.reject(new Error(
          typeof payload.error === "string" ? payload.error : "Codex 无法更新自动化",
        ));
        return;
      }

      if (message.type === "taskboard:theme" && isTheme(message.theme)) {
        setTheme(message.theme);
        return;
      }

      if (message.type === "taskboard:thread-prepared") {
        setOpeningThreadTaskId(null);
        return;
      }

      if (message.type === "taskboard:thread-create-error" && message.payload) {
        const payload = message.payload as { taskId?: unknown; error?: unknown };
        setOpeningThreadTaskId(null);
        setActionError(typeof payload.error === "string" ? payload.error : "无法在 Codex 中创建对话。");
        return;
      }

      if (message.type !== "taskboard:host-context" || !message.payload) return;
      const payload = message.payload as HostContext;
      setHostContext(payload);
      setCurrentUserActor(payload.user);
      if (isTheme(payload.theme)) setTheme(payload.theme);
    }

    window.addEventListener("message", receiveHostMessage);
    window.parent.postMessage({ type: "taskboard:ready" }, "*");
    return () => {
      window.removeEventListener("message", receiveHostMessage);
      for (const pending of pendingAutomationRequestsRef.current.values()) {
        window.clearTimeout(pending.timeoutId);
      }
      pendingAutomationRequestsRef.current.clear();
    };
  }, [hostMessaging]);

  useLayoutEffect(() => {
    if (!embedded || window.parent === window || !dragRegionRef.current) return;
    const region = dragRegionRef.current;
    const publish = () => {
      const rect = region.getBoundingClientRect();
      window.parent.postMessage({
        type: "taskboard:drag-region",
        payload: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }, "*");
    };
    const observer = new ResizeObserver(publish);
    observer.observe(region);
    window.addEventListener("resize", publish);
    publish();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publish);
      window.parent.postMessage({ type: "taskboard:drag-region", payload: null }, "*");
    };
  }, [detailTaskId, embedded, selectedProjectId]);

  const loadProjectList = useCallback(async (signal?: AbortSignal) => {
    setProjectsLoading(true);
    setLoadError(null);
    try {
      const [nextProjects, metadata, workspaces] = await Promise.all([
        listProjects(signal),
        getTaskboardMetadata(signal),
        listDeviceWorkspaces(signal),
      ]);
      setTaskboardMetadata((current) => (
        current
        && current.mode === metadata.mode
        && current.realtime?.transport === metadata.realtime?.transport
        && current.realtime?.intervalMs === metadata.realtime?.intervalMs
        && current.manageTaskboardSkillPath === metadata.manageTaskboardSkillPath
        && current.localCapabilities?.available === metadata.localCapabilities?.available
          ? current
          : metadata
      ));
      setManageTaskboardSkillPath(metadata.manageTaskboardSkillPath ?? "");
      setLocalAiChatAvailable(metadata.capabilities?.localAiChat === true);
      setDeviceWorkspacePaths((current) => {
        const next = { ...current, ...workspaces };
        if (JSON.stringify(next) === JSON.stringify(current)) return current;
        window.localStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
        return next;
      });
      setProjects(nextProjects);
      setSelectedProjectId((current) => {
        const fromQuery = getTaskboardLocation().searchParams.get("project");
        const remembered = window.localStorage.getItem(LAST_PROJECT_KEY);
        if (fromQuery && nextProjects.some((project) => project.id === fromQuery)) return fromQuery;
        if (current && nextProjects.some((project) => project.id === current)) return current;
        if (remembered && nextProjects.some((project) => project.id === remembered)) return remembered;
        return "";
      });
    } catch (error) {
      if ((error as Error).name !== "AbortError") setLoadError(errorMessage(error));
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadProjectList(controller.signal);
    return () => controller.abort();
  }, [loadProjectList]);

  const refreshProjectList = useCallback(async () => {
    try {
      setProjects(await listProjects());
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, []);

  const refreshTasks = useCallback(async (
    projectId: string,
    options: { quiet?: boolean; signal?: AbortSignal } = {},
  ) => {
    const requestId = ++tasksRequestRef.current;
    if (!options.quiet) setTasksLoading(true);
    setLoadError(null);
    try {
      const [nextTasks, nextArchivedTasks] = await Promise.all([
        listTasks(projectId, options.signal),
        listArchivedTasks(projectId, options.signal),
      ]);
      if (requestId !== tasksRequestRef.current) return;
      setTasks(sortTasks(nextTasks));
      setArchivedTasks(sortTasks(nextArchivedTasks));
      setHasLoadedTasks(true);
    } catch (error) {
      if ((error as Error).name !== "AbortError" && requestId === tasksRequestRef.current) {
        setLoadError(errorMessage(error));
      }
    } finally {
      if (!options.quiet && requestId === tasksRequestRef.current) setTasksLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setTasks([]);
      setArchivedTasks([]);
      setHasLoadedTasks(false);
      return;
    }
    setHasLoadedTasks(false);
    const controller = new AbortController();
    void refreshTasks(selectedProjectId, { signal: controller.signal });
    return () => controller.abort();
  }, [refreshTasks, selectedProjectId]);

  const refreshWorkflowOptions = useCallback(async (projectId: string, signal?: AbortSignal) => {
    const record = await getWorkflowWorkspace<unknown>(projectId, signal);
    if (!signal?.aborted) setWorkflowOptions(workflowOptionsFromWorkspace(record.workspace));
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setWorkflowOptions(DEFAULT_WORKFLOW_OPTIONS);
      return;
    }
    setWorkflowOptions(workflowOptionsFromWorkspace(readLegacyWorkflowWorkspace(selectedProjectId)));
    const controller = new AbortController();
    void refreshWorkflowOptions(selectedProjectId, controller.signal).catch((error) => {
      if ((error as Error).name !== "AbortError") {
        setWorkflowOptions(workflowOptionsFromWorkspace(readLegacyWorkflowWorkspace(selectedProjectId)));
      }
    });
    return () => controller.abort();
  }, [refreshWorkflowOptions, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setDevelopmentScan({ workspacePath: null, contexts: [] });
      return;
    }
    const controller = new AbortController();
    const codexProjectId = selectedProjectId === "local" ? hostContext?.projectId : selectedProjectId;
    const codexThreadId = hostContext?.threadId ?? detailTask?.threadId ?? undefined;
    setDevelopmentScan({ workspacePath: selectedDeviceWorkspacePath ?? null, contexts: [] });
    setDevelopmentScanLoading(true);
    void listDevelopmentContexts(
      selectedProjectId,
      codexProjectId,
      codexThreadId,
      controller.signal,
      selectedDeviceWorkspacePath,
    )
      .then((scan) => {
        setDevelopmentScan(scan);
        if (scan.workspacePath) rememberDeviceWorkspacePath(selectedProjectId, scan.workspacePath);
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") {
          setDevelopmentScan({ workspacePath: selectedDeviceWorkspacePath ?? null, contexts: [] });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDevelopmentScanLoading(false);
      });
    return () => controller.abort();
  }, [
    detailTask?.threadId,
    hostContext?.projectId,
    hostContext?.threadId,
    rememberDeviceWorkspacePath,
    selectedProjectId,
    selectedDeviceWorkspacePath,
  ]);

  useEffect(() => {
    if (revisionPollingInterval === null) return;
    const controller = new AbortController();
    setConnection("connecting");
    const poller = createRevisionPoller({
      intervalMs: revisionPollingInterval,
      fetchRevision: async (since: number) => {
        try {
          const result = await getTaskboardRevision(since, controller.signal);
          setConnection("live");
          return result;
        } catch (error) {
          if (!controller.signal.aborted) setConnection("reconnecting");
          throw error;
        }
      },
      onInvalidate: () => {
        void refreshProjectList();
        const projectId = selectedProjectIdRef.current;
        if (projectId) {
          void refreshTasks(projectId, { quiet: true });
          void refreshWorkflowOptions(projectId).catch(() => {});
        }
        setWorkflowRevision((current) => current + 1);
        setCommentsRevision((current) => current + 1);
        setAttachmentsRevision((current) => current + 1);
      },
    });
    poller.start();
    return () => {
      controller.abort();
      poller.stop();
    };
  }, [
    revisionPollingInterval,
    refreshProjectList,
    refreshTasks,
    refreshWorkflowOptions,
  ]);

  function pushUndo(message: string, undo: () => Promise<void>, showNotice = true) {
    const operation = { id: ++undoSequenceRef.current, message, undo };
    undoStackRef.current = [...undoStackRef.current.slice(-19), operation];
    setAnnouncementValue("");
    setUndoNotice(showNotice ? { id: operation.id, message } : null);
  }

  async function performUndo() {
    if (undoInFlightRef.current) return;
    const operation = undoStackRef.current.at(-1);
    if (!operation) return;
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    undoInFlightRef.current = true;
    setUndoNotice(null);
    setProjectMenuOpen(false);
    closeContextMenu();
    setActionError(null);
    try {
      await operation.undo();
    } catch (error) {
      setActionError(`无法撤回这次操作：${errorMessage(error)}`);
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    } finally {
      undoInFlightRef.current = false;
    }
  }

  async function restoreTaskDetails(
    snapshot: Task,
    changed: Task,
    assigneeTarget = assigneeTargetForActor(snapshot.assignee, currentUser),
  ) {
    const candidate = tasksRef.current.find((task) => task.id === changed.id);
    const current = candidate && candidate.version >= changed.version ? candidate : changed;
    const restored = await updateTaskRequest(current, {
      ...taskToDraft(snapshot),
      ...(assigneeTarget ? { assigneeTarget } : {}),
    });
    setTasks((tasks) => sortTasks(tasks.map((task) => task.id === restored.id ? restored : task)));
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches("input, textarea, select, [contenteditable='true']");
      if (
        event.key.toLowerCase() === "z"
        && (event.metaKey || event.ctrlKey)
        && !event.shiftKey
        && !isTyping
        && !editor
      ) {
        event.preventDefault();
        void performUndo();
        return;
      }
      if (isTyping || contextMenu || projectMenuOpen) return;
      if (
        event.key.toLowerCase() === "c"
        && !event.metaKey
        && !event.ctrlKey
        && selectedProjectId
        && boardView === "issues"
      ) {
        event.preventDefault();
        setEditor({ task: null, status: "backlog" });
      }
      if (event.key === "/" && !detailTaskId && selectedProjectId && boardView === "issues") {
        event.preventDefault();
        document.getElementById("task-search")?.focus();
      }
      if (event.key === "Escape" && detailTaskId) {
        closeTaskDetail();
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [boardView, contextMenu, detailTaskId, editor, projectMenuOpen, selectedProjectId]);

  const filteredTasks = useMemo(() => {
    return tasks.filter(
      (task) => matchesTaskSearch(task, search, language) && matchesTaskFilters(task, filters),
    );
  }, [filters, language, search, tasks]);

  const activeFilterCount = taskFilterCount(filters);
  const hasActiveTaskFilters = Boolean(search.trim()) || activeFilterCount > 0;

  const taskPresentations = useMemo(() => Object.fromEntries(tasks.map((task) => {
    const runningNativeThreadId = hostContext?.threadRunning
      ? hostContext.threadId ?? null
      : null;
    const taskThreadId = normalizeCodexThreadId(task.threadId);
    return [task.id, taskCardPresentation(
      task,
      aiThreads,
      false,
      runningNativeThreadId,
      hostContext?.threadTodoProgress ?? null,
      taskThreadId ? null : undefined,
    )];
  })) as Record<string, TaskCardPresentation>, [
    aiThreads,
    hostContext?.threadId,
    hostContext?.threadRunning,
    hostContext?.threadTodoProgress,
    tasks,
  ]);

  const hasRunningTask = useMemo(
    () => Object.values(taskPresentations).some((presentation) => presentation.processing.running),
    [taskPresentations],
  );

  useEffect(() => {
    setProcessingNow(Date.now());
    if (!hasRunningTask) return;
    const timer = window.setInterval(() => setProcessingNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasRunningTask]);

  const tasksByStatus = useMemo(() => {
    return Object.fromEntries(
      TASK_STATUSES.map((status) => [status, filteredTasks.filter((task) => task.status === status)]),
    ) as Record<TaskStatus, Task[]>;
  }, [filteredTasks]);

  const columnVisibility = columnVisibilityByProject[selectedProjectId];

  const visibleStatuses = useMemo(
    () => TASK_STATUSES.filter((status) => (
      tasksByStatus[status].length === 0
        ? showEmptyColumns
        : (columnVisibility?.[status] ?? true)
    )),
    [columnVisibility, showEmptyColumns, tasksByStatus],
  );

  const hiddenStatuses = useMemo(
    () => TASK_STATUSES.filter((status) => (
      tasksByStatus[status].length === 0
        ? !showEmptyColumns
        : !(columnVisibility?.[status] ?? true)
    )),
    [columnVisibility, showEmptyColumns, tasksByStatus],
  );

  function updateShowEmptyColumns(show: boolean) {
    window.localStorage.setItem(SHOW_EMPTY_COLUMNS_KEY, String(show));
    setShowEmptyColumns(show);
  }

  function updateColumnVisibility(status: TaskStatus, visible: boolean) {
    if (!selectedProjectId || tasksByStatus[status].length === 0) return;
    setColumnVisibilityByProject((current) => {
      const next = {
        ...current,
        [selectedProjectId]: {
          ...current[selectedProjectId],
          [status]: visible,
        },
      };
      window.localStorage.setItem(COLUMN_VISIBILITY_KEY, JSON.stringify(next));
      return next;
    });
  }

  function selectBoardView(view: BoardView) {
    closeContextMenu();
    setGanttViewMenuOpen(false);
    setBoardView(view);
  }

  async function saveEditor(
    draft: TaskDraft,
    attachments: File[],
    inlineImages: PendingInlineImage[],
  ) {
    if (!selectedProjectId || !editor) return;
    setActionError(null);
    try {
      const creating = editor.task === null;
      let saved = editor.task
        ? await updateTaskRequest(editor.task, draft)
        : await createTaskRequest(selectedProjectId, draft);
      if (creating) {
        setProjects((current) => current.map((project) => (
          project.id === selectedProjectId
            ? { ...project, issueCount: project.issueCount + 1 }
            : project
        )));
      }
      let uploadedAttachments = 0;
      let failedAttachments = 0;
      if (creating && (attachments.length > 0 || inlineImages.length > 0)) {
        const [results, inlineAttachments] = await Promise.all([
          Promise.allSettled(
            attachments.map((file) => uploadAttachment(saved.id, file)),
          ),
          Promise.all(
            inlineImages.map((image) => uploadAttachment(saved.id, image.file)),
          ),
        ]);
        uploadedAttachments = results.filter((result) => result.status === "fulfilled").length;
        failedAttachments = results.length - uploadedAttachments;
        if (inlineImages.length > 0) {
          const description = resolveInlineMediaMarkdown(
            draft.description,
            inlineImages,
            inlineAttachments,
          );
          saved = await updateTaskRequest(saved, { ...draft, description });
        }
      }
      setTasks((current) => sortTasks([
        ...current.filter((task) => task.id !== saved.id),
        saved,
      ]));
      setEditor(null);
      if (failedAttachments > 0) {
        setActionError(`${saved.identifier} 已创建，但有 ${failedAttachments} 个附件上传失败，可在详情页重试。`);
      }
      if (creating) {
        const totalUploaded = uploadedAttachments + inlineImages.length;
        const message = `${saved.identifier} 已创建${totalUploaded > 0 ? `，已上传 ${totalUploaded} 个附件` : ""}。`;
        pushUndo(message, async () => {
          const candidate = tasksRef.current.find((task) => task.id === saved.id);
          const current = candidate && candidate.version >= saved.version ? candidate : saved;
          await archiveTaskRequest(current);
          setTasks((tasks) => tasks.filter((task) => task.id !== saved.id));
        });
      } else if (editor.task) {
        const previous = editor.task;
        const previousAssigneeTarget = assigneeTargetForActor(previous.assignee, currentUser);
        if (!draft.assigneeTarget || previousAssigneeTarget) {
          pushUndo(
            `${saved.identifier} 已更新。`,
            () => restoreTaskDetails(previous, saved, previousAssigneeTarget),
          );
        }
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        void refreshTasks(selectedProjectId, { quiet: true });
      }
      throw error;
    }
  }

  async function moveTask(
    task: Task,
    status: TaskStatus,
    beforeTaskId: string | null = null,
    silent = false,
  ) {
    if (movingTaskId) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
      return;
    }

    const destination = tasks.filter((candidate) => candidate.status === status && candidate.id !== task.id);
    const insertionIndex = beforeTaskId
      ? destination.findIndex((candidate) => candidate.id === beforeTaskId)
      : destination.length;
    const targetIndex = insertionIndex < 0 ? destination.length : insertionIndex;
    const desiredOrder = [...destination];
    desiredOrder.splice(targetIndex, 0, task);
    const currentOrder = tasks.filter((candidate) => candidate.status === status);
    if (
      task.status === status
      && currentOrder.length === desiredOrder.length
      && currentOrder.every((candidate, index) => candidate.id === desiredOrder[index].id)
    ) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
      return;
    }
    const previousTask = destination[targetIndex - 1] ?? null;
    const nextTask = destination[targetIndex] ?? null;
    const sortOrder = previousTask && nextTask
      ? (previousTask.sortOrder + nextTask.sortOrder) / 2
      : previousTask
        ? previousTask.sortOrder + 1024
        : nextTask
          ? nextTask.sortOrder - 1024
          : 1024;
    const previous = task;
    setActionError(null);
    setMovingTaskId(task.id);
    setTasks((current) => sortTasks(current.map((candidate) =>
      candidate.id === task.id ? { ...candidate, status, sortOrder } : candidate,
    )));

    try {
      const moved = await moveTaskRequest(task, status, sortOrder);
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === moved.id ? moved : candidate,
      )));
      const message = task.status === status
        ? `${task.identifier} 排序已调整。`
        : `${task.identifier} 已移至${STATUS_DETAILS[status].label}。`;
      pushUndo(message, async () => {
        const candidate = tasksRef.current.find((current) => current.id === moved.id);
        const current = candidate && candidate.version >= moved.version ? candidate : moved;
        const restored = await moveTaskRequest(current, previous.status, previous.sortOrder);
        setTasks((tasks) => sortTasks(tasks.map((item) => item.id === restored.id ? restored : item)));
      }, !silent);
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "That issue changed elsewhere. The board has been refreshed."
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    } finally {
      setMovingTaskId(null);
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
    }
  }

  function finishTaskDrop(destination: TaskStatus, taskId: string, beforeTaskId: string | null = null) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    setDraggedTaskId(null);
    setDraggedTaskHeight(0);
    setDropTarget(null);
    if (!task) return;
    setSettlingTaskId(task.id);
    window.setTimeout(() => {
      setSettlingTaskId((current) => current === task.id ? null : current);
    }, 220);
    void moveTask(task, destination, beforeTaskId, true);
  }

  async function updateTaskProperties(task: Task, changes: Partial<TaskDraft>, message?: string): Promise<Task> {
    const previous = task;
    const { assigneeTarget, ...taskChanges } = changes;
    const optimisticAssignee = assigneeTarget
      ? actorForAssigneeTarget(assigneeTarget, currentUser)
      : task.assignee;
    setActionError(null);
    setTasks((current) => current.map((candidate) =>
      candidate.id === task.id
        ? { ...candidate, ...taskChanges, assignee: optimisticAssignee }
        : candidate,
    ));

    try {
      const updated = await updateTaskRequest(task, { ...taskToDraft(task), ...changes });
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      )));
      const previousAssigneeTarget = assigneeTargetForActor(previous.assignee, currentUser);
      if (!assigneeTarget || previousAssigneeTarget) {
        pushUndo(
          message ?? `${task.identifier} 已更新。`,
          () => restoreTaskDetails(previous, updated, previousAssigneeTarget),
        );
      }
      return updated;
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      throw error;
    }
  }

  async function mutateTaskRelation(
    action: "add" | "remove",
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
  ) {
    setActionError(null);
    try {
      const result = action === "add"
        ? await addTaskRelation(task, type, relatedTaskId)
        : await removeTaskRelation(task, type, relatedTaskId);
      setTasks((current) => sortTasks(current.map((candidate) => {
        if (candidate.id === result.task.id) return result.task;
        if (candidate.id === result.relatedTask.id) return result.relatedTask;
        return candidate;
      })));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      return result;
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      throw error;
    }
  }

  async function duplicateTask(task: Task) {
    setActionError(null);
    try {
      const duplicated = await createTaskRequest(task.projectId, {
        ...taskToDraft(task),
        assigneeTarget: assigneeTargetForActor(task.assignee, currentUser),
        developmentContext: null,
      });
      setTasks((current) => sortTasks([...current, duplicated]));
      pushUndo(`${duplicated.identifier} 副本已创建。`, async () => {
        const candidate = tasksRef.current.find((current) => current.id === duplicated.id);
        const current = candidate && candidate.version >= duplicated.version ? candidate : duplicated;
        await archiveTaskRequest(current);
        setTasks((tasks) => tasks.filter((item) => item.id !== duplicated.id));
      });
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function archiveTask(task: Task) {
    setActionError(null);
    try {
      const archived = await archiveTaskRequest(task);
      setTasks((current) => current.filter((candidate) => candidate.id !== task.id));
      setArchivedTasks((current) => sortTasks([
        ...current.filter((candidate) => candidate.id !== archived.id),
        archived,
      ]));
      pushUndo(`${task.identifier} 已归档。`, async () => {
        const restored = await restoreTaskRequest(archived);
        setArchivedTasks((current) => current.filter((candidate) => candidate.id !== restored.id));
        setTasks((current) => sortTasks([
          ...current.filter((candidate) => candidate.id !== restored.id),
          restored,
        ]));
      });
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    }
  }

  async function restoreArchivedTask(task: Task) {
    setActionError(null);
    setRestoringTaskId(task.id);
    try {
      const restored = await restoreTaskRequest(task);
      setArchivedTasks((current) => current.filter((candidate) => candidate.id !== restored.id));
      setTasks((current) => sortTasks([
        ...current.filter((candidate) => candidate.id !== restored.id),
        restored,
      ]));
      setAnnouncement(`${restored.identifier} 已恢复。`);
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    } finally {
      setRestoringTaskId(null);
    }
  }

  async function deleteArchivedTask(task: Task) {
    setActionError(null);
    setDeletingArchivedTaskId(task.id);
    try {
      await deleteArchivedTaskRequest(task);
      setArchivedTasks((current) => current.filter((candidate) => candidate.id !== task.id));
      setPendingArchivedTaskDelete(null);
      setAnnouncement(`${task.identifier} 已永久删除。`);
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    } finally {
      setDeletingArchivedTaskId(null);
    }
  }

  async function copyText(text: string, message: string) {
    try {
      await navigator.clipboard.writeText(text);
      setAnnouncement(message);
    } catch {
      setActionError("无法写入剪贴板。");
    }
  }

  function openThread(threadId: string) {
    const trimmed = threadId.trim();
    // 早期共享线程 id（心跳机制升级前所有 dsh 认领共用）没有对应独立会话，
    // 回退到 dsh 会话浏览页。
    if (trimmed === "dsh-heartbeat") {
      window.open(`${DSH_WEB_URL}/sessions`, "_blank", "noopener,noreferrer");
      setAnnouncement(`${trimmed} 为早期共享线程 id，无对应独立会话，已打开 dsh 会话页。`);
      return;
    }
    // dsh 心跳线程由 DeepSeek Harness 执行，Reasonix 中无对应对话：
    // headless 会话 id 与线程 id 一致（runner 每次运行生成 dsh-<uuid> 并注入
    // DSH_SESSION_ID），因此用 ?session= 深链直达该次执行的真实会话。
    if (isDshThreadId(trimmed)) {
      // 宿主（codex/dsh）内嵌时交给宿主在当前页面内切换会话，不新开页面；
      // 独立模式回退到 dsh 深链新标签。
      if (hostMessaging && window.parent !== window) {
        window.parent.postMessage({
          type: "taskboard:open-thread",
          payload: { threadId: trimmed },
        }, "*");
        setAnnouncement(`已切换到 DeepSeek Harness 会话 ${trimmed}。`);
        return;
      }
      window.open(`${DSH_WEB_URL}/?session=${encodeURIComponent(trimmed)}`, "_blank", "noopener,noreferrer");
      setAnnouncement(`${trimmed} 由 DeepSeek Harness 执行，已打开对应会话。`);
      return;
    }

    if (embedded && window.parent !== window) {
      window.parent.postMessage({ type: "taskboard:open-thread", payload: { threadId: trimmed } }, "*");
      return;
    }

    window.location.assign(`reasonix://threads/${encodeURIComponent(trimmed)}`);
  }

  function openTaskConversation(conversation: TaskConversationItem) {
    if (conversation.kind === "local-ai" && conversation.aiThreadId) {
      setAiOpenThreadRequest((current) => ({
        threadId: conversation.aiThreadId!,
        requestId: (current?.requestId ?? 0) + 1,
      }));
      return;
    }
    if (conversation.nativeThreadId) openThread(conversation.nativeThreadId);
  }

  function expandCodexSidebar() {
    if (!embedded || window.parent === window) return;
    window.parent.postMessage({ type: "taskboard:expand-sidebar" }, "*");
  }

  function openTaskInThread(task: Task) {
    const threadId = task.threadId?.trim() ?? "";
    // dsh 心跳线程：直接打开该次执行的 dsh 会话，而不是在 Reasonix 新建对话。
    if (isDshThreadId(threadId)) {
      // 宿主（codex/dsh）内嵌时交给宿主在当前页面内切换会话，不新开页面；
      // 独立模式回退到 dsh 深链新标签。
      if (hostMessaging && window.parent !== window) {
        window.parent.postMessage({
          type: "taskboard:open-thread",
          payload: { threadId },
        }, "*");
        setAnnouncement(`已切换到 DeepSeek Harness 会话 ${threadId}。`);
        return;
      }
      window.open(`${DSH_WEB_URL}/?session=${encodeURIComponent(threadId)}`, "_blank", "noopener,noreferrer");
      setAnnouncement(`已打开 DeepSeek Harness 会话 ${threadId}。`);
      return;
    }
    if (!manageTaskboardSkillPath) {
      setActionError("任务面板还没有读取到 manage-taskboard Skill 路径，请刷新后重试。");
      return;
    }
    const worktreePath = task.developmentContext?.type === "worktree"
      ? task.developmentContext.path
      : null;
    const workspacePath = worktreePath
      ?? selectedDeviceWorkspacePath
      ?? developmentScan.workspacePath
      ?? hostContext?.workspacePath;
    const instruction = `e-taskboard Addressing the issues mentioned in ${task.identifier}`;
    const prompt = `[$manage-taskboard](${manageTaskboardSkillPath}) ${instruction}`;

    if (!embedded || window.parent === window) {
      // host=dsh：在同一 GUI 内驱动真实 DSH 会话（由插件宿主监听执行），
      // 而不是跳转到 Reasonix 新建对话。
      if (hostMessaging) {
        window.parent.postMessage({
          type: "taskboard:dsh-execute",
          payload: {
            taskId: task.id,
            identifier: task.identifier,
            prompt,
            workspacePath,
            projectId: selectedProject?.id ?? null,
          },
        }, "*");
        setAnnouncement("已发送给 DeepSeek Harness 执行，切换到了对应会话。");
        return;
      }
      const query = new URLSearchParams();
      if (workspacePath) query.set("path", workspacePath);
      query.set("prompt", prompt);
      window.location.assign(`reasonix://new?${query.toString().replace(/\+/g, "%20")}`);
      return;
    }
    if (openingThreadTaskId) return;
    const codexProject = hostContext?.projects?.find((project) => project.id === selectedProject?.id);
    setOpeningThreadTaskId(task.id);
    setActionError(null);
    window.parent.postMessage({
      type: "taskboard:create-thread",
      payload: {
        taskId: task.id,
        identifier: task.identifier,
        instruction,
        skillName: "manage-taskboard",
        skillDisplayName: "Manage Taskboard",
        skillPath: manageTaskboardSkillPath,
        codexProjectId: codexProject?.id ?? (selectedProject?.id === "local" ? hostContext?.projectId : selectedProject?.id),
        projectName: selectedProject?.name,
        workspacePath,
        workspaceLabel: worktreePath ? workspaceName(worktreePath) : undefined,
      },
    }, "*");
  }

  function changeProject(projectId: string) {
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(null);
    setBoardView("issues");
    setSelectedProjectId(projectId);
    window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
    setSearch("");
    setFilters(EMPTY_TASK_FILTERS);
    setActionError(null);
    undoStackRef.current = [];
    setUndoNotice(null);
    const url = buildIssueUrl(getTaskboardLocation().href, projectId, null);
    taskboardReplaceState(null, url);
  }

  function returnToProjectHome() {
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(null);
    setSelectedProjectId("");
    window.localStorage.removeItem(LAST_PROJECT_KEY);
    setSearch("");
    setFilters(EMPTY_TASK_FILTERS);
    setActionError(null);
    undoStackRef.current = [];
    setUndoNotice(null);
    const url = buildIssueUrl(getTaskboardLocation().href, null, null);
    taskboardReplaceState(null, url);
    void loadProjectList();
  }

  function toggleFavoriteProject() {
    if (!selectedProjectId) return;
    const shouldFavorite = !favoriteProjectIds.has(selectedProjectId);
    setFavoriteProjectIds((current) => {
      const next = new Set(current);
      if (shouldFavorite) next.add(selectedProjectId);
      else next.delete(selectedProjectId);
      window.localStorage.setItem(FAVORITE_PROJECTS_KEY, JSON.stringify([...next]));
      return next;
    });
    setAnnouncement(`${selectedProject?.name ?? "项目"}${shouldFavorite ? "已收藏。" : "已取消收藏。"}`);
  }

  async function selectProject(choice: ProjectChoice) {
    if (openingProjectId) return;
    setOpeningProjectId(choice.id);
    setActionError(null);
    try {
      let project = projects.find((candidate) => candidate.id === choice.id) ?? null;
      if (!project) {
        // Projects mirror DSH workspaces (the host half syncs them); never
        // create a standalone project here. A missing row means the sync
        // hasn't caught up yet — refresh and retry.
        const nextProjects = await listProjects();
        setProjects(nextProjects);
        project = nextProjects.find((candidate) => candidate.id === choice.id) ?? null;
        if (!project) {
          setAnnouncement("项目尚未同步：请先在 DSH 中打开该目录（注册为工作区），看板会自动跟随。");
          return;
        }
      }
      changeProject(project.id);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOpeningProjectId(null);
    }
  }

  const contextName = workspaceName(hostContext?.workspacePath);
  const headerProjectName = selectedProject?.name ?? "任务面板";
  const appShellStyle = embedded
    ? { "--codex-titlebar-left-inset": `${hostContext?.titlebarLeftInset ?? 0}px` } as CSSProperties
    : undefined;

  return (
    <TaskboardLanguageProvider language={language}>
    <div className={`app-shell${embedded ? " embedded" : ""}`} style={appShellStyle}>
      {taskboardMetadata && taskboardMetadata.mode !== "cloud" && (
        <LocalRealtimeSync
          selectedProjectId={selectedProjectId}
          detailTaskId={detailTaskId}
          refreshProjectList={refreshProjectList}
          refreshTasks={refreshTasks}
          refreshWorkflowOptions={refreshWorkflowOptions}
          setConnection={setConnection}
          setCommentsRevision={setCommentsRevision}
          setAttachmentsRevision={setAttachmentsRevision}
        />
      )}
      {!embedded && (
        <aside className="app-nav" aria-label="Taskboard navigation">
          <div className="brand-row">
            <span className="brand-mark" aria-hidden="true"><LinearIcon name="project" /></span>
            <span>任务面板</span>
          </div>

          <nav className="primary-nav" aria-label="Views">
            <span className="nav-label">工作区</span>
            <button className="nav-item active" type="button" aria-current="page">
              <span className="nav-glyph" aria-hidden="true">
                <LinearIcon name="myIssues" />
              </span>
              议题
              <span className="nav-count">{tasks.length}</span>
            </button>
          </nav>

          <div className="project-nav">
            <span className="nav-label">项目</span>
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                className={`project-nav-item${selectedProjectId === project.id ? " active" : ""}`}
                onClick={() => changeProject(project.id)}
              >
                <span className="project-dot" aria-hidden="true" />
                <span>{project.name}</span>
              </button>
            ))}
          </div>

          <div className="nav-spacer" />
          <div className="nav-footer">
            <div className={`connection connection-${connection}`}>
              <span aria-hidden="true" />
              {connection === "live" ? "实时同步" : "正在重新连接…"}
            </div>
            <button
              type="button"
              className="theme-toggle"
              onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            >
              <span aria-hidden="true"><LinearIcon name={theme === "dark" ? "sun" : "moon"} /></span>
              <span className="theme-toggle-label">{theme === "dark" ? "浅色模式" : "深色模式"}</span>
            </button>
          </div>
        </aside>
      )}

      <main className="workspace">
        {selectedProjectId ? (
          <header className="workspace-header">
          <div className="workspace-title">
            <div className="workspace-kicker">
              {detailTask && (
                <button
                  className="detail-back-button"
                  type="button"
                  aria-label="返回议题看板"
                  title="返回议题看板 (Esc)"
                  onClick={closeTaskDetail}
                >
                  <LinearIcon name="chevronLeft" />
                </button>
              )}
              {embedded && hostContext?.sidebarCollapsed && (
                <button
                  className="detail-back-button codex-sidebar-expand-button"
                  type="button"
                  aria-label="展开 Codex 侧边栏"
                  title="展开侧边栏"
                  onClick={expandCodexSidebar}
                >
                  <LinearIcon name="codexSidebarExpand" />
                </button>
              )}
              {selectedProjectId && (
                <button
                  className="detail-back-button project-home-button"
                  type="button"
                  aria-label="返回项目首页"
                  title="返回项目首页"
                  onClick={returnToProjectHome}
                >
                  <LinearIcon name="home" />
                  <span>首页</span>
                </button>
              )}
              {selectedProjectId && <span className="breadcrumb-chevron" aria-hidden="true"><LinearIcon name="chevronRight" /></span>}
              {selectedProjectId ? (
                <div className="header-project-switcher" data-project-switcher>
                  <button
                    className="header-project-button"
                    type="button"
                    aria-label="切换项目"
                    aria-haspopup="menu"
                    aria-expanded={projectMenuOpen}
                    onClick={() => setProjectMenuOpen((current) => !current)}
                  >
                    <span className="project-avatar" aria-hidden="true">
                      {headerProjectName.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="project-name">{headerProjectName}</span>
                    <LinearIcon className="project-switcher-chevron" name="chevronDown" />
                  </button>
                  {projectMenuOpen && (
                    <div className="header-project-menu" role="menu" aria-label="项目">
                      <span>切换项目</span>
                      {projectChoices.map((project) => (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={project.id === selectedProjectId}
                          disabled={openingProjectId !== null}
                          key={project.id}
                          onClick={() => {
                            if (project.id === selectedProjectId) setProjectMenuOpen(false);
                            else void selectProject(project);
                          }}
                        >
                          <span className="project-avatar" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
                          <span>{project.name}</span>
                          {favoriteProjectIds.has(project.id) && <span className="project-menu-favorite" aria-label="已收藏"><LinearIcon name="favorite" /></span>}
                          {project.id === selectedProjectId && <span className="project-menu-check" aria-hidden="true"><LinearIcon name="check" /></span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <span className="project-avatar" aria-hidden="true">
                    {headerProjectName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="project-name">{headerProjectName}</span>
                </>
              )}
              {!selectedProjectId && (
                <>
                  <span className="breadcrumb-chevron" aria-hidden="true"><LinearIcon name="chevronRight" /></span>
                  <strong>项目</strong>
                </>
              )}
              {!detailTask && selectedProjectId && (
                <button
                  className={`favorite-button${favoriteProjectIds.has(selectedProjectId) ? " active" : ""}`}
                  type="button"
                  aria-label={favoriteProjectIds.has(selectedProjectId) ? "取消收藏项目" : "收藏项目"}
                  aria-pressed={favoriteProjectIds.has(selectedProjectId)}
                  title={favoriteProjectIds.has(selectedProjectId) ? "取消收藏" : "收藏项目"}
                  onClick={toggleFavoriteProject}
                >
                  <LinearIcon className="favorite-icon" name="favorite" />
                </button>
              )}
              {!detailTask && selectedProjectId && embedded && contextName && <span className="codex-context">{contextName}</span>}
            </div>
          </div>

          <div ref={dragRegionRef} className="workspace-drag-region" aria-hidden="true" />

          <div className="header-actions">
            {selectedProjectId && (
              <ProjectAutomationMenu
                automation={selectedProjectAutomation}
                models={claimModelChoices}
                modelLabels={claimModelLabels}
                pending={automationPending}
                error={automationError}
                unavailableReason={automationProjectContext.unavailableReason}
                onOpen={() => {
                  void reconcileProjectAutomation();
                  void getClaimModels().then((catalog) => {
                    setClaimModelChoices(catalog.providers.flatMap((entry) =>
                      entry.models.map((model) => `${entry.provider}::${model}`),
                    ));
                    setClaimModelLabels(Object.fromEntries(
                      catalog.providers.map((entry) => [entry.provider, entry.label ?? entry.provider]),
                    ));
                  }).catch(() => {});
                }}
                onChange={(options) => void saveProjectAutomation(options)}
              />
            )}
            {selectedProjectId && boardView !== "workflow" && (
              <button
                className="icon-button header-create-button"
                type="button"
                onClick={() => setEditor({ task: null, status: "backlog" })}
                aria-label={text("新建议题", "Create issue")}
                title={text("新建议题 (C)", "Create issue (C)")}
              >
                <TaskboardIcon name="create" />
              </button>
            )}
          </div>
          </header>
        ) : (
          <div ref={dragRegionRef} className="home-window-drag-region" aria-hidden="true" />
        )}

        {selectedProjectId && !detailTask && <div className="board-toolbar">
          <div className="view-tabs" aria-label="看板视图">
            <button
              className={`view-tab${boardView === "dashboard" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "dashboard"}
              onClick={() => selectBoardView("dashboard")}
            >
              {text("仪表盘", "Dashboard")}
            </button>
            <button
              className={`view-tab${boardView === "issues" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "issues"}
              onClick={() => selectBoardView("issues")}
            >
              {text("议题看板", "Issue board")}
            </button>
            <button
              className={`view-tab${boardView === "list" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "list"}
              onClick={() => selectBoardView("list")}
            >
              {text("列表视图", "List")}
            </button>
            <button
              className={`view-tab${boardView === "gantt" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "gantt"}
              onClick={() => selectBoardView("gantt")}
            >
              {text("甘特图", "Gantt")}
            </button>
            {SHOW_WORKFLOW_BOARD_ENTRY && (
              <button
                className={`view-tab${boardView === "workflow" ? " active" : ""}`}
                type="button"
                aria-pressed={boardView === "workflow"}
                onClick={() => selectBoardView("workflow")}
              >
                {text("节点模式", "Workflow")}
              </button>
            )}
          </div>
          {(boardView === "issues" || boardView === "list" || boardView === "gantt") && <div className="toolbar-tools">
            <label className={`search-field${search ? " has-value" : ""}`} title={text("搜索议题 (/)", "Search issues (/)")} >
              <LinearIcon className="search-icon" name="search" />
              <span className="sr-only">{text("搜索议题", "Search issues")}</span>
              <input
                id="task-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={text("搜索议题…", "Search issues…")}
              />
              {!search && <kbd>/</kbd>}
            </label>
            {boardView === "gantt" && (
              <div className="gantt-toolbar-controls">
                <label className="gantt-hide-completed">
                  <input type="checkbox" checked={ganttHideCompleted} onChange={(event) => setGanttHideCompleted(event.target.checked)} />
                  <i><LinearIcon name="check" /></i>
                  <span>{text("隐藏已完成", "Hide completed")}</span>
                </label>
                <button type="button" className="gantt-today-button" onClick={() => setGanttTodayRequest((current) => current + 1)}>{text("今天", "Today")}</button>
                <div className="gantt-view-menu-wrap">
                  <button type="button" className="gantt-view-menu-trigger" aria-label={text("时间轴视图选项", "Timeline view options")} aria-expanded={ganttViewMenuOpen} onClick={() => setGanttViewMenuOpen((current) => !current)}>
                    <LinearIcon name="more" />
                  </button>
                  {ganttViewMenuOpen && (
                    <div className="gantt-view-menu" role="menu">
                      {GANTT_ZOOM_OPTIONS.map((value) => (
                        <button type="button" role="menuitemradio" aria-checked={ganttZoom === value} className={ganttZoom === value ? "active" : ""} onClick={() => { setGanttZoom(value); setGanttViewMenuOpen(false); }} key={value}>
                          <span>{language === "zh"
                            ? { day: "日视图", week: "周视图", month: "月视图" }[value]
                            : { day: "Day", week: "Week", month: "Month" }[value]}</span>
                          {ganttZoom === value && <LinearIcon name="check" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            <TaskFilterMenu
              tasks={tasks}
              search={search}
              labels={availableLabels}
              filters={filters}
              onChange={setFilters}
            />
            {boardView === "issues" && (
              <BoardSettingsMenu
                showEmptyColumns={showEmptyColumns}
                onShowEmptyColumnsChange={updateShowEmptyColumns}
              />
            )}
            {(search || activeFilterCount > 0) && (
              <button
                className="clear-filter"
                type="button"
                aria-label="清除筛选"
                title="清除筛选"
                onClick={() => { setSearch(""); setFilters(EMPTY_TASK_FILTERS); }}
              >
                <LinearIcon name="close" />
              </button>
            )}
          </div>}
        </div>}

        {(loadError || actionError) && (
          <div className="error-banner" role="alert">
            <span className="error-mark" aria-hidden="true"><LinearIcon name="alert" /></span>
            <div><strong>Taskboard needs attention</strong><p>{actionError ?? loadError}</p></div>
            <button
              type="button"
              onClick={() => {
                setActionError(null);
                if (selectedProjectId) void refreshTasks(selectedProjectId);
                else void loadProjectList();
              }}
            >
              Try again
            </button>
          </div>
        )}

        {!selectedProjectId ? (
          <section className="project-home">
            <div className="project-home-heading">
              <span>任务面板</span>
              <h1>选择项目</h1>
              <p>从 Codex 项目开始，或继续使用之前保存的项目。</p>
            </div>
            {projectsLoading ? (
              <div className="project-grid project-grid-loading" aria-label="正在加载项目" aria-busy="true">
                <span /><span /><span />
              </div>
            ) : projectChoices.length > 0 ? (
              <div className="project-home-groups">
                {[
                  { id: "with-issues", title: "已有议题", projects: projectsWithIssues },
                  { id: "without-issues", title: "尚未添加议题", projects: projectsWithoutIssues },
                ].map((group) => (
                  <section className="project-home-group" key={group.id} aria-labelledby={`project-group-${group.id}`}>
                    <div className="project-group-heading">
                      <h2 id={`project-group-${group.id}`}>{group.title}</h2>
                      <span>{group.projects.length}</span>
                    </div>
                    {group.projects.length > 0 ? (
                      <div className="project-grid">
                        {group.projects.map((project) => (
                          <div className="project-card" key={project.id}>
                            <button
                              className="project-card-open"
                              type="button"
                              disabled={openingProjectId !== null}
                              onClick={() => void selectProject(project)}
                            >
                              <span className="project-card-avatar" aria-hidden="true">
                                {project.name.slice(0, 1).toUpperCase()}
                              </span>
                              <span className="project-card-copy">
                                <strong>{project.name}</strong>
                                <span>
                                  {project.inCodex ? "Codex 项目" : "已保存的项目"}
                                  {project.issueCount > 0 ? ` · ${project.issueCount} 个议题` : ""}
                                </span>
                              </span>
                              {favoriteProjectIds.has(project.id) && <span className="project-card-favorite" aria-label="已收藏"><LinearIcon name="favorite" /></span>}
                              <span className="project-card-action" aria-hidden="true">
                                {openingProjectId === project.id ? "正在打开…" : <LinearIcon name="chevronRight" />}
                              </span>
                            </button>
                            <label className="project-card-directory">
                              <LinearIcon name="folder" />
                              <input
                                key={deviceWorkspacePaths[project.id] ?? ""}
                                type="text"
                                defaultValue={deviceWorkspacePaths[project.id] ?? ""}
                                placeholder="设置此设备的项目目录"
                                aria-label={`${project.name} 在此设备上的项目目录`}
                                onBlur={(event) => rememberDeviceWorkspacePath(project.id, event.currentTarget.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") event.currentTarget.blur();
                                }}
                              />
                            </label>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="project-group-empty">暂无项目</p>
                    )}
                  </section>
                ))}
              </div>
            ) : (
              <div className="project-home-empty">
                <span className="empty-orbit" aria-hidden="true"><i /><i /></span>
                <h2>还没有项目</h2>
                <p>在 DSH 中打开文件夹（注册为工作区）后，任务看板会自动跟随出现。</p>
              </div>
            )}
          </section>
        ) : detailTask && selectedProject ? (
          <TaskDetail
            key={detailTask.id}
            task={detailTask}
            tasks={tasks}
            currentUser={currentUser}
            availableLabels={availableLabels}
            workflows={workflowOptions}
            developmentScan={developmentScan}
            developmentScanLoading={developmentScanLoading}
            commentsRevision={commentsRevision}
            attachmentsRevision={attachmentsRevision}
            onUpdate={(current, changes) => updateTaskProperties(current, changes)}
            onOpenTask={openTaskDetail}
            onAddRelation={(current, type, relatedTaskId) => (
              mutateTaskRelation("add", current, type, relatedTaskId)
            )}
            onRemoveRelation={(current, type, relatedTaskId) => (
              mutateTaskRelation("remove", current, type, relatedTaskId)
            )}
            onOpenThread={openThread}
            onOpenInThread={openTaskInThread}
            onCopy={(content, message) => void copyText(content, message)}
            openingThread={openingThreadTaskId === detailTask.id}
            onError={(message) => setActionError(message === null ? null : typeof message === "string" ? message : message.join(" "))}
            onAnnounce={setAnnouncement}
          />
        ) : boardView === "dashboard" ? (
          <DashboardView
            key={selectedProjectId}
            projectId={selectedProjectId}
            projectCreatedAt={selectedProject?.createdAt ?? null}
            tasks={tasks}
            presentations={taskPresentations}
            currentUser={currentUser}
            animateSummary={false}
            onSummaryAnimationStart={() => {}}
            onOpenTask={openTaskDetail}
            onOpenConversation={openTaskConversation}
          />
        ) : boardView === "list" ? (
          <IssueListView
            scrollRef={issueListRef}
            tasks={filteredTasks}
            presentations={taskPresentations}
            currentUser={currentUser}
            hasActiveFilters={hasActiveTaskFilters}
            onOpenTask={openTaskDetail}
            onOpenConversation={openTaskConversation}
            onUpdate={updateTaskProperties}
          />
        ) : boardView === "gantt" ? (
          <Suspense fallback={<div className="workflow-board-loading">正在打开甘特图…</div>}>
            <GanttView
              tasks={filteredTasks}
              presentations={taskPresentations}
              hasActiveFilters={hasActiveTaskFilters}
              zoom={ganttZoom}
              hideCompleted={ganttHideCompleted}
              todayRequest={ganttTodayRequest}
              onOpenTask={openTaskDetail}
              onUpdate={updateTaskProperties}
            />
          </Suspense>
        ) : boardView === "workflow" ? (
          <Suspense fallback={<div className="workflow-board-loading">正在打开节点模式…</div>}>
            <WorkflowBoard
              key={selectedProject?.id ?? "local"}
              projectId={selectedProject?.id ?? "local"}
              projectName={selectedProject?.name ?? "当前项目"}
              workspacePath={
                selectedDeviceWorkspacePath
                ?? developmentScan.workspacePath
                ?? hostContext?.workspacePath
              }
              revision={workflowRevision}
              onWorkflowsChange={setWorkflowOptions}
            />
          </Suspense>
        ) : tasksLoading && !hasLoadedTasks ? (
          <div className="loading-board" aria-label="Loading issues" aria-busy="true">
            {TASK_STATUSES.map((status) => (
              <div className="loading-column" key={status}>
                <span /><div /><div />
              </div>
            ))}
          </div>
        ) : (
          <div className="board-scroll" aria-label="Issue board">
            <div className="board">
              {filteredTasks.length === 0 && tasks.length > 0 && !showEmptyColumns && (
                <section className="page-empty filter-empty board-filter-empty">
                  <span className="empty-search" aria-hidden="true"><LinearIcon name="search" /></span>
                  <h2>没有匹配的议题</h2>
                  <p>请更换搜索词，或移除一个筛选条件。</p>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => { setSearch(""); setFilters(EMPTY_TASK_FILTERS); }}
                  >
                    清除筛选
                  </button>
                </section>
              )}
              {visibleStatuses.map((status) => (
                <BoardColumn
                  key={status}
                  status={status}
                  statusIndex={TASK_STATUSES.indexOf(status)}
                  tasks={tasksByStatus[status]}
                  isDropTarget={dropTarget === status}
                  draggedTaskId={draggedTaskId}
                  draggedTaskHeight={draggedTaskHeight}
                  movingTaskId={movingTaskId}
                  settlingTaskId={settlingTaskId}
                  contextMenuTaskId={contextMenu?.taskId ?? null}
                  onCreate={(initialStatus) => setEditor({ task: null, status: initialStatus })}
                  onEdit={openTaskDetail}
                  onContextMenu={(task, position) => setContextMenu({ taskId: task.id, ...position })}
                  onMove={(task, destination) => void moveTask(task, destination)}
                  onDragStart={(task, height) => {
                    setDraggedTaskId(task.id);
                    setDraggedTaskHeight(height);
                    setDropTarget(task.status);
                  }}
                  onDragEnd={() => {
                    setDraggedTaskId(null);
                    setDraggedTaskHeight(0);
                    setDropTarget(null);
                  }}
                  onDragEnter={setDropTarget}
                  onDrop={finishTaskDrop}
                  onOpenThread={openThread}
                  onHide={(hiddenStatus) => updateColumnVisibility(hiddenStatus, false)}
                />
              ))}
              {hiddenStatuses.length > 0 && (
                <HiddenColumns
                  statuses={hiddenStatuses}
                  counts={Object.fromEntries(
                    TASK_STATUSES.map((status) => [status, tasksByStatus[status].length]),
                  ) as Record<TaskStatus, number>}
                  dropTarget={dropTarget}
                  onDragTargetChange={setDropTarget}
                  onDrop={(destination, taskId) => finishTaskDrop(destination, taskId)}
                  onShow={(shownStatus) => updateColumnVisibility(shownStatus, true)}
                />
              )}
            </div>
          </div>
        )}
      </main>

      {editor && (
        <TaskEditor
          key={editor.task?.id ?? `new-${editor.status}`}
          task={editor.task}
          initialStatus={editor.status}
          labels={availableLabels}
          workflows={workflowOptions}
          currentUser={currentUser}
          developmentScan={developmentScan}
          developmentScanLoading={developmentScanLoading}
          onCancel={() => setEditor(null)}
          onSave={saveEditor}
        />
      )}

      {contextMenu && contextMenuTask && (
        <TaskContextMenu
          task={contextMenuTask}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          labels={availableLabels}
          onClose={closeContextMenu}
          onEdit={openTaskDetail}
          onStatusChange={(task, status) => void moveTask(task, status)}
          onPriorityChange={(task, nextPriority) => void updateTaskProperties(
            task,
            { priority: nextPriority },
            `${task.identifier} 优先级已更新。`,
          ).catch(() => {})}
          onLabelsChange={(task, labels) => void updateTaskProperties(
            task,
            { labels },
            `${task.identifier} 标签已更新。`,
          ).catch(() => {})}
          onDuplicate={(task) => void duplicateTask(task)}
          onCopy={(text, message) => void copyText(text, message)}
          onOpenInThread={openTaskInThread}
          onArchive={(task) => void archiveTask(task)}
        />
      )}

      <AiChat
        available={localAiChatAvailable}
        projectId={selectedProjectId || null}
        issueId={detailTaskId}
        onThreadsChange={setAiThreads}
        openThreadRequest={aiOpenThreadRequest}
      />

      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      {undoNotice && (
        <div
          className="toast undo-toast"
          role="status"
          onAnimationEnd={() => setUndoNotice((current) => current?.id === undoNotice.id ? null : current)}
        >
          <span className="toast-check" aria-hidden="true"><LinearIcon name="check" /></span>
          <span className="undo-toast-message">{undoNotice.message}</span>
          <button type="button" onClick={() => void performUndo()}>
            撤回 <kbd>{undoShortcut}</kbd>
          </button>
        </div>
      )}
      {announcement && (
        <div className="toast" role="status" onAnimationEnd={() => setAnnouncementValue("")}>
          <span aria-hidden="true"><LinearIcon name="check" /></span>{announcement}
        </div>
      )}
      {draggedTaskId && <div className="drag-hint" aria-hidden="true">拖到目标位置后松开</div>}
    </div>
    </TaskboardLanguageProvider>
  );
}
