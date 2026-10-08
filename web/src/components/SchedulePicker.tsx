import { useEffect, useMemo, useRef, useState } from "react";

/**
 * 官方自动化面板风格的「运行时间」选择器。
 *
 * 参照 DSH 官方 schedule RuleCard 的行结构：重复（下拉菜单）→ 条件行
 * （每周的星期胶囊 / 每 N 的间隔输入 / 仅一次的日期行 / 自定义的表达式）→ 时间 → 时区。
 * 底层存储仍是 dsh-routines 的 5 字段 cron / every 表达式：
 *
 *   每周     → `M H * * <dow 列表>`
 *   周一至周五 → `M H * * 1-5`
 *   每天     → `M H * * *`
 *   仅一次    → `M H <日> <月> *`（日与月都为字面量的一次性形态）
 *   每 N 小时 → `every Nh`
 *   每 N 分钟 → `every Nm`
 *   自定义   → 原文（cron 宏、步进等调度器支持但选择器不结构化的形态）
 *
 * 「每 N 秒」不提供：@dsh-routines 的 every 最小间隔是 1 分钟
 * （<60s 直接抛错）。
 *
 * 「仅一次」的语义边界：cron 本身没有年份，`M H D Mo *` 严格说是每年重跑；
 * 这里按官方 RuleCard 的「仅一次」（日期 + 时间行）呈现，匹配这类规则的真实
 * 用法（跑完即暂停的一次性任务，如 awesome-dsh-submit-*），写入 YAML 的仍是
 * 原始表达式，日期行的年份仅用于展示。真正的每年重复应使用「自定义」。
 *
 * 解析回填只做「往返一致」的映射：仅当结构化选择序列化后与原表达式
 * 完全相同才展示为结构化行，否则落回「自定义」，保证打开再保存不会
 * 悄悄改变既有例程的调度语义（如 `*\/10 * * * *` 的墙钟对齐）。
 */

type ScheduleKind =
  | "weekly"
  | "weekdays"
  | "daily"
  | "once"
  | "every-hour"
  | "every-minute"
  | "cron";

interface PickerState {
  kind: ScheduleKind;
  /** "HH:MM"，weekly/weekdays/daily/once 用。 */
  time: string;
  /** "YYYY-MM-DD"，once 用（cron 无年份，年份仅用于展示）。 */
  date: string;
  /** ISO 星期 1（周一）..7（周日），weekly 用。 */
  weekdays: number[];
  /** every-* 的数量 N。 */
  interval: number;
  /** cron 原文，cron 用。 */
  expression: string;
}

type Text = (zh: string, en: string) => string;

export interface ScheduleValue {
  schedule: string;
  timezone: string;
}

interface SchedulePickerProps {
  schedule: string;
  timezone: string;
  text: Text;
  onChange: (next: ScheduleValue) => void;
}

const WEEKDAY_LABELS_ZH = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const WEEKDAY_LABELS_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const CHOICES: Array<{ id: ScheduleKind; zh: string; en: string }> = [
  { id: "weekly", zh: "每周", en: "Weekly" },
  { id: "weekdays", zh: "周一至周五", en: "Weekdays" },
  { id: "daily", zh: "每天", en: "Daily" },
  { id: "once", zh: "仅一次", en: "Once" },
  { id: "every-hour", zh: "每 N 小时", en: "Every N hours" },
  { id: "every-minute", zh: "每 N 分钟", en: "Every N minutes" },
  { id: "cron", zh: "自定义", en: "Custom" },
];

