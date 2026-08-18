import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
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
  /** 供应商 id → 显示名（如 opencode、DeepSeek）。 */
  modelLabels?: Record<string, string>;
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
  modelLabels,
  onOpen,
  onChange,
}: ProjectAutomationMenuProps) {
  const { text } = useTaskboardI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasPendingRef = useRef(pending);
  /** 用户是否在本次打开期间改过任何选项：true 时请求完成不再回填 draft，
   *  避免 onOpen 的 reconcile 用旧值覆盖用户正在进行的编辑（"开了又弹回"）。 */
  const dirtyRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const [draft, setDraft] = useState<AutomationOptions>(DEFAULT_OPTIONS);
  const [modelFilter, setModelFilter] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [modelFocused, setModelFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const modelListRef = useRef<HTMLDivElement>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
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

  /** 供应商显示名：优先 label（如 opencode），退回路由 id。 */
  const providerLabel = (provider: string): string => modelLabels?.[provider] ?? provider;

  /** 扁平化的列表项（组标签 + 可选项），用于渲染和键盘导航。 */
  const listItems: Array<
    { kind: "group"; label: string }
    | { kind: "option"; value: string; label: string; index: number }
  > = [];
  {
    let counter = 0;
    listItems.push({ kind: "option", value: "", label: text("跟随默认", "Follow default"), index: counter++ });
    for (const [provider, choices] of filteredModelGroups) {
      listItems.push({ kind: "group", label: providerLabel(provider) });
      for (const choice of choices) {
        listItems.push({
          kind: "option",
          value: choice,
          label: choice.slice(choice.indexOf("::") + 2),
          index: counter++,
        });
      }
    }
    for (const choice of filteredPlainModels) {
      listItems.push({ kind: "option", value: choice, label: choice, index: counter++ });
    }
  }
  const keyboardOptions = listItems.filter((item): item is { kind: "option"; value: string; label: string; index: number } => item.kind === "option");

  /** 打开/筛选变化时，把高亮定位到当前选中的选项（或第一项）。 */
  useEffect(() => {
    if (!modelOpen) return;
    const selected = keyboardOptions.findIndex((option) => option.value === draft.model);
    setActiveIndex(selected >= 0 ? selected : 0);
  }, [modelOpen, modelFilter]);

  /** 高亮项滚动进可视区。 */
  useEffect(() => {
    if (!modelOpen) return;
    modelListRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, modelOpen]);

  const handleModelKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setModelOpen(true);
      setActiveIndex((current) => Math.min(current + 1, keyboardOptions.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(keyboardOptions.length - 1);
    } else if (event.key === "Enter") {
      const option = keyboardOptions[activeIndex];
      if (modelOpen && option !== undefined) {
        event.preventDefault();
        selectModel(option.value);
      }
    } else if (event.key === "Escape") {
      setModelOpen(false);
    }
  };

  /** 展示名：供应商显示名 / 模型。 */
  const modelDisplayName = (choice: string): string => {
    const separator = choice.indexOf("::");
    return separator >= 0
      ? `${providerLabel(choice.slice(0, separator))} / ${choice.slice(separator + 2)}`
      : choice;
  };

  /** 选中一个模型（"" = 跟随默认），关闭列表、失焦并清空筛选。 */
  const selectModel = (choice: string): void => {
    if (disabled) return;
    setModelOpen(false);
    setModelFilter("");
    modelInputRef.current?.blur();
    submitChange({ ...draft, model: choice });
  };

  useEffect(() => {
    if (!open) return;
    dirtyRef.current = false;
    setDraft({ ...DEFAULT_OPTIONS, ...automation });
    setModelFilter("");
    setModelOpen(false);
  }, [open]);

  useEffect(() => {
    if (wasPendingRef.current && !pending && !dirtyRef.current) {
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
    function closeFromViewportChange(event: Event) {
      // Only the document/viewport scroll closes the menu. Inner scrollable
      // elements (the model list) fire capture-phase scroll events too and
      // must stay wheel-scrollable.
      if (event.target !== document) return;
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
    dirtyRef.current = true;
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
        <label className="project-automation-field project-automation-field-model">
          <span>{text("认领模型", "Claim model")}</span>
          <div className="project-automation-combobox">
            <input
              ref={modelInputRef}
              type="search"
              className="project-automation-model-filter"
              value={modelFocused || modelFilter !== ""
                ? modelFilter
                : draft.model
                  ? modelDisplayName(draft.model)
                  : ""}
              disabled={disabled}
              onChange={(event) => {
                setModelFilter(event.target.value);
                setModelOpen(true);
              }}
              onFocus={() => {
                setModelFocused(true);
                if (!disabled) setModelOpen(true);
              }}
              onBlur={() => setModelFocused(false)}
              onKeyDown={handleModelKeyDown}
              placeholder={text("选择或搜索模型…", "Select or search model…")}
              aria-label={text("认领模型", "Claim model")}
              aria-expanded={modelOpen}
              aria-activedescendant={modelOpen && keyboardOptions[activeIndex] !== undefined
                ? `model-option-${activeIndex}`
                : undefined}
              role="combobox"
            />
            {modelOpen && !disabled && (
              <div className="project-automation-model-list" ref={modelListRef} role="listbox">
                {listItems.map((item) => item.kind === "group" ? (
                  <div key={item.label} className="project-automation-model-group-label">{item.label}</div>
                ) : (
                  <button
                    key={item.value}
                    type="button"
                    role="option"
                    id={`model-option-${item.index}`}
                    aria-selected={draft.model === item.value}
                    data-active={item.index === activeIndex}
                    className={[
                      "project-automation-model-option",
                      draft.model === item.value ? "is-selected" : "",
                      item.index === activeIndex ? "is-active" : "",
                    ].filter(Boolean).join(" ")}
                    onClick={() => selectModel(item.value)}
                    onMouseEnter={() => setActiveIndex(item.index)}
                  >
                    {item.label}
                  </button>
                ))}
                {keyboardOptions.length === 0 && (
                  <div className="project-automation-model-empty">{text("没有匹配的模型。", "No matching models.")}</div>
                )}
              </div>
            )}
          </div>
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
