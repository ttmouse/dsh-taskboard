import { useState, type DragEvent, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { assigneeTargetForActor } from "../actors";
import { taskPriorityLabel, taskStatusLabel, useTaskboardI18n } from "../i18n";
import { labelPresentation } from "../labels";
import type { TaskCardPresentation } from "../taskConversations";
import { TASK_PRIORITIES, type ActorIdentity, type Task, type TaskDraft, type TaskStatus } from "../types";
import { BOARD_LANES, LANE_LABELS, WAITING_REASON_LABELS, isLaneVisible, laneSegmentHeadingNeeded, type BoardLane, type BoardLaneId } from "../boardColumns";
import { ActorAvatar } from "./ActorAvatar";
import { StatusIcon } from "./BoardColumn";
import { LinearIcon, LinearPriorityIcon } from "./LinearIcon";
import { TaskConversationMenu } from "./TaskConversationMenu";
import { TaskPropertyPicker } from "./TaskPropertyPicker";
import { TaskboardIcon } from "./TaskboardIcon";

/**
 * 侧栏列表与看板共用同一套列模型（web/src/boardColumns.ts）：列回答
 * 「现在该谁动」，所以这里也按列分组，不再按 7 个状态各开一组。
 * 默认收起的是终态和需求池——它们不该跟待办同权重。
 */
const COLLAPSED_BY_DEFAULT = new Set<BoardLaneId>(["finished", "parked"]);

interface IssueListViewProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  tasks: Task[];
  presentations: Record<string, TaskCardPresentation>;
  currentUser: ActorIdentity;
  hasActiveFilters: boolean;
  /** projectId → 项目名；「全局」聚合视图传入，用于标注所属项目。 */
  projectNames?: Record<string, string>;
  onOpenTask: (task: Task) => void;
  onOpenConversation: (conversation: TaskCardPresentation["conversations"][number]) => void;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
  /** Drag & drop: move a task into a status group, optionally before a row. */
  onMoveTask: (status: TaskStatus, taskId: string, beforeTaskId?: string | null) => void;
}

function createdDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(value));
}

function calendarDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" })
    .format(new Date(`${value}T12:00:00`));
}