function choiceLabel(kind: ScheduleKind, text: Text): string {
  const found = CHOICES.find((choice) => choice.id === kind);
  return found ? text(found.zh, found.en) : kind;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** cron 星期字段（0-7，0 与 7 都是周日）→ ISO 星期集合；不可读返回 null。 */
function expandCronDow(field: string): number[] | null {
  const days = new Set<number>();
  for (const token of field.split(",")) {
    const range = /^(\d+)-(\d+)$/.exec(token.trim());
    const single = /^(\d+)$/.exec(token.trim());
    let from: number, to: number;
    if (range) {
      from = Number(range[1]);
      to = Number(range[2]);
    } else if (single) {
      from = to = Number(single[1]);
    } else {
      return null;
    }
    if (from < 0 || to > 7 || from > to) return null;
    for (let value = from; value <= to; value++) days.add(value === 0 ? 7 : value);
  }
  return [...days].sort((left, right) => left - right);
}

/** ISO 星期集合 → cron 星期字段（周日归 0，升序）。 */
function isoDaysToCronField(days: number[]): string {
  return [...days]
    .map((day) => (day === 7 ? 0 : day))
    .sort((left, right) => left - right)
    .join(",");
}

/** "HH:MM" → cron 的 `分 时` 片段。 */
function timeToCronPrefix(time: string): string | null {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${minute} ${hour}`;
}

/** 本机今天的 ISO 日期（YYYY-MM-DD），once 新建时的默认展示年份。 */
function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** "YYYY-MM-DD" → 校验后的 {day, month}；不合法返回 null（不产生语义含糊的 cron）。 */
function onceDateParts(date: string): { day: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { day, month };
}

export function serializePickerState(state: PickerState): string {
  switch (state.kind) {
    case "daily": {
      const prefix = timeToCronPrefix(state.time);
      return prefix ? `${prefix} * * *` : "0 9 * * *";
    }
    case "weekdays": {
      const prefix = timeToCronPrefix(state.time);
      return prefix ? `${prefix} * * 1-5` : "0 9 * * 1-5";
    }
    case "weekly": {
      const prefix = timeToCronPrefix(state.time);
      const field = state.weekdays.length > 0 ? isoDaysToCronField(state.weekdays) : "1";
      return prefix ? `${prefix} * * ${field}` : `0 9 * * ${field}`;
    }
    case "once": {
      const parts = onceDateParts(state.date);
      const prefix = timeToCronPrefix(state.time);
      if (!parts || !prefix) return "0 9 1 1 *";
      return `${prefix} ${parts.day} ${parts.month} *`;
    }
    case "every-hour":
      return `every ${Math.max(1, state.interval)}h`;
    case "every-minute":
      return `every ${Math.max(1, state.interval)}m`;
    case "cron":
      return state.expression.trim();
  }
}

/**
 * 把既有 schedule 表达式解析回结构化选择；只有序列化后与原文完全一致
 * 才返回结构化状态，否则返回 null（调用方落回「自定义」）。
 */
export function parsePickerState(schedule: string): PickerState | null {
  const raw = schedule.trim().toLowerCase();
  if (!raw) return null;
  const every = /^every\s+(\d+)\s*(m|h)$/.exec(raw);
  if (every) {
    const interval = Number(every[1]);
    if (!Number.isSafeInteger(interval) || interval < 1) return null;
    const kind: ScheduleKind = every[2] === "h" ? "every-hour" : "every-minute";
    const state: PickerState = { kind, time: "09:00", date: todayIso(), weekdays: [1, 2, 3, 4, 5], interval, expression: raw };
    return serializePickerState(state) === raw ? state : null;
  }
  const fields = raw.split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
  const hh = Number(hour);
  const mm = Number(minute);
  if (hh > 23 || mm > 59) return null;
  const time = `${pad2(hh)}:${pad2(mm)}`;
  // 仅一次：日与月都是字面量（每年固定一天，实际用法即一次性任务）。
  if (/^\d+$/.test(dayOfMonth) && /^\d+$/.test(month) && dayOfWeek === "*") {
    const day = Number(dayOfMonth);
    const mon = Number(month);
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      const once: PickerState = {
        kind: "once",
        time,
        date: `${todayIso().slice(0, 4)}-${pad2(mon)}-${pad2(day)}`,
        weekdays: [1, 2, 3, 4, 5],
        interval: 1,
        expression: raw,
      };
      return serializePickerState(once) === raw ? once : null;
    }
    return null;
  }
  if (dayOfMonth !== "*" || month !== "*") return null;
  const base: PickerState = { kind: "daily", time, date: todayIso(), weekdays: [1, 2, 3, 4, 5], interval: 1, expression: raw };
  if (dayOfWeek === "*") {
    return serializePickerState({ ...base, kind: "daily" }) === raw ? { ...base, kind: "daily" } : null;
  }
  if (dayOfWeek === "1-5") {
    return serializePickerState({ ...base, kind: "weekdays" }) === raw ? { ...base, kind: "weekdays" } : null;
  }
  const days = expandCronDow(dayOfWeek);
  if (days && days.length > 0) {
    const weekly: PickerState = { ...base, kind: "weekly", weekdays: days };
    return serializePickerState(weekly) === raw ? weekly : null;
  }
  return null;
}

function cronChoice(expression: string): PickerState {
  return { kind: "cron", time: "09:00", date: todayIso(), weekdays: [1, 2, 3, 4, 5], interval: 10, expression };
}

// ---- 时区 ----

function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** IANA 时区当前 UTC 偏移（分钟）；未知时区返回 null。 */
function tzOffsetMinutes(timeZone: string, at = Date.now()): number | null {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts: Record<string, string> = {};
    for (const part of dtf.formatToParts(new Date(at))) {
      if (part.type !== "literal") parts[part.type] = part.value;
    }
    const asUTC = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      parts.hour === "24" ? 0 : Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    return Math.round((asUTC - at) / 60_000);
  } catch {
    return null;
  }
}

/** 「UTC+08:00 · 中国标准时间」风格的时区标签。 */
export function zoneLabel(zone: string, at = Date.now()): string {
  const offset = tzOffsetMinutes(zone, at);
  const prefix = offset === null
    ? ""
    : `UTC${offset < 0 ? "-" : "+"}${pad2(Math.floor(Math.abs(offset) / 60))}:${pad2(Math.abs(offset) % 60)}`;
  try {
    const name = new Intl.DateTimeFormat("zh-CN", { timeZone: zone, timeZoneName: "longGeneric" })
      .formatToParts(new Date(at))
      .find((part) => part.type === "timeZoneName")?.value ?? "";
    const clean = /^GMT/.test(name) ? zone : name;
    return prefix ? `${prefix} · ${clean}` : clean || zone;
  } catch {
    return prefix || zone;
  }
}

/** 菜单时区清单：本机时区置顶，其余按当前偏移、id 排序。 */
function zoneCatalog(system: string, at: number): string[] {
  let inventory: string[];
  try {
    inventory = Intl.supportedValuesOf("timeZone");
  } catch {
    inventory = ["UTC", "Asia/Shanghai", "Asia/Tokyo", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles"];
  }
  const zones = [...new Set([system, ...inventory])];
  return zones
    .map((zone) => ({ zone, offset: tzOffsetMinutes(zone, at) ?? Number.POSITIVE_INFINITY }))
    .sort((left, right) => (left.offset !== right.offset ? left.offset - right.offset : left.zone < right.zone ? -1 : 1))
    .map((entry) => entry.zone);
}

// ---- 下拉菜单 ----

interface MenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  /** 菜单最大高度，用于向上翻转估算。 */
  maxHeight?: number;
  children: React.ReactNode;
}

/** 固定定位菜单：贴着触发按钮展开，向上翻转，Escape 优先关闭且不冒泡。 */
function DropdownMenu({ open, onClose, anchorRef, maxHeight = 300, children }: MenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.max(rect.width, 200);
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const below = rect.bottom + 6;
    const top = below + Math.min(maxHeight, 320) > window.innerHeight
      ? Math.max(8, rect.top - Math.min(maxHeight, 320) - 6)
      : below;
    setPos({ top, left, width });
  }, [open, anchorRef, maxHeight]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, onClose, anchorRef]);

  if (!open || !pos) return null;
  return (
    <div
      ref={menuRef}
      className="sched-menu"
      style={{ top: pos.top, left: pos.left, width: pos.width }}
      role="menu"
    >
      {children}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M4 6.2 8 10.2l4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" className="sched-check">
      <path d="M3.4 8.6 6.4 11.4 12.6 4.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---- 主组件 ----

export function SchedulePicker({ schedule, timezone, text, onChange }: SchedulePickerProps) {
  /** 选择状态只在挂载时从 props 种一次；此后由本组件掌管并回调。 */
  const [state, setState] = useState<PickerState>(() => parsePickerState(schedule) ?? cronChoice(schedule));
  const [zone, setZone] = useState(() => timezone || systemTimeZone());
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [zoneOpen, setZoneOpen] = useState(false);
  const [zoneQuery, setZoneQuery] = useState("");
  const repeatRef = useRef<HTMLButtonElement | null>(null);
  const zoneRef = useRef<HTMLButtonElement | null>(null);
  const systemZone = useMemo(systemTimeZone, []);

  const emit = (next: PickerState, nextZone: string) => {
    onChange({ schedule: serializePickerState(next), timezone: nextZone });
  };

  const update = (patch: Partial<PickerState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      emit(next, zone);
      return next;
    });
  };

  const chooseKind = (kind: ScheduleKind) => {
    setRepeatOpen(false);
    update({
      kind,
      interval: kind === "every-hour" ? 1 : kind === "every-minute" ? 30 : state.interval,
      weekdays: kind === "weekly" && state.weekdays.length === 0 ? [1, 2, 3, 4, 5] : state.weekdays,
      date: state.date || todayIso(),
    });
  };

  const chooseZone = (next: string) => {
    setZoneOpen(false);
    setZoneQuery("");
    setZone(next);
    emit(state, next);
  };

  const zoneLabelCache = useMemo(() => {
    const at = Date.now();
    const catalog = zoneCatalog(systemZone, at);
    return catalog.map((zone) => ({ zone, label: zoneLabel(zone, at) }));
  }, [systemZone]);

  const query = zoneQuery.trim().toLowerCase();
  const zoneItems = query
    ? zoneLabelCache.filter((item) => `${item.zone} ${item.label}`.toLowerCase().includes(query))
    : zoneLabelCache;

  const isClockKind = state.kind === "daily" || state.kind === "weekdays" || state.kind === "weekly" || state.kind === "once";

  return (
    <div className="sched-picker">
      {/* 重复 */}
      <div className="sched-row">
        <span className="sched-row-label">{text("重复", "Repeat")}</span>
        <button
          ref={repeatRef}
          type="button"
          className="sched-face"
          aria-haspopup="menu"
          aria-expanded={repeatOpen}
          onClick={() => setRepeatOpen((open) => !open)}
        >
          <span>{choiceLabel(state.kind === "every-hour" ? "every-hour" : state.kind, text)}</span>
          <ChevronIcon />
        </button>
      </div>
      <DropdownMenu open={repeatOpen} onClose={() => setRepeatOpen(false)} anchorRef={repeatRef} maxHeight={280}>
        {CHOICES.map((choice) => (
          <button
            key={choice.id}
            type="button"
            role="menuitemradio"
            aria-checked={state.kind === choice.id}
            className={`sched-menu-item${state.kind === choice.id ? " is-selected" : ""}`}
            onClick={() => chooseKind(choice.id)}
          >
            <span>{text(choice.zh, choice.en)}</span>
            {state.kind === choice.id && <CheckIcon />}
          </button>
        ))}
      </DropdownMenu>

      {/* 每周 → 星期胶囊 */}
      {state.kind === "weekly" && (
        <div className="sched-row sched-row-top">
          <span className="sched-row-label">{text("星期", "Weekdays")}</span>
          <div className="sched-weekdays" role="group" aria-label={text("星期", "Weekdays")}>
            {WEEKDAY_LABELS_ZH.map((label, index) => {
              const iso = index + 1;
              const active = state.weekdays.includes(iso);
              return (
                <button
                  key={iso}
                  type="button"
                  className={`sched-pill${active ? " is-active" : ""}`}
                  aria-pressed={active}
                  title={text(WEEKDAY_LABELS_ZH[index], WEEKDAY_LABELS_EN[index])}
                  onClick={() => {
                    const next = active
                      ? state.weekdays.filter((day) => day !== iso)
                      : [...state.weekdays, iso].sort((left, right) => left - right);
                    update({ weekdays: next });
                  }}
                >
                  {text(label.slice(1), WEEKDAY_LABELS_EN[index])}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 每 N → 间隔输入 */}
      {(state.kind === "every-hour" || state.kind === "every-minute") && (
        <div className="sched-row sched-row-top">
          <span className="sched-row-label">{text("间隔", "Interval")}</span>
          <span className="sched-interval">
            <input
              type="number"
              min={1}
              step={1}
              value={state.interval}
              aria-label={text("间隔", "Interval")}
              onChange={(event) => {
                const value = Number(event.target.value);
                update({ interval: Number.isSafeInteger(value) && value >= 1 ? value : 1 });
              }}
            />
            <span className="sched-interval-unit">
              {state.kind === "every-hour" ? text("小时", "hours") : text("分钟", "minutes")}
            </span>
          </span>
        </div>
      )}

      {/* 自定义 → cron 表达式 */}
      {state.kind === "cron" && (
        <div className="sched-row sched-row-top">
          <span className="sched-row-label">{text("表达式", "Expression")}</span>
          <input
            type="text"
            className="sched-input sched-input-mono"
            value={state.expression}
            placeholder="*/10 * * * *"
            aria-label={text("cron 表达式", "cron expression")}
            onChange={(event) => update({ expression: event.target.value })}
          />
        </div>
      )}

      {/* 仅一次 → 日期 */}
      {state.kind === "once" && (
        <div className="sched-row sched-row-top">
          <label className="sched-row-label" htmlFor="sched-date-input">{text("日期", "Date")}</label>
          <input
            id="sched-date-input"
            type="date"
            className="sched-input sched-input-time"
            value={state.date}
            aria-label={text("日期", "Date")}
            onChange={(event) => {
              // 允许清空后再选：无效值不落状态，也不改写调度语义。
              if (event.target.value) update({ date: event.target.value });
            }}
          />
        </div>
      )}

      {/* 时间 */}
      {isClockKind && (
        <div className="sched-row">
          <label className="sched-row-label" htmlFor="sched-time-input">{text("时间", "Time")}</label>
          <input
            id="sched-time-input"
            type="time"
            className="sched-input sched-input-time"
            value={state.time}
            onChange={(event) => {
              if (event.target.value) update({ time: event.target.value });
            }}
          />
        </div>
      )}

      {/* 时区 */}
      <div className="sched-row">
        <span className="sched-row-label">{text("时区", "Timezone")}</span>
        <button
          ref={zoneRef}
          type="button"
          className="sched-face"
          aria-haspopup="menu"
          aria-expanded={zoneOpen}
          onClick={() => {
            setZoneQuery("");
            setZoneOpen((open) => !open);
          }}
        >
          <span className="sched-face-value">{zoneLabel(zone)}</span>
          <ChevronIcon />
        </button>
      </div>
      <DropdownMenu open={zoneOpen} onClose={() => setZoneOpen(false)} anchorRef={zoneRef} maxHeight={320}>
        <input
          type="search"
          className="sched-zone-search"
          autoFocus
          value={zoneQuery}
          placeholder={text("搜索时区…", "Search time zones…")}
          aria-label={text("搜索时区", "Search time zones")}
          onChange={(event) => setZoneQuery(event.target.value)}
          onKeyDown={(event) => {
            // 搜索框内 Escape 交给菜单关闭，不冒泡到详情对话框。
            if (event.key === "Escape") event.stopPropagation();
          }}
        />
        <div className="sched-zone-list">
          {zoneItems.length === 0 ? (
            <div className="sched-zone-empty">{text("没有匹配的时区", "No matching time zones")}</div>
          ) : (
            zoneItems.map((item) => (
              <button
                key={item.zone}
                type="button"
                role="menuitemradio"
                aria-checked={zone === item.zone}
                className={`sched-menu-item${zone === item.zone ? " is-selected" : ""}`}
                title={item.zone}
                onClick={() => chooseZone(item.zone)}
              >
                <span>
                  {item.label}
                  {item.zone === systemZone && <span className="sched-zone-system"> · {text("本机", "local")}</span>}
                </span>
                {zone === item.zone && <CheckIcon />}
              </button>
            ))
          )}
        </div>
      </DropdownMenu>
    </div>
  );
}
