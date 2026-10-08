import { useEffect, useState } from "react";
import type { DragEvent } from "react";
import { TASK_STATUSES, type Task, type TaskStatus } from "../types";
import { LANE_LABELS, WAITING_REASON_LABELS, laneSegmentHeadingNeeded, type BoardLane, type BoardLaneId } from "../boardColumns";
import { ColumnVisibilityMenu } from "./ColumnVisibilityMenu";
import { TaskCard } from "./TaskCard";
import {
  TaskboardIcon,
  type TaskboardIconName,
} from "./TaskboardIcon";

export const STATUS_DETAILS: Record<
  TaskStatus,
  { label: string; tone: string }
> = {
  backlog: { label: "积压事项", tone: "backlog" },
  todo: { label: "待办事项", tone: "todo" },
  in_progress: { label: "进行中", tone: "progress" },
  in_review: { label: "审核中", tone: "review" },
  blocked: { label: "已阻塞", tone: "blocked" },
  done: { label: "完成", tone: "done" },
  canceled: { label: "已取消", tone: "canceled" },
};

const STATUS_ICONS: Record<TaskStatus, TaskboardIconName> = {
  backlog: "statusTodo",
  todo: "statusTodo",
  in_progress: "statusProgress",
  in_review: "statusReview",
  blocked: "statusBlocked",
  done: "statusReview",
  canceled: "statusBlocked",
};

const COLUMN_STATUS_ICONS: Record<TaskStatus, TaskboardIconName> = {
  backlog: "statusTodo",
  todo: "columnStatusTodo",
  in_progress: "columnStatusProgress",
  in_review: "columnStatusReview",
  blocked: "columnStatusBlocked",
  done: "statusReview",
  canceled: "statusBlocked",
};

const COLUMN_ADD_ICONS: Partial<Record<TaskStatus, TaskboardIconName>> = {
  todo: "columnAddTodo",
  in_progress: "columnAddProgress",
  in_review: "columnAddReview",
  blocked: "columnAddBlocked",
};

export function StatusIcon({ status }: { status: TaskStatus }) {
  return <TaskboardIcon name={STATUS_ICONS[status]} />;
}

function ColumnStatusIcon({ status }: { status: TaskStatus }) {
  return <TaskboardIcon name={COLUMN_STATUS_ICONS[status]} />;
}

interface BoardColumnProps {
  /** 这条列是什么（决定标题、图标、默认折叠与「+」落到哪个状态）。 */
  lane: BoardLane;
  /** 这条列收拢哪些状态（「等你」= 待验收 + 被阻塞）。 */
  statuses: readonly TaskStatus[];
  tasks: Task[];
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  isDropTarget: boolean;
  draggedTaskId: string | null;
  draggedTaskHeight: number;
  movingTaskId: string | null;
  settlingTaskId: string | null;
  contextMenuTaskId: string | null;
  /** projectId → 项目名；「全局」聚合视图传入，用于在卡片上标注所属项目。 */
  projectNames?: Record<string, string>;
  /** 是否显示列内「+」新建议题入口（「全局」聚合视图没有落点项目，隐藏）。 */
  canCreate?: boolean;
  onCreate: (status: TaskStatus) => void;
  onEdit: (task: Task) => void;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onDragEnter: (status: TaskStatus) => void;
  onDrop: (status: TaskStatus, taskId: string, beforeTaskId: string | null) => void;
  onOpenThread: (threadId: string) => void;
  onHide: () => void;
  onComplete?: (task: Task) => void;
}

/** 列标题来自共享的列模型；这里只补一个代表性状态（取图标与色调）。 */
const LANE_SAMPLE_STATUS: Record<BoardLaneId, TaskStatus> = {
  you: "in_review",
  running: "in_progress",
  queued: "todo",
  finished: "done",
  parked: "backlog",
};

