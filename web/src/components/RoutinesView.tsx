import { useCallback, useEffect, useState } from "react";

import "./RoutinesView.css";
import {
  createRoutine,
  deleteRoutine,
  getRoutines,
  listProjects,
  runRoutine,
  stopRoutine,
  updateRoutine,
  getRoutineRuns,
  type RoutineCreateInput,
  type RoutineInfo,
  type RoutineRunRecord,
} from "../api";
import type { Project } from "../types";
import { useTaskboardI18n } from "../i18n";

/** 人类可读的 cron 描述；识别 dsh-routines 常用的步进模式。 */
function describeSchedule(schedule: string | undefined, text: (zh: string, en: string) => string): string {
  if (!schedule) return "—";
  const every = schedule.match(/^\*\/(\d+) \* \* \* \*$/);
  if (every) return text(`每 ${every[1]} 分钟`, `Every ${every[1]} min`);
  if (schedule === "0 * * * *") return text("每小时", "Hourly");
  if (schedule === "0 0 * * *") return text("每天零点", "Daily");
  return schedule;
}

function formatTime(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 相对时长描述（对齐官方「(4小时后)」的口吻），分钟以下归一。 */
function formatRelative(timestamp: number | null | undefined, text: (zh: string, en: string) => string): string {
  if (!timestamp) return "";
  const diff = timestamp - Date.now();
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  let value: string;
  if (minutes < 1) value = text("<1 分钟", "<1 min");
  else if (minutes < 60) value = text(`${minutes} 分钟`, `${minutes} min`);
  else if (minutes < 60 * 24) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    value = rest > 0 ? text(`${hours} 小时 ${rest} 分`, `${hours}h ${rest}m`) : text(`${hours} 小时`, `${hours}h`);
  } else {
    const days = Math.floor(minutes / (60 * 24));
    const hours = Math.floor((minutes % (60 * 24)) / 60);
    value = hours > 0 ? text(`${days} 天 ${hours} 小时`, `${days}d ${hours}h`) : text(`${days} 天`, `${days}d`);
  }
  return diff >= 0 ? text(`${value}后`, `in ${value}`) : text(`${value}前`, `${value} ago`);
}

/** 官方风格的「下次计划时间」行：10月6日 20:35 (4小时后)。 */
function formatNextRun(routine: RoutineInfo, text: (zh: string, en: string) => string): string {
  if (routine.paused) return text("已关闭", "Off");
  if (!routine.nextRunAt) return "—";
  return `${formatTime(routine.nextRunAt)} (${formatRelative(routine.nextRunAt, text)})`;
}

function formatDuration(ms: number | null | undefined): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusInfo(status: string | null, text: (zh: string, en: string) => string): { label: string; tone: string } {
  switch (status) {
    case "ok":
    case "completed": return { label: text("成功", "OK"), tone: "ok" };
    case "failed": return { label: text("失败", "Failed"), tone: "failed" };
    case "running": return { label: text("运行中", "Running"), tone: "running" };
    case "canceled": return { label: text("已取消", "Canceled"), tone: "idle" };
    case "killed": return { label: text("已终止", "Killed"), tone: "idle" };
    case "timeout": return { label: text("超时", "Timed out"), tone: "failed" };
    case "skipped": return { label: text("已跳过", "Skipped"), tone: "idle" };
    case "interrupted": return { label: text("已中断", "Interrupted"), tone: "failed" };
    default: return { label: text("从未运行", "Never"), tone: "idle" };
  }
}

const EMPTY_FORM: RoutineCreateInput = {
  name: "",
  schedule: "*/10 * * * *",
  timezone: "Asia/Shanghai",
  prompt: "",
  cwd: "",
  profile: "headless",
  overlap: "skip",
  timeoutMin: 30,
  deliver: ["file"],
};

/** 状态筛选：全部 / 已开启 / 已关闭。 */
type StatusFilter = "all" | "on" | "off";

interface RoutinesViewProps {
  onClose?: () => void;
}

