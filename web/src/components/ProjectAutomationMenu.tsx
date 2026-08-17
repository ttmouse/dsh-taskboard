import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AutomationReasoningEffort } from "../../../shared/taskboard-automation-options.mjs";
import { TaskboardIcon } from "./TaskboardIcon";
import { useTaskboardI18n } from "../i18n";

type AutomationStatus = "ACTIVE" | "PAUSED";
type IntervalMinutes = 5 | 10 | 15 | 30 | 60;

interface AutomationOptions {
  enabledByUser: boolean;
  quotaAware: boolean;
  intervalMinutes: IntervalMinutes;
  /** 认领模型：'' = 跟随 agent-default-model。 */
  model: string;
  reasoningEffort: AutomationReasoningEffort;
}

interface AutomationState extends AutomationOptions {
  status: AutomationStatus;
}

interface ProjectAutomationMenuProps {
  automation?: Partial<AutomationState>;
  /** 认领模型目录（来自 /api/automation/models）。 */
  models: string[];
  pending: boolean;
  error: string | null;
  unavailableReason: string | null;
  onOpen: () => void;
  onChange: (options: AutomationOptions) => void;
}

const DEFAULT_OPTIONS: AutomationOptions = {
  enabledByUser: false,
  quotaAware: false,
  intervalMinutes: 5,
  model: "",
  reasoningEffort: "high",
};

