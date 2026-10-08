import { useState, type DragEvent } from "react";
import type { TaskStatus } from "../types";
import { STATUS_DETAILS, StatusIcon } from "./BoardColumn";
import { ColumnVisibilityMenu } from "./ColumnVisibilityMenu";
import { LinearIcon } from "./LinearIcon";
import { laneById, type BoardLaneId } from "../boardColumns";

interface HiddenColumnsProps {
  lanes: BoardLaneId[];
  counts: Record<BoardLaneId, number>;
  dropTarget: TaskStatus | null;
  onDragTargetChange: (status: TaskStatus | null) => void;
  onDrop: (status: TaskStatus, taskId: string) => void;
  onShow: (lane: BoardLaneId) => void;
}

/**
 * 收起来的列。列模型收敛成 5 条之后这里通常只有「已完成」一条，
 * 但它是通道，不能省：终态和需求池默认不占地方，想看得回得来。
 */
export function HiddenColumns({
  lanes,
  counts,
  dropTarget,
  onDragTargetChange,
  onDrop,
  onShow,
}: HiddenColumnsProps) {
  const [open, setOpen] = useState(true);

  function dropTask(event: DragEvent<HTMLElement>, status: TaskStatus) {
    event.preventDefault();
    const taskId = event.dataTransfer.getData("application/x-taskboard-task")
      || event.dataTransfer.getData("text/plain");
    onDragTargetChange(null);
    if (taskId) onDrop(status, taskId);
  }

  return (
    <section className={`hidden-columns${open ? " is-open" : ""}`} aria-label="收起的列">
      <button
        type="button"
        className="hidden-columns-heading"
        aria-expanded={open}
        aria-controls="hidden-columns-list"
        onClick={() => setOpen((current) => !current)}
      >
        <LinearIcon name="chevronDown" />
        <span>收起的列</span>
      </button>

      <div className="hidden-columns-list" id="hidden-columns-list" hidden={!open}>
        {lanes.map((laneId) => {
          const lane = laneById(laneId);
          // 列可以收多个状态，落到这条列时按第一个状态摆放。
          const status = lane.statuses[0];
          const details = STATUS_DETAILS[status];
          const count = counts[laneId];
          const canShow = count > 0;
          return (
            <div
              className={`hidden-column-item status-${status}${dropTarget === status ? " is-drop-target" : ""}`}
              key={laneId}
              onDragEnter={(event) => {
                event.preventDefault();
                onDragTargetChange(status);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                onDragTargetChange(status);
              }}
              onDragLeave={(event) => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                  onDragTargetChange(null);
                }
              }}
              onDrop={(event) => dropTask(event, status)}
            >
              {canShow ? (
                <button
                  type="button"
                  className="hidden-column-show"
                  aria-label={`显示${details.label}列`}
                  onClick={() => onShow(laneId)}
                >
                  <span className={`status-icon status-icon-${details.tone}`}>
                    <StatusIcon status={status} />
                  </span>
                  <strong>{details.label}</strong>
                  <span className="hidden-column-count">{count}</span>
                </button>
              ) : (
                <div className="hidden-column-show is-empty">
                  <span className={`status-icon status-icon-${details.tone}`}>
                    <StatusIcon status={status} />
                  </span>
                  <strong>{details.label}</strong>
                  <span className="hidden-column-count">{count}</span>
                </div>
              )}
              {canShow && (
                <ColumnVisibilityMenu
                  label={details.label}
                  action="show"
                  className="icon-button hidden-column-menu"
                  onAction={() => onShow(laneId)}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