export function IssueListView({
  scrollRef,
  tasks,
  presentations,
  currentUser,
  hasActiveFilters,
  projectNames,
  onOpenTask,
  onOpenConversation,
  onUpdate,
  onMoveTask,
}: IssueListViewProps) {
  const { language, locale, text } = useTaskboardI18n();
  const [collapsed, setCollapsed] = useState(() => new Set(COLLAPSED_BY_DEFAULT));
  const [priorityMenuTaskId, setPriorityMenuTaskId] = useState<string | null>(null);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ lane: BoardLaneId; beforeTaskId: string | null } | null>(null);

  // 与看板同一条规则（isLaneVisible）：空列不占位置，只有「等你」例外。
  const visibleLanes = BOARD_LANES.filter((lane) => isLaneVisible(
    lane,
    lane.statuses.some((status) => tasks.some((task) => task.status === status)),
  ));

  function stopRow(event: MouseEvent | KeyboardEvent) {
    event.stopPropagation();
  }

  /**
   * Row the pointer sits above inside a group: the dragged row itself is
   * skipped, and `null` means "after every row" (append). Mirrors the board
   * column's insertion rule so both surfaces order tasks the same way.
   */
  function dropBeforeTaskId(container: HTMLElement, clientY: number): string | null {
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-task-id]"))
      .filter((row) => row.dataset.taskId !== dragTaskId);
    const hit = rows.find((row) => clientY < row.getBoundingClientRect().top + row.offsetHeight / 2);
    return hit?.dataset.taskId ?? null;
  }

  /** Drop a dragged row onto a lane at the pointer's position. */
  function handleDrop(event: DragEvent<HTMLElement>, lane: BoardLane) {
    event.preventDefault();
    const taskId =
      event.dataTransfer.getData("application/x-taskboard-task") ||
      event.dataTransfer.getData("text/plain");
    const beforeTaskId = dropBeforeTaskId(event.currentTarget, event.clientY);
    setDropTarget(null);
    setDragTaskId(null);
    if (taskId) onMoveTask(resolveDropStatus(lane, taskId, beforeTaskId), taskId, beforeTaskId);
  }

  function toggleLane(lane: BoardLaneId) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(lane)) next.delete(lane);
      else next.add(lane);
      return next;
    });
  }

  /**
   * 一行落在哪条状态上。单状态列直接返回它；「等你」要按落点判断：
   * 插在某行前面就沿用那行的现状，落在段尾则沿用被拖行自己的现状
   * （同列内换位置不该偷偷改状态）。
   */
  function resolveDropStatus(lane: BoardLane, taskId: string, beforeTaskId: string | null): TaskStatus {
    if (lane.statuses.length === 1) return lane.statuses[0];
    if (beforeTaskId !== null) {
      const target = tasks.find((task) => task.id === beforeTaskId);
      if (target) return target.status;
    }
    return tasks.find((task) => task.id === taskId)?.status ?? lane.statuses[0];
  }

  return (
    <div className="issue-list-view" ref={scrollRef}>
      <div className="issue-list-groups">
        {visibleLanes.map((lane) => {
          const laneTasks = lane.statuses.flatMap((status) => tasks.filter((task) => task.status === status));
          const isCollapsed = collapsed.has(lane.id);
          const label = text(LANE_LABELS[lane.id].zh, LANE_LABELS[lane.id].en);
          // 「等你」把待验收和被阻塞并在一组，组内按来源分段：
          // 组回答「该谁动」，段回答「为什么」。
          // 同看板：只有一种东西时不说段名，否则就是重复列名。
          const segmented = lane.statuses.filter((status) => tasks.some((task) => task.status === status)).length > 1;
          return (
            <section
              className={`issue-list-group lane-${lane.id} status-${lane.statuses[0]}${dropTarget?.lane === lane.id ? " is-drop-target" : ""}`}
              key={lane.id}
              onDragOver={(event) => {
                if (dragTaskId === null) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropTarget({ lane: lane.id, beforeTaskId: dropBeforeTaskId(event.currentTarget, event.clientY) });
              }}
              onDragLeave={(event) => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                  setDropTarget((current) => (current?.lane === lane.id ? null : current));
                }
              }}
              onDrop={(event) => handleDrop(event, lane)}
            >
              <button className="issue-list-group-header" type="button" onClick={() => toggleLane(lane.id)} aria-expanded={!isCollapsed}>
                <LinearIcon name={isCollapsed ? "chevronRight" : "chevronDown"} />
                <span className="issue-list-status-icon"><StatusIcon status={lane.statuses[0]} /></span>
                <strong>{label}</strong>
                <span>{laneTasks.length}</span>
              </button>
              {!isCollapsed && (
                <div className="issue-list-rows">
                  {/* 空态是「这一列没有东西」，不是「这个状态没有东西」：
                      合并列有两个状态，按状态渲染就会印两遍同一句话。 */}
                  {laneTasks.length === 0 && (
                    <div className="issue-list-empty">
                      {hasActiveFilters
                        ? text("当前筛选下没有匹配议题", "No issues match the current filters")
                        : text(`没有${label}议题`, `No ${label.toLowerCase()} issues`)}
                    </div>
                  )}
                  {laneTasks.length > 0 && lane.statuses.map((status) => {
                    const statusTasks = tasks.filter((task) => task.status === status);
                    if (segmented && statusTasks.length === 0) return null;
                    return (
                      <div className="issue-list-segment" key={status}>
                        {segmented && laneSegmentHeadingNeeded(lane.id, status) && (
                          <div className="issue-list-segment-heading">
                            <span className="issue-list-segment-label">
                              {WAITING_REASON_LABELS[status]
                                ? text(WAITING_REASON_LABELS[status]!.zh, WAITING_REASON_LABELS[status]!.en)
                                : taskStatusLabel(language, status)}
                            </span>
                            <span className="issue-list-segment-count">{statusTasks.length}</span>
                          </div>
                        )}
                        {statusTasks.length ? statusTasks.map((task) => {
const assigneeTarget = assigneeTargetForActor(task.assignee, currentUser) ?? "current-user";
                    return (
                      <div
                        className={`issue-list-row${presentations[task.id]?.unread ? " is-unread" : ""}${dragTaskId === task.id ? " is-dragging" : ""}${dropTarget?.beforeTaskId === task.id ? " is-drop-before" : ""}`}
                        role="button"
                        tabIndex={0}
                        draggable
                        data-task-id={task.id}
                        key={task.id}
                        onDragStart={(event) => {
                          setDragTaskId(task.id);
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("application/x-taskboard-task", task.id);
                          event.dataTransfer.setData("text/plain", task.id);
                        }}
                        onDragEnd={() => {
                          setDragTaskId(null);
                          setDropTarget(null);
                        }}
                        onClick={() => onOpenTask(task)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") onOpenTask(task);
                        }}
                      >
                        <span className="issue-list-title-cell">
                          <small>{task.identifier}</small>
                          {projectNames?.[task.projectId] && (
                            <small className="card-project-chip" title={`所属项目：${projectNames[task.projectId]}`}>{projectNames[task.projectId]}</small>
                          )}
                          <strong>{task.title}</strong>
                          {presentations[task.id]?.unread && <span className="task-unread-dot" aria-label={text("有未读更新", "Unread updates")} />}
                        </span>
                        <span className="issue-list-metadata" aria-label={text("议题属性", "Issue properties")}>
                          <span className="issue-list-priority-control" onClick={stopRow} onKeyDown={stopRow}>
                            <TaskPropertyPicker
                              value={task.priority}
                              options={TASK_PRIORITIES.map((priority) => ({
                                value: priority,
                                label: taskPriorityLabel(language, priority),
                                icon: <LinearPriorityIcon priority={priority} />,
                                className: `priority-${priority}`,
                              }))}
                              open={priorityMenuTaskId === task.id}
                              className="issue-list-property-picker"
                              triggerClassName={`issue-list-priority priority-${task.priority}`}
                              ariaLabel={text(`${task.identifier} 优先级`, `${task.identifier} priority`)}
                              onOpenChange={(open) => setPriorityMenuTaskId(open ? task.id : null)}
                              onChange={(priority) => void onUpdate(task, { priority }).catch(() => {})}
                            />
                          </span>
                          <span className="issue-list-labels">
                            {task.labels.slice(0, 2).map((label) => {
                              const presentation = labelPresentation(label, language);
                              return (
                                <i className={presentation.tone ? `tone-${presentation.tone}` : ""} key={label}>
                                  {presentation.tone && <span aria-hidden="true" />}
                                  <b>{presentation.name}</b>
                                </i>
                              );
                            })}
                            {task.labels.length > 2 && <b>+{task.labels.length - 2}</b>}
                          </span>
                          {task.dueDate && (
                            <label className="issue-list-date" onClick={stopRow}>
                              <TaskboardIcon name="calendar" />
                              <span>{calendarDate(task.dueDate, locale)}</span>
                              <input
                                type="date"
                                aria-label={text(`${task.identifier} 截止日期`, `${task.identifier} due date`)}
                                value={task.dueDate}
                                onChange={(event) => void onUpdate(task, {
                                  dueDate: event.target.value || null,
                                  ...(event.target.value ? {} : { recurrence: null }),
                                }).catch(() => {})}
                              />
                            </label>
                          )}
                          <TaskConversationMenu
                            conversations={presentations[task.id]?.conversations ?? []}
                            onOpenConversation={onOpenConversation}
                          />
                          <label className="issue-list-assignee" title={task.assignee.name} onClick={stopRow}>
                            <ActorAvatar actor={task.assignee} />
                            <select
                              aria-label={text(`${task.identifier} 负责人`, `${task.identifier} assignee`)}
                              value={assigneeTarget}
                              onChange={(event) => void onUpdate(task, { assigneeTarget: event.target.value as "current-user" | "codex-agent" }).catch(() => {})}
                            >
                              <option value="current-user">{currentUser.name}</option>
                              <option value="codex-agent">AI Agent</option>
                            </select>
                          </label>
                        </span>
                        <time
                          dateTime={task.createdAt}
                          title={text(
                            `创建于 ${new Date(task.createdAt).toLocaleString(locale)}`,
                            `Created ${new Date(task.createdAt).toLocaleString(locale)}`,
                          )}
                        >
                          {createdDate(task.createdAt, locale)}
                        </time>
                      </div>
                    );
                        }) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
