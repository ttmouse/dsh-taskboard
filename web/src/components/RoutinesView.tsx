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
  type RoutineCreateInput,
  type RoutineInfo,
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

function formatDuration(ms: number | null | undefined): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusInfo(status: string | null, text: (zh: string, en: string) => string): { label: string; tone: string } {
  switch (status) {
    case "ok": return { label: text("成功", "OK"), tone: "ok" };
    case "failed": return { label: text("失败", "Failed"), tone: "failed" };
    case "running": return { label: text("运行中", "Running"), tone: "running" };
    case "canceled": return { label: text("已取消", "Canceled"), tone: "idle" };
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

interface RoutinesViewProps {
  onClose?: () => void;
}

/** 例程列表视图：展示 dsh-routines 目录下的所有例程、最近运行状态，并支持增删改查。 */
export function RoutinesView({ onClose }: RoutinesViewProps) {
  const { text } = useTaskboardI18n();
  const [routines, setRoutines] = useState<RoutineInfo[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
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
    if (!searchQuery) return true;
    return routine.name.toLowerCase().includes(searchQuery)
      || (routine.cwd ?? "").toLowerCase().includes(searchQuery)
      || (routine.prompt ?? "").toLowerCase().includes(searchQuery);
  });

  /** 详情对话框的数据始终来自最新列表（30s 轮询刷新后同步更新）。 */
  const detailRoutine = detailName
    ? (routines ?? []).find((routine) => routine.name === detailName) ?? null
    : null;

  return (
    <div className="routines-view" aria-label={text("自动化", "Automation")}>
      <div className="routines-header">
        <div>
          <h2>{text("自动化", "Automation")}</h2>
          {directory && <p className="routines-directory" title={directory}>{directory}</p>}
        </div>
        <div className="routines-header-actions">
          <input
            type="search"
            className="routines-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={text("搜索自动化任务…", "Search automations…")}
            aria-label={text("搜索自动化任务", "Search automations")}
          />
          <button type="button" className="routines-create" onClick={() => { setCreating(true); setError(null); }}>
            {text("新建自动化", "New automation")}
          </button>
          <button type="button" className="routines-refresh" onClick={() => void load()} disabled={loading}>
            {text("刷新", "Refresh")}
          </button>
          {onClose && (
            <button type="button" className="routines-close" onClick={onClose} aria-label="关闭">×</button>
          )}
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
            {text("全部", "All")}
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
        <p className="routines-empty">{text("暂无自动化。在看板里开启某个项目的自动认领，或点「新建自动化」添加。", "No automations yet.")}</p>
      ) : filteredRoutines.length === 0 ? (
        <p className="routines-empty">
          {searchQuery
            ? text("没有匹配的自动化任务。", "No matching automations.")
            : text("该项目暂无自动化任务。可在任务看板中开启自动认领。", "No automation tasks for this project.")}
        </p>
      ) : (
        <div className="routines-grid">
          {filteredRoutines.map((routine) => {
            const status = statusInfo(routine.lastRun?.status ?? null, text);
            return (
              <article className="routine-card" key={routine.name}>
                {/* 覆盖点击层：点击卡片主体打开详情（对齐 .task-card-open） */}
                <button
                  type="button"
                  className="routine-card-open"
                  onClick={() => setDetailName(routine.name)}
                  aria-label={`${routine.name} · ${text("查看详情", "View details")}`}
                />
                <header className="routine-card-header">
                  <strong className="routine-name">{routine.name}</strong>
                  {isClaimRoutine(routine.name) && <span className="routine-badge">认领</span>}
                  <span className={`routine-status is-${status.tone}`}>{status.label}</span>
                </header>
                <div className="routine-meta">
                  <span className="routine-schedule">{describeSchedule(routine.schedule, text)}</span>
                  {routine.timezone && <span className="routine-timezone">{routine.timezone}</span>}
                  {routine.profile && <span className="routine-profile">{routine.profile}</span>}
                </div>
                {routine.cwd && (
                  <div className="routine-row">
                    <span className="routine-row-label">{text("目录", "cwd")}</span>
                    <span className="routine-row-value routine-cwd" title={routine.cwd}>{routine.cwd}</span>
                  </div>
                )}
                <div className="routine-row">
                  <span className="routine-row-label">{text("最近运行", "Last run")}</span>
                  <span className="routine-row-value">
                    {formatTime(routine.lastRun?.startedAt)}
                    {routine.lastRun?.durationMs != null && <> · {formatDuration(routine.lastRun.durationMs)}</>}
                  </span>
                </div>
                <div className="routine-row">
                  <span className="routine-row-label">{text("下次运行", "Next run")}</span>
                  <span className="routine-row-value">
                    {routine.paused ? text("已关闭", "Off") : formatTime(routine.nextRunAt)}
                  </span>
                </div>
                {routine.lastRun?.digest && <p className="routine-digest">{routine.lastRun.digest}</p>}
                {routine.lastRun?.error && (
                  <p className="routine-error" title={routine.lastRun.error}>
                    {routine.lastRun.status === "skipped"
                      ? (routine.lastRun.check
                        ? text("本轮已跳过（没有待认领的任务）。", "This run was skipped (no tasks to claim).")
                        : text("上次运行未结束，本次到点已自动跳过。", "Previous run still in progress; this run was skipped."))
                      : routine.lastRun.error}
                  </p>
                )}
                <div className="routine-switch-row">
                  <span>
                    {isClaimRoutine(routine.name)
                      ? (routine.paused
                        ? text("认领已关闭", "Claim off")
                        : text("认领已开启", "Claim on"))
                      : (routine.paused ? text("已暂停", "Paused") : text("启用中", "Enabled"))}
                  </span>
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
                </div>
                <div className="routine-actions">
                  <button
                    type="button"
                    className="is-primary"
                    disabled={runningName === routine.name}
                    onClick={() => void submitRun(routine.name)}
                  >
                    {runningName === routine.name
                      ? text("触发中…", "Triggering…")
                      : ranName === routine.name
                        ? text("已触发 ✓", "Triggered ✓")
                        : text("测试执行", "Run now")}
                  </button>
                  {routine.lastRun?.status === "running" && (
                    <button type="button" className="is-danger" onClick={() => void submitStop(routine.name)}>
                      {text("停止", "Stop")}
                    </button>
                  )}
                  {!isClaimRoutine(routine.name) && (
                    <>
                      <button type="button" onClick={() => { setEditing(routine); setRawEdit(routine.raw ?? ""); setError(null); }}>
                        {text("编辑", "Edit")}
                      </button>
                      <button type="button" className="is-danger" onClick={() => setConfirmDelete(routine.name)}>
                        {text("删除", "Delete")}
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

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
        <div
          className="routine-detail"
          role="dialog"
          aria-modal="true"
          aria-label={detailRoutine.name}
          onClick={() => setDetailName(null)}
        >
          <div className="routine-detail-box" onClick={(event) => event.stopPropagation()}>
            <header className="routine-detail-header">
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
            <div className="routine-detail-body">
              <dl className="routine-detail-rows">
                <div className="routine-detail-row">
                  <dt>{text("调度", "Schedule")}</dt>
                  <dd>{describeSchedule(detailRoutine.schedule, text)}</dd>
                </div>
                {detailRoutine.timezone && (
                  <div className="routine-detail-row">
                    <dt>{text("时区", "Timezone")}</dt>
                    <dd>{detailRoutine.timezone}</dd>
                  </div>
                )}
                {detailRoutine.profile && (
                  <div className="routine-detail-row">
                    <dt>Profile</dt>
                    <dd>{detailRoutine.profile}</dd>
                  </div>
                )}
                {detailRoutine.cwd && (
                  <div className="routine-detail-row">
                    <dt>{text("目录", "cwd")}</dt>
                    <dd title={detailRoutine.cwd}>{detailRoutine.cwd}</dd>
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
                {Array.isArray(detailRoutine.deliver) && detailRoutine.deliver.length > 0 && (
                  <div className="routine-detail-row">
                    <dt>{text("交付", "Deliver")}</dt>
                    <dd>{detailRoutine.deliver.join(", ")}</dd>
                  </div>
                )}
              </dl>

              <section className="routine-detail-section">
                <h4>{text("最近运行", "Last run")}</h4>
                {detailRoutine.lastRun ? (
                  <dl className="routine-detail-rows">
                    <div className="routine-detail-row">
                      <dt>{text("开始", "Started")}</dt>
                      <dd>{formatTime(detailRoutine.lastRun.startedAt)}</dd>
                    </div>
                    <div className="routine-detail-row">
                      <dt>{text("耗时", "Duration")}</dt>
                      <dd>{formatDuration(detailRoutine.lastRun.durationMs)}</dd>
                    </div>
                    {detailRoutine.lastRun.finishedAt != null && (
                      <div className="routine-detail-row">
                        <dt>{text("结束", "Finished")}</dt>
                        <dd>{formatTime(detailRoutine.lastRun.finishedAt)}</dd>
                      </div>
                    )}
                    {detailRoutine.lastRun.exitCode != null && (
                      <div className="routine-detail-row">
                        <dt>{text("退出码", "Exit code")}</dt>
                        <dd>{detailRoutine.lastRun.exitCode}</dd>
                      </div>
                    )}
                    {detailRoutine.lastRun.sessionId && (
                      <div className="routine-detail-row">
                        <dt>{text("会话", "Session")}</dt>
                        <dd className="routine-detail-mono" title={detailRoutine.lastRun.sessionId}>{detailRoutine.lastRun.sessionId}</dd>
                      </div>
                    )}
                    {detailRoutine.lastRun.error && (
                      <div className="routine-detail-row">
                        <dt>{text("错误", "Error")}</dt>
                        <dd className="routine-detail-error" title={detailRoutine.lastRun.error}>{detailRoutine.lastRun.error}</dd>
                      </div>
                    )}
                    {detailRoutine.lastRun.digest && (
                      <div className="routine-detail-row">
                        <dt>{text("摘要", "Digest")}</dt>
                        <dd>{detailRoutine.lastRun.digest}</dd>
                      </div>
                    )}
                  </dl>
                ) : (
                  <p className="routine-detail-empty">{text("该例程尚未运行。", "This routine has not run yet.")}</p>
                )}
              </section>

              {detailRoutine.prompt && (
                <section className="routine-detail-section">
                  <h4>{text("任务说明", "Prompt")}</h4>
                  <pre className="routine-detail-prompt">{detailRoutine.prompt}</pre>
                </section>
              )}
            </div>
            <footer className="routine-detail-footer">
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
                    ? text("触发中…", "Triggering…")
                    : ranName === detailRoutine.name
                      ? text("已触发 ✓", "Triggered ✓")
                      : text("测试执行", "Run now")}
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
          </div>
        </div>
      )}
    </div>
  );
}
