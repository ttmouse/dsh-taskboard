import { useState, type DragEvent, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { assigneeTargetForActor } from "../actors";
import { taskPriorityLabel, taskStatusLabel, useTaskboardI18n } from "../i18n";
import { labelPresentation } from "../labels";
import type { TaskCardPresentation } from "../taskConversations";
import { TASK_PRIORITIES, TASK_STATUSES, type ActorIdentity, type Task, type TaskDraft, type TaskStatus } from "../types";
import { ActorAvatar } from "./ActorAvatar";
import { StatusIcon } from "./BoardColumn";
import { LinearIcon, LinearPriorityIcon } from "./LinearIcon";
import { TaskConversationMenu } from "./TaskConversationMenu";
import { TaskPropertyPicker } from "./TaskPropertyPicker";
import { TaskboardIcon } from "./TaskboardIcon";

const COLLAPSED_BY_DEFAULT = new Set<TaskStatus>(["backlog", "done", "canceled"]);

interface IssueListViewProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  tasks: Task[];
  presentations: Record<string, TaskCardPresentation>;
  currentUser: ActorIdentity;
  hasActiveFilters: boolean;
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
  onOpenTask,
  onOpenConversation,
  onUpdate,
  onMoveTask,
}: IssueListViewProps) {
  const { language, locale, text } = useTaskboardI18n();
  const [collapsed, setCollapsed] = useState(() => new Set(COLLAPSED_BY_DEFAULT));
  const [priorityMenuTaskId, setPriorityMenuTaskId] = useState<string | null>(null);
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ status: TaskStatus; beforeTaskId: string | null } | null>(null);

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

  /** Drop a dragged row onto a status group at the pointer's position. */
  function handleDrop(event: DragEvent<HTMLElement>, status: TaskStatus) {
    event.preventDefault();
    const taskId =
      event.dataTransfer.getData("application/x-taskboard-task") ||
      event.dataTransfer.getData("text/plain");
    const beforeTaskId = dropBeforeTaskId(event.currentTarget, event.clientY);
    setDropTarget(null);
    setDragTaskId(null);
    if (taskId) onMoveTask(status, taskId, beforeTaskId);
  }

  function toggleStatus(status: TaskStatus) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  return (
    <div className="issue-list-view" ref={scrollRef}>
      <div className="issue-list-groups">
        {TASK_STATUSES.map((status) => {
          const statusTasks = tasks.filter((task) => task.status === status);
          const isCollapsed = collapsed.has(status);
          const statusLabel = taskStatusLabel(language, status);
          return (
            <section
              className={`issue-list-group status-${status}${dropTarget?.status === status ? " is-drop-target" : ""}`}
              key={status}
              onDragOver={(event) => {
                if (dragTaskId === null) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropTarget({ status, beforeTaskId: dropBeforeTaskId(event.currentTarget, event.clientY) });
              }}
              onDragLeave={(event) => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                  setDropTarget((current) => (current?.status === status ? null : current));
                }
              }}
              onDrop={(event) => handleDrop(event, status)}
            >
              <button className="issue-list-group-header" type="button" onClick={() => toggleStatus(status)} aria-expanded={!isCollapsed}>
                <LinearIcon name={isCollapsed ? "chevronRight" : "chevronDown"} />
                <span className="issue-list-status-icon"><StatusIcon status={status} /></span>
                <strong>{statusLabel}</strong>
                <span>{statusTasks.length}</span>
              </button>
              {!isCollapsed && (
                <div className="issue-list-rows">
                  {statusTasks.length ? statusTasks.map((task) => {
                    const assigneeTarget = assigneeTargetForActor(task.assignee, currentUser) ?? "current-user";
                    return (
                      <div
                        className={`issue-list-row${presentations[task.id]?.unread ? " is-unread" : ""}${dragTaskId === task.id ? " is-dragging" : ""}${dropTarget?.status === status && dropTarget.beforeTaskId === task.id ? " is-drop-before" : ""}`}
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
                  }) : (
                    <div className="issue-list-empty">
                      {hasActiveFilters
                        ? text("当前筛选下没有匹配议题", "No issues match the current filters")
                        : text(`没有${statusLabel}议题`, `No ${statusLabel.toLowerCase()} issues`)}
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
