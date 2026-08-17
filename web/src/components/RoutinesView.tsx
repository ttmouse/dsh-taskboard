import { useCallback, useEffect, useState } from "react";

import "./RoutinesView.css";
import {
  createRoutine,
  deleteRoutine,
  getRoutines,
  updateRoutine,
  type RoutineCreateInput,
  type RoutineInfo,
} from "../api";
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
  const [directory, setDirectory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<RoutineCreateInput>(EMPTY_FORM);
  const [editing, setEditing] = useState<RoutineInfo | null>(null);
  const [rawEdit, setRawEdit] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await getRoutines();
      setRoutines(result.routines);
      setDirectory(result.routinesDirectory);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : text("读取例程失败", "Failed to load routines"));
    } finally {
      setLoading(false);
    }
  }, [text]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

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

  const isClaimRoutine = (name: string) => name.startsWith("taskboard-claim-");

  return (
    <div className="routines-view" aria-label={text("自动化", "Automation")}>
      <div className="routines-header">
        <div>
          <h2>{text("自动化", "Automation")}</h2>
          {directory && <p className="routines-directory" title={directory}>{directory}</p>}
        </div>
        <div className="routines-header-actions">
          <button type="button" className="routines-create" onClick={() => { setCreating(true); setError(null); }}>
            {text("新建例程", "New routine")}
          </button>
          <button type="button" className="routines-refresh" onClick={() => void load()} disabled={loading}>
            {text("刷新", "Refresh")}
          </button>
          {onClose && (
            <button type="button" className="routines-close" onClick={onClose} aria-label="关闭">×</button>
          )}
        </div>
      </div>
      {error && <p className="routines-error" role="alert">{error}</p>}
      {loading && routines === null ? (
        <p className="routines-loading">{text("正在读取例程…", "Loading routines…")}</p>
      ) : !routines || routines.length === 0 ? (
        <p className="routines-empty">{text("暂无例程。在看板里开启某个项目的自动认领，或点「新建例程」添加。", "No routines yet.")}</p>
      ) : (
        <div className="routines-grid">
          {routines.map((routine) => {
            const status = statusInfo(routine.lastRun?.status ?? null, text);
            return (
              <article className="routine-card" key={routine.name}>
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
                  <span className="routine-row-value">{formatTime(routine.nextRunAt)}</span>
                </div>
                {routine.lastRun?.digest && <p className="routine-digest">{routine.lastRun.digest}</p>}
                {routine.lastRun?.error && <p className="routine-error" title={routine.lastRun.error}>{routine.lastRun.error}</p>}
                {routine.prompt && (
                  <details className="routine-prompt">
                    <summary>{text("查看任务说明", "View prompt")}</summary>
                    <pre>{routine.prompt}</pre>
                  </details>
                )}
                <div className="routine-actions">
                  <button type="button" onClick={() => { setEditing(routine); setRawEdit(routine.raw ?? ""); setError(null); }}>
                    {text("编辑", "Edit")}
                  </button>
                  <button type="button" className="is-danger" onClick={() => setConfirmDelete(routine.name)}>
                    {text("删除", "Delete")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {creating && (
        <div className="routines-modal">
          <div className="routines-modal-box">
            <h3>{text("新建例程", "New routine")}</h3>
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
            <h3>{text("编辑例程", "Edit routine")}: {editing.name}</h3>
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
            <h3>{text("删除例程", "Delete routine")}: {confirmDelete}</h3>
            <p className="routines-note">{text("将删除例程文件，不可恢复。", "The routine file will be removed permanently.")}</p>
            <div className="routines-modal-actions">
              <button type="button" onClick={() => setConfirmDelete(null)}>{text("取消", "Cancel")}</button>
              <button type="button" className="is-danger" onClick={() => void submitDelete(confirmDelete)}>
                {text("删除", "Delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