export function BoardColumn({
  lane,
  statuses,
  tasks,
  isCollapsed,
  onToggleCollapsed,
  isDropTarget,
  draggedTaskId,
  draggedTaskHeight,
  movingTaskId,
  settlingTaskId,
  contextMenuTaskId,
  projectNames,
  canCreate = true,
  onCreate,
  onEdit,
  onContextMenu,
  onMove,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDrop,
  onOpenThread,
  onHide,
  onComplete,
}: BoardColumnProps) {
  const lane_ = lane;
  // 段标题只在「这条列里真有不止一种东西」时才值得出现：只有一种时
  // 「等你 / 等你确认」只是把列名重说一遍，纯噪音。
  const populatedStatuses = statuses.filter((status) => tasks.some((task) => task.status === status));
  const label = LANE_LABELS[lane_.id].zh;
  const countLabel = LANE_LABELS[lane_.id].zhCount;
  const sampleStatus = LANE_SAMPLE_STATUS[lane_.id];
  const details = { label, status: sampleStatus };
  // 拖拽栏里只有一条状态时，落点状态是确定的；「等你」收两个状态，
  // 落点按卡片当前的段位决定（见 resolveDropStatus）。
  const soleStatus = statuses.length === 1 ? statuses[0] : null;
  const [dropBeforeTaskId, setDropBeforeTaskId] = useState<string | null | undefined>();
  const [dropStatus, setDropStatus] = useState<TaskStatus | null>(null);
  const taskIndexes = new Map(tasks.map((task, index) => [task.id, index]));
  const remainingTasks = tasks.filter((task) => task.id !== draggedTaskId);
  const remainingIndexes = new Map(remainingTasks.map((task, index) => [task.id, index]));
  const draggedTaskIndex = draggedTaskId ? taskIndexes.get(draggedTaskId) ?? -1 : -1;
  const beforeIndex = dropBeforeTaskId
    ? remainingIndexes.get(dropBeforeTaskId) ?? remainingTasks.length
    : remainingTasks.length;
  const previewIndex = isDropTarget && dropBeforeTaskId !== undefined ? beforeIndex : -1;
  const dragDistance = draggedTaskHeight + 8;

  useEffect(() => {
    if (!isDropTarget || !draggedTaskId) setDropBeforeTaskId(undefined);
  }, [draggedTaskId, isDropTarget]);

  function findDropBefore(container: HTMLElement, clientY: number): string | null {
    const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-task-id]"))
      .filter((card) => card.dataset.taskId !== draggedTaskId);
    return cards.find((card) => clientY < card.getBoundingClientRect().top + card.offsetHeight / 2)
      ?.dataset.taskId ?? null;
  }

  /**
   * 卡片落在哪条状态上。单状态列直接返回它；「等你」要按落点位置判断：
   * 卡片插在某个同类卡片前面就沿用那条卡片的现状，落在段尾则沿用被拖卡片
   * 自己的现状（同列内换位置不该偷偷改状态）。
   */
  function resolveDropStatus(taskId: string, beforeTaskId: string | null): TaskStatus {
    if (soleStatus !== null) return soleStatus;
    if (beforeTaskId !== null) {
      const target = tasks.find((task) => task.id === beforeTaskId);
      if (target) return target.status;
    }
    const dragged = tasks.find((task) => task.id === taskId);
    return dragged?.status ?? statuses[0];
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const taskId =
      event.dataTransfer.getData("application/x-taskboard-task") ||
      event.dataTransfer.getData("text/plain");
    if (taskId) {
      const before = findDropBefore(event.currentTarget, event.clientY);
      onDrop(resolveDropStatus(taskId, before), taskId, before);
    }
    setDropBeforeTaskId(undefined);
    setDropStatus(null);
  }

  /** 被拖卡片此刻的状态（判断跨列拖动落到哪条状态用）。 */
  function currentDraggedStatus(): TaskStatus | null {
    if (!draggedTaskId) return null;
    return tasks.find((task) => task.id === draggedTaskId)?.status ?? null;
  }

  function getTaskDragShift(task: Task): number {
    if (!draggedTaskId || task.id === draggedTaskId) return 0;
    let shift = 0;
    const taskIndex = taskIndexes.get(task.id) ?? -1;
    const remainingIndex = remainingIndexes.get(task.id) ?? -1;

    if (draggedTaskIndex >= 0 && taskIndex > draggedTaskIndex) shift -= dragDistance;
    if (previewIndex >= 0 && remainingIndex >= previewIndex) shift += dragDistance;
    return shift;
  }

  return (
    <section
      className={`board-column lane-${lane_.id} status-${details.status}${isDropTarget ? " is-drop-target" : ""}${isCollapsed ? " is-collapsed" : ""}${lane_.id === "you" ? " is-primary" : ""}`}
      aria-labelledby={`column-${lane_.id}`}
      onDragEnter={() => {
        const status = soleStatus ?? currentDraggedStatus();
        if (status) onDragEnter(status);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const before = findDropBefore(event.currentTarget, event.clientY);
        const status = soleStatus ?? currentDraggedStatus() ?? statuses[0];
        onDragEnter(status);
        setDropStatus(status);
        setDropBeforeTaskId(before);
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          setDropBeforeTaskId(undefined);
        }
      }}
      onDrop={handleDrop}
    >
      <header className="column-header">
        <div className="column-heading">
          <span className={`column-status-icon status-icon-${STATUS_DETAILS[details.status].tone}`}>
            <ColumnStatusIcon status={details.status} />
          </span>
          <h2 id={`column-${lane_.id}`}>{details.label}</h2>
          <span className="task-count" aria-label={`${tasks.length} ${countLabel}`}>{tasks.length}</span>
        </div>
        <div className="column-actions">
          {lane_.collapsible && (
            <button
              type="button"
              className={`icon-button lane-toggle${isCollapsed ? "" : " is-expanded"}`}
              onClick={onToggleCollapsed}
              aria-expanded={!isCollapsed}
              aria-label={isCollapsed ? `展开${details.label}` : `折叠${details.label}`}
              title={isCollapsed ? `展开${details.label}` : `折叠${details.label}`}
            >
              <TaskboardIcon name="dropdown" />
            </button>
          )}
          {tasks.length > 0 && (
            <ColumnVisibilityMenu
              label={details.label}
              action="hide"
              className="icon-button column-menu"
              onAction={onHide}
            />
          )}
          {canCreate && soleStatus !== null && (
          <button
            type="button"
            className="icon-button add-task-button"
            onClick={() => onCreate(soleStatus)}
            aria-label={`在${details.label}中新建议题`}
            title={`添加到${details.label}`}
          >
            <TaskboardIcon name="columnAdd" />
          </button>
          )}
        </div>
      </header>

      {!isCollapsed && (
      <div className="column-list">
        {statuses.map((status) => {
          const segment = tasks.filter((task) => task.status === status);
          // 「等你」把待验收和被阻塞并在一起，所以每段要自报家门：
          // 列回答「该谁动」，段回答「为什么」。
          const showSegment = populatedStatuses.length > 1;
          if (showSegment && segment.length === 0) return null;
          return (
            <div className="column-segment" key={status}>
              {showSegment && laneSegmentHeadingNeeded(lane_.id, status) && (
                <div className="column-segment-heading">
                  <span className="column-segment-label">
                    {WAITING_REASON_LABELS[status]?.zh ?? STATUS_DETAILS[status].label}
                  </span>
                  <span className="column-segment-count">{segment.length}</span>
                </div>
              )}
              {segment.map((task) => {
                const dragShift = getTaskDragShift(task);
                return (
                  <TaskCard
                    key={task.id}
                    task={task}
                    projectName={projectNames?.[task.projectId]}
                    statusIndex={TASK_STATUSES.indexOf(task.status)}
                    isDragging={draggedTaskId === task.id}
                    dragShift={dragShift}
                    isMoving={movingTaskId === task.id}
                    isSettling={settlingTaskId === task.id}
                    isContextMenuOpen={contextMenuTaskId === task.id}
                    onEdit={onEdit}
                    onContextMenu={onContextMenu}
                    onMove={onMove}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                    onOpenThread={onOpenThread}
                    onComplete={onComplete}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      )}
    </section>
  );
}
