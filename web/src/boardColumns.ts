import type { TaskStatus } from "./types";

/**
 * 看板列模型：列回答「现在该谁动」，不回答「状态叫什么」。
 *
 * 答案只有四种——无人待启动、机器在跑、等你、结束。所以列数上限是 4，
 * 而不是 7 个状态各占一列（状态仍然精确、仍然 7 个，只是不再各占一列）。
 *
 * 五条列定义，按看板从左到右的顺序：
 *   - 等你（you）：唯一需要人动手的地方，永远排第一
 *   - 处理中（running）：agent 正在跑，可能为空
 *   - 等待认领（queued）：已拍板、排队等机器，可能为空
 *   - 已完成（finished）：终态，折叠成一行计数，随时可展开
 *   - 待立项（parked）：需求池（候选，未拍板）。它不是流程的一站，是货架；
 *     自动承接只从 todo 挑（见 plugin/lib/claim-routines.mjs 的选择器），
 *     把 backlog 并进流程会撒谎——让人以为它会被自动跑掉。所以它留在并列的位置，
 *     不进流程，可以手动收起。
 */
export type BoardLaneId = "you" | "running" | "queued" | "finished" | "parked";

export interface BoardLane {
  id: BoardLaneId;
  statuses: readonly TaskStatus[];
  /** 列默认是否展开；折叠态的列只显示标题行与计数。 */
  collapsible: boolean;
  /** 列默认是否可见（「等你」永远可见：「没有等你的事」本身就是要看的信息）。 */
  defaultVisible: boolean;
}

export const BOARD_LANES: readonly BoardLane[] = [
  { id: "you", statuses: ["in_review", "blocked"], collapsible: false, defaultVisible: true },
  { id: "running", statuses: ["in_progress"], collapsible: false, defaultVisible: true },
  { id: "queued", statuses: ["todo"], collapsible: false, defaultVisible: false },
  { id: "finished", statuses: ["done", "canceled"], collapsible: true, defaultVisible: false },
  { id: "parked", statuses: ["backlog"], collapsible: true, defaultVisible: false },
] as const;

export const BOARD_LANE_ORDER: readonly BoardLaneId[] = BOARD_LANES.map((lane) => lane.id);

/** 一个状态属于哪条列（每个状态恰好属于一条）。 */
export function laneOfStatus(status: TaskStatus): BoardLaneId {
  const lane = BOARD_LANES.find((candidate) => candidate.statuses.includes(status));
  if (!lane) throw new Error(`status '${status}' is not mapped to a board lane`);
  return lane.id;
}

export function laneById(id: BoardLaneId): BoardLane {
  const lane = BOARD_LANES.find((candidate) => candidate.id === id);
  if (!lane) throw new Error(`unknown board lane '${id}'`);
  return lane;
}