/** 例程列表视图：官方自动化任务页的列表布局 + 项目维度筛选。 */
export function RoutinesView({ onClose }: RoutinesViewProps) {
  const { text } = useTaskboardI18n();
  const [routines, setRoutines] = useState<RoutineInfo[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [directory, setDirectory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<RoutineCreateInput>(EMPTY_FORM);
  const [editing, setEditing] = useState<RoutineInfo | null>(null);
  const [rawEdit, setRawEdit] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [runningName, setRunningName] = useState<string | null>(null);
  const [ranName, setRanName] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  /** 详情对话框：存例程名，渲染时从最新列表取数据，轮询刷新后详情同步更新。 */
  const [detailName, setDetailName] = useState<string | null>(null);
  /** 详情侧栏 tab：规则 / 任务运行记录。 */
  const [sideTab, setSideTab] = useState<"rules" | "runs">("rules");
  const [runs, setRuns] = useState<RoutineRunRecord[] | null>(null);

  const load = useCallback(async () => {
    try {
      const [result, projectList] = await Promise.all([getRoutines(), listProjects()]);
      setRoutines(result.routines);
      setDirectory(result.routinesDirectory);
      setProjects(projectList);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : text("读取自动化失败", "Failed to load automations"));
    } finally {
      setLoading(false);
    }
  }, [text]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  // Esc 关闭详情对话框
  useEffect(() => {
    if (!detailName) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailName(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [detailName]);

  // 切换详情目标时重置 tab 并拉取运行历史
  useEffect(() => {
    setSideTab("rules");
    setRuns(null);
    if (!detailName) return;
    const controller = new AbortController();
    getRoutineRuns(detailName, controller.signal)
      .then((data) => setRuns(data.runs))
      .catch(() => setRuns([]));
    return () => controller.abort();
  }, [detailName]);

  const submitCreate = async () => {
    try {
      await createRoutine(draft);
      setCreating(false);
      setDraft(EMPTY_FORM);
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : text("创建失败", "Create failed"));
    }
  };

  const submitEdit = async () => {
    if (!editing) return;
    try {
      await updateRoutine(editing.name, { raw: rawEdit });
      setEditing(null);
      await load();
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : text("保存失败", "Save failed"));
    }
  };

  const submitDelete = async (name: string) => {
    try {
      await deleteRoutine(name);
      setConfirmDelete(null);
      await load();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : text("删除失败", "Delete failed"));
    }
  };

  /** 开启/关闭：写 paused 字段，调度器热重载后即生效。 */
  const togglePaused = async (routine: RoutineInfo) => {
    try {
      await updateRoutine(routine.name, { paused: !routine.paused });
      await load();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : text("切换失败", "Toggle failed"));
    }
  };

  /** 测试执行：手动触发一次，不等待完成。 */
  const submitRun = async (name: string) => {
    setRunningName(name);
    setRanName(null);
    try {
      await runRoutine(name);
      setRanName(name);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : text("触发失败", "Trigger failed"));
    } finally {
      setRunningName(null);
    }
  };

  const isClaimRoutine = (name: string) => name.startsWith("taskboard-claim-");

  /** 停止运行中的认领例程（进程内会话 dispose）。 */
  const submitStop = async (name: string) => {
    try {
      await stopRoutine(name);
      setError(null);
      await load();
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : text("停止失败", "Stop failed"));
    }
  };

  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const visibleRoutines: RoutineInfo[] = activeProject
    ? (routines ?? []).filter((routine) => routine.cwd === activeProject.workspacePath)
    : (routines ?? []);
  const searchQuery = search.trim().toLowerCase();
  const filteredRoutines = visibleRoutines.filter((routine) => {
    if (statusFilter === "on" && routine.paused) return false;
    if (statusFilter === "off" && !routine.paused) return false;
    if (!searchQuery) return true;
    return routine.name.toLowerCase().includes(searchQuery)
      || (routine.cwd ?? "").toLowerCase().includes(searchQuery)
      || (routine.prompt ?? "").toLowerCase().includes(searchQuery);
  });

  /** 详情对话框的数据始终来自最新列表（30s 轮询刷新后同步更新）。 */
  const detailRoutine = detailName
    ? (routines ?? []).find((routine) => routine.name === detailName) ?? null
    : null;

  const statusTabs: Array<{ key: StatusFilter; label: string }> = [
    { key: "all", label: text("全部", "All") },
    { key: "on", label: text("已开启", "Enabled") },
    { key: "off", label: text("已关闭", "Disabled") },
  ];

  return (
    <div className="routines-view" aria-label={text("自动化", "Automation")}>
      <div className="routines-main">
      <div className="routines-header">
        <div>
          <h2>{text("自动化任务", "Automations")}</h2>
          {directory && <p className="routines-directory" title={directory}>{directory}</p>}
        </div>
        <div className="routines-header-actions">
          <button type="button" className="routines-create" onClick={() => { setCreating(true); setError(null); }}>
            ＋ {text("新建", "New")}
          </button>
          <button type="button" className="routines-refresh" onClick={() => void load()} disabled={loading}>
            {text("刷新", "Refresh")}
          </button>
          {onClose && (
            <button type="button" className="routines-close" onClick={onClose} aria-label="关闭">×</button>
          )}
        </div>
      </div>

      <div className="routines-filters">
        <div className="routines-search">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={text("搜索自动化任务…", "Search automations…")}
            aria-label={text("搜索自动化任务", "Search automations")}
          />
        </div>
        <div className="routines-status-tabs" role="tablist" aria-label={text("按状态筛选", "Filter by status")}>
          {statusTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={statusFilter === tab.key}
              className={`routines-status-tab${statusFilter === tab.key ? " is-active" : ""}`}
              onClick={() => setStatusFilter(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {routines && projects.length > 0 && (
        <div className="routines-tabs" role="tablist" aria-label={text("按项目筛选", "Filter by project")}>
          <button
            type="button"
            role="tab"
            aria-selected={activeProjectId === null}
            className={`routines-tab${activeProjectId === null ? " is-active" : ""}`}
            onClick={() => setActiveProjectId(null)}
          >
            {text("全部项目", "All projects")}
          </button>
          {projects.filter((project) => project.workspacePath).map((project) => (
            <button
              key={project.id}
              type="button"
              role="tab"
              aria-selected={activeProjectId === project.id}
              className={`routines-tab${activeProjectId === project.id ? " is-active" : ""}`}
              onClick={() => setActiveProjectId(project.id)}
            >
              {project.name}
            </button>
          ))}
        </div>
      )}

      {error && <p className="routines-error" role="alert">{error}</p>}
      {loading && routines === null ? (
        <p className="routines-loading">{text("正在读取自动化…", "Loading automations…")}</p>
      ) : !routines || routines.length === 0 ? (
        <p className="routines-empty">{text("暂无自动化。在看板里开启某个项目的自动认领，或点「新建」添加。", "No automations yet.")}</p>
      ) : filteredRoutines.length === 0 ? (
        <p className="routines-empty">
          {searchQuery || statusFilter !== "all" || activeProjectId
            ? text("没有匹配的自动化任务。", "No matching automations.")
            : text("该项目暂无自动化任务。可在任务看板中开启自动认领。", "No automation tasks for this project.")}
        </p>
      ) : (
        <div className="routines-list">
          {filteredRoutines.map((routine) => {
            return (
              <article className={`routine-row${routine.paused ? " is-off" : ""}${detailName === routine.name ? " is-selected" : ""}`} key={routine.name}>
                {/* 覆盖点击层：点击行主体打开详情 */}
                <button
                  type="button"
                  className="routine-row-open"
                  onClick={() => setDetailName(routine.name)}
                  aria-label={`${routine.name} · ${text("查看详情", "View details")}`}
                />
                <div className="routine-row-main">
                  <div className="routine-row-title">
                    <svg className="routine-row-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                      <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
                      <path d="M8 4.6V8l2.4 1.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                    <strong className="routine-name">{routine.name}</strong>
                    {isClaimRoutine(routine.name) && <span className="routine-badge">认领</span>}
                  </div>
                  <div className="routine-row-meta">
                    <span className="routine-schedule">{describeSchedule(routine.schedule, text)}</span>
                    <span className="routine-meta-dot">·</span>
                    <span className="routine-next">{text("下次计划时间", "Next")}: {formatNextRun(routine, text)}</span>
                  </div>
                </div>
                <div className="routine-row-side">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={!routine.paused}
                    aria-label={isClaimRoutine(routine.name)
                      ? text("自动认领开关", "Auto-claim switch")
                      : text("启用开关", "Enable switch")}
                    className={`routine-switch${routine.paused ? "" : " is-on"}`}
                    onClick={() => void togglePaused(routine)}
                  >
                    <span aria-hidden="true" />
                  </button>
                  <div className="routine-row-actions">
                    <button
                      type="button"
                      className="routine-action is-icon"
                      aria-label={runningName === routine.name
                        ? text("触发中…", "Running…")
                        : text("运行", "Run")}
                      title={runningName === routine.name
                        ? text("触发中…", "Running…")
                        : ranName === routine.name
                          ? text("已触发 ✓", "Triggered ✓")
                          : text("运行", "Run")}
                      disabled={runningName === routine.name}
                      onClick={() => void submitRun(routine.name)}
                    >
                      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                        <path d="M5 3.4v9.2a.6.6 0 0 0 .9.5l7.2-4.6a.6.6 0 0 0 0-1L5.9 2.9a.6.6 0 0 0-.9.5z" fill="currentColor" />
                      </svg>
                    </button>
                    {routine.lastRun?.status === "running" && (
                      <button type="button" className="routine-action is-danger is-icon" aria-label={text("停止", "Stop")} title={text("停止", "Stop")} onClick={() => void submitStop(routine.name)}>
                        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                          <rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      </div>

      {creating && (
        <div className="routines-modal">
          <div className="routines-modal-box">
            <h3>{text("新建自动化", "New automation")}</h3>
            <label>{text("名称", "Name")}
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="my-routine" />
            </label>
            <label>{text("调度 (cron)", "Schedule (cron)")}
              <input value={draft.schedule} onChange={(e) => setDraft({ ...draft, schedule: e.target.value })} placeholder="*/10 * * * *" />
            </label>
            <label>{text("时区", "Timezone")}
              <input value={draft.timezone ?? ""} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} />
            </label>
            <label>{text("工作目录", "Cwd")}
              <input value={draft.cwd ?? ""} onChange={(e) => setDraft({ ...draft, cwd: e.target.value })} />
            </label>
            <label>{text("Profile", "Profile")}
              <input value={draft.profile ?? ""} onChange={(e) => setDraft({ ...draft, profile: e.target.value })} />
            </label>
            <label>{text("Prompt", "Prompt")}
              <textarea rows={8} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
            </label>
            <div className="routines-modal-actions">
              <button type="button" onClick={() => setCreating(false)}>{text("取消", "Cancel")}</button>
              <button type="button" className="is-primary" onClick={() => void submitCreate()} disabled={!draft.name || !draft.schedule || !draft.prompt}>
                {text("创建", "Create")}
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div className="routines-modal">
          <div className="routines-modal-box">
            <h3>{text("编辑自动化", "Edit automation")}: {editing.name}</h3>
            {editing.unknownKeys && editing.unknownKeys.length > 0 && (
              <p className="routines-note">
                {text("包含未识别字段", "Contains unrecognized fields")}: {editing.unknownKeys.join(", ")}
              </p>
            )}
            <label>{text("YAML 全文", "Raw YAML")}
              <textarea rows={14} value={rawEdit} onChange={(e) => setRawEdit(e.target.value)} className="routines-raw" />
            </label>
            <div className="routines-modal-actions">
              <button type="button" onClick={() => setEditing(null)}>{text("取消", "Cancel")}</button>
              <button type="button" className="is-primary" onClick={() => void submitEdit()} disabled={!rawEdit.trim()}>
                {text("保存", "Save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="routines-modal">
          <div className="routines-modal-box">
            <h3>{text("删除自动化", "Delete automation")}: {confirmDelete}</h3>
            <p className="routines-note">{text("将删除该自动化任务，不可恢复。", "This automation will be removed permanently.")}</p>
            <div className="routines-modal-actions">
              <button type="button" onClick={() => setConfirmDelete(null)}>{text("取消", "Cancel")}</button>
              <button type="button" className="is-danger" onClick={() => void submitDelete(confirmDelete)}>
                {text("删除", "Delete")}
              </button>
            </div>
          </div>
        </div>
      )}

      {detailRoutine && (
        <aside
          className="routine-side"
          role="dialog"
          aria-label={detailRoutine.name}
        >
          <header className="routine-side-header">
            <div className="routine-detail-title">
              <h3>{detailRoutine.name}</h3>
              {isClaimRoutine(detailRoutine.name) && <span className="routine-badge">认领</span>}
              <span className={`routine-status is-${statusInfo(detailRoutine.lastRun?.status ?? null, text).tone}`}>
                {statusInfo(detailRoutine.lastRun?.status ?? null, text).label}
              </span>
            </div>
            <div className="routine-detail-header-actions">
              <button type="button" className="routine-detail-close" onClick={() => setDetailName(null)} aria-label={text("关闭", "Close")}>×</button>
            </div>
          </header>
          <div className="routine-side-next">
            {text("下次运行", "Next run")} {formatNextRun(detailRoutine, text)}
          </div>
          <div className="routine-side-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={sideTab === "rules"}
              className={`routine-side-tab${sideTab === "rules" ? " is-active" : ""}`}
              onClick={() => setSideTab("rules")}
            >
              {text("规则", "Rules")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sideTab === "runs"}
              className={`routine-side-tab${sideTab === "runs" ? " is-active" : ""}`}
              onClick={() => setSideTab("runs")}
            >
              {text("任务运行记录", "Run history")}
            </button>
          </div>
          {sideTab === "rules" ? (
          <div className="routine-side-body">
              {detailRoutine.prompt && (
                <div className="routine-prompt-card">
                  <pre className="routine-detail-prompt">{detailRoutine.prompt}</pre>
                </div>
              )}
              <div className="routine-side-section-label">{text("运行时间", "Schedule")}</div>
              <dl className="routine-schedule-card">
                <div className="routine-detail-row">
                  <dt>{text("重复", "Repeat")}</dt>
                  <dd>{describeSchedule(detailRoutine.schedule, text)}</dd>
                </div>
                <div className="routine-detail-row">
                  <dt>{text("频率", "Cron")}</dt>
                  <dd className="routine-detail-mono">{detailRoutine.schedule ?? "—"}</dd>
                </div>
                {detailRoutine.timezone && (
                  <div className="routine-detail-row">
                    <dt>{text("时区", "Timezone")}</dt>
                    <dd>{detailRoutine.timezone}</dd>
                  </div>
                )}
                {detailRoutine.cwd && (
                  <div className="routine-detail-row">
                    <dt>{text("目录", "cwd")}</dt>
                    <dd title={detailRoutine.cwd}>{detailRoutine.cwd}</dd>
                  </div>
                )}
                {detailRoutine.profile && (
                  <div className="routine-detail-row">
                    <dt>Profile</dt>
                    <dd>{detailRoutine.profile}</dd>
                  </div>
                )}
                {detailRoutine.overlap && (
                  <div className="routine-detail-row">
                    <dt>{text("重叠策略", "Overlap")}</dt>
                    <dd>{detailRoutine.overlap}</dd>
                  </div>
                )}
                {detailRoutine.timeoutMin != null && (
                  <div className="routine-detail-row">
                    <dt>{text("超时", "Timeout")}</dt>
                    <dd>{text(`${detailRoutine.timeoutMin} 分钟`, `${detailRoutine.timeoutMin} min`)}</dd>
                  </div>
                )}
              </dl>
              <p className="routine-side-summary">{describeSchedule(detailRoutine.schedule, text)}</p>
          </div>
          ) : (
          <div className="routine-side-body">
              {runs === null ? (
                <p className="routine-detail-empty">{text("正在读取运行记录…", "Loading run history…")}</p>
              ) : runs.length === 0 ? (
                <p className="routine-detail-empty">{text("该例程尚未运行。", "This routine has not run yet.")}</p>
              ) : (
                <div className="routine-runs-list">
                  {runs.map((run) => {
                    const info = statusInfo(run.status ?? null, text);
                    return (
                      <div className="routine-run-item" key={run.runId ?? `${run.routine}-${run.startedAt}`}>
                        <div className="routine-run-head">
                          <span className={`routine-status is-${info.tone}`}>{info.label}</span>
                          <span className="routine-run-time">{formatTime(run.startedAt ?? null)}</span>
                          <span className="routine-run-duration">{formatDuration(run.durationMs)}</span>
                        </div>
                        {run.error && <div className="routine-run-error" title={run.error}>{run.error}</div>}
                        {run.digest && <div className="routine-run-digest" title={run.digest}>{run.digest}</div>}
                      </div>
                    );
                  })}
                </div>
              )}
          </div>
          )}
            <footer className="routine-side-footer">
              <span className="routine-detail-hint">
                {isClaimRoutine(detailRoutine.name)
                  ? text("认领例程由看板「自动认领」开关驱动。", "Claim routines are driven by the board's auto-claim switch.")
                  : text("例程由 dsh-routines 调度器按计划执行。", "Routines run on schedule via the dsh-routines scheduler.")}
              </span>
              <div className="routine-detail-actions">
                <button
                  type="button"
                  className="is-primary"
                  disabled={runningName === detailRoutine.name}
                  onClick={() => void submitRun(detailRoutine.name)}
                >
                  {runningName === detailRoutine.name
                    ? text("触发中…", "Running…")
                    : ranName === detailRoutine.name
                      ? text("已触发 ✓", "Triggered ✓")
                      : text("运行", "Run")}
                </button>
                {detailRoutine.lastRun?.status === "running" && (
                  <button type="button" className="is-danger" onClick={() => void submitStop(detailRoutine.name)}>
                    {text("停止", "Stop")}
                  </button>
                )}
                {!isClaimRoutine(detailRoutine.name) && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(detailRoutine);
                        setRawEdit(detailRoutine.raw ?? "");
                        setDetailName(null);
                        setError(null);
                      }}
                    >
                      {text("编辑", "Edit")}
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      onClick={() => {
                        setConfirmDelete(detailRoutine.name);
                        setDetailName(null);
                      }}
                    >
                      {text("删除", "Delete")}
                    </button>
                  </>
                )}
              </div>
            </footer>
        </aside>
      )}
    </div>
  );
}