export function ProjectAutomationMenu({
  automation,
  models,
  pending,
  error,
  unavailableReason,
  onOpen,
  onChange,
}: ProjectAutomationMenuProps) {
  const { text } = useTaskboardI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasPendingRef = useRef(pending);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const [draft, setDraft] = useState<AutomationOptions>(DEFAULT_OPTIONS);
  const [modelFilter, setModelFilter] = useState("");
  const status = automation?.status ?? "PAUSED";
  const stateLabel = !automation?.enabledByUser
    ? text("已暂停", "Paused")
    : status === "ACTIVE"
      ? text("运行中", "Running")
      : text("已暂停", "Paused");
  const disabled = pending || Boolean(unavailableReason);

  /** 认领模型目录按供应商分组（值仍是 "provider::model"，组标签显示供应商）。 */
  const modelGroups: Array<[string, string[]]> = [];
  const plainModels: string[] = [];
  for (const choice of models) {
    const separator = choice.indexOf("::");
    if (separator < 0) {
      plainModels.push(choice);
      continue;
    }
    const provider = choice.slice(0, separator);
    let group = modelGroups.find(([name]) => name === provider);
    if (!group) {
      group = [provider, []];
      modelGroups.push(group);
    }
    group[1].push(choice);
  }

  /** 模型检索：按模型名或供应商名过滤；已选中的模型始终保留。 */
  const normalizedModelFilter = modelFilter.trim().toLowerCase();
  const modelMatchesFilter = (choice: string): boolean => {
    if (!normalizedModelFilter) return true;
    const separator = choice.indexOf("::");
    const provider = separator >= 0 ? choice.slice(0, separator) : "";
    const model = separator >= 0 ? choice.slice(separator + 2) : choice;
    return model.toLowerCase().includes(normalizedModelFilter)
      || provider.toLowerCase().includes(normalizedModelFilter);
  };
  const filteredModelGroups: Array<[string, string[]]> = modelGroups
    .map(([provider, choices]) => [
      provider,
      choices.filter((choice) => modelMatchesFilter(choice) || choice === draft.model),
    ] as [string, string[]])
    .filter(([, choices]) => choices.length > 0);
  const filteredPlainModels = plainModels.filter((choice) => modelMatchesFilter(choice) || choice === draft.model);

  useEffect(() => {
    if (!open) return;
    setDraft({ ...DEFAULT_OPTIONS, ...automation });
    setModelFilter("");
  }, [open]);

  useEffect(() => {
    if (wasPendingRef.current && !pending) {
      setDraft({ ...DEFAULT_OPTIONS, ...automation });
    }
    wasPendingRef.current = pending;
  }, [automation, pending]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8));
    const top = trigger.bottom + 8 + menu.height <= window.innerHeight
      ? trigger.bottom + 8
      : Math.max(8, trigger.top - menu.height - 8);
    setPosition({ left, top, ready: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function closeFromViewportChange() {
      setOpen(false);
    }
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    window.addEventListener("resize", closeFromViewportChange);
    window.addEventListener("scroll", closeFromViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [open]);

  const submitChange = (next: AutomationOptions) => {
    if (disabled) return;
    setDraft(next);
    onChange(next);
  };

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="project-automation-menu no-drag"
      role="dialog"
      aria-label={text("自动认领待办设置", "Auto-claim settings")}
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      <div className="project-automation-menu-heading">
        <strong>{text("自动认领待办", "Auto-claim tasks")}</strong>
        <span className={status === "ACTIVE" ? "is-active" : "is-paused"}>
          {stateLabel}
        </span>
      </div>
      <div className="project-automation-switch">
        <span>{text("自动认领开关", "Auto-claim")}</span>
        <button
          type="button"
          className={`board-setting-switch${draft.enabledByUser ? " is-on" : ""}`}
          role="switch"
          aria-checked={draft.enabledByUser}
          disabled={disabled}
          onClick={() => submitChange({
            ...draft,
            enabledByUser: !draft.enabledByUser,
          })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <label className="project-automation-field">
        <span>{text("间隔", "Interval")}</span>
        <select
          value={draft.intervalMinutes}
          disabled={disabled}
          onChange={(event) => submitChange({
            ...draft,
            intervalMinutes: Number(event.target.value) as IntervalMinutes,
          })}
        >
          {[5, 10, 15, 30, 60].map((minutes) => (
            <option key={minutes} value={minutes}>{text(`${minutes} 分钟`, `${minutes} min`)}</option>
          ))}
        </select>
      </label>
      {models.length > 0 && (
        <label className="project-automation-field">
          <span>{text("认领模型", "Claim model")}</span>
          <input
            type="search"
            className="project-automation-model-filter"
            value={modelFilter}
            onChange={(event) => setModelFilter(event.target.value)}
            placeholder={text("筛选模型…", "Filter models…")}
            aria-label={text("筛选模型", "Filter models")}
          />
          <select
            value={draft.model}
            disabled={disabled}
            onChange={(event) => submitChange({
              ...draft,
              model: event.target.value,
            })}
          >
            <option value="">{text("跟随默认", "Follow default")}</option>
            {filteredModelGroups.map(([provider, choices]) => (
              <optgroup key={provider} label={provider}>
                {choices.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice.slice(choice.indexOf("::") + 2)}
                  </option>
                ))}
              </optgroup>
            ))}
            {filteredPlainModels.map((choice) => (
              <option key={choice} value={choice}>{choice}</option>
            ))}
          </select>
        </label>
      )}
      {unavailableReason && <p className="project-automation-note">{unavailableReason}</p>}
      {error && error !== unavailableReason && <p className="project-automation-error" role="alert">{error}</p>}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`project-automation-trigger no-drag ${status === "ACTIVE" ? "is-active" : "is-paused"}`}
        aria-label={status === "ACTIVE"
          ? text("自动认领中", "Auto-claiming")
          : text("自动化", "Automation")}
        aria-busy={pending}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={status === "ACTIVE"
          ? text("自动认领中", "Auto-claiming")
          : text("自动化", "Automation")}
        onClick={() => {
          if (!open) {
            setPosition((current) => ({ ...current, ready: false }));
            onOpen();
          }
          setOpen((current) => !current);
        }}
      >
        <TaskboardIcon name={status === "ACTIVE" ? "automationPause" : "automationPlay"} />
        <span>{status === "ACTIVE"
          ? text("自动认领中", "Auto-claiming")
          : text("自动化", "Automation")}</span>
      </button>
      {menu}
    </>
  );
}
