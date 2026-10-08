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
  /**
   * 空着的时候还留不留在场上。
   *
   * 只有「等你」是 true——「没有等你的事」本身就是要看的信息，列消失会让人
   * 以为看板坏了。其余列空着就不占地方：有内容才出现。
   */
  defaultVisible: boolean;
}

export const BOARD_LANES: readonly BoardLane[] = [
  { id: "you", statuses: ["in_review", "blocked"], collapsible: false, defaultVisible: true },
  { id: "running", statuses: ["in_progress"], collapsible: false, defaultVisible: false },
  { id: "queued", statuses: ["todo"], collapsible: false, defaultVisible: false },
  { id: "finished", statuses: ["done", "canceled"], collapsible: true, defaultVisible: false },
  { id: "parked", statuses: ["backlog"], collapsible: true, defaultVisible: false },
] as const;

export const BOARD_LANE_ORDER: readonly BoardLaneId[] = BOARD_LANES.map((lane) => lane.id);

/**
 * 列的标题与计数文案。看板与侧栏列表共用这一处定义，
 * 两个界面才不会各写一套名字（曾经看板叫「等你确认」、列表也叫另一套）。
 */
export const LANE_LABELS: Record<BoardLaneId, { zh: string; en: string; zhCount: string; enCount: string }> = {
  you: { zh: "等你", en: "Waiting on you", zhCount: "件待你处理", enCount: "need you" },
  running: { zh: "处理中", en: "In progress", zhCount: "件在跑", enCount: "running" },
  queued: { zh: "等待认领", en: "To do", zhCount: "件排队", enCount: "queued" },
  finished: { zh: "已完成", en: "Finished", zhCount: "件已结束", enCount: "finished" },
  parked: { zh: "待立项", en: "Backlog", zhCount: "件候选", enCount: "parked" },
};

/**
 * 一条列此刻该不该出现。看板与侧栏列表共用，两个界面才不会各判一套。
 *
 *   有内容就出现；空着时只有 defaultVisible 的列（「等你」）留下。
 *   人手动收起过的列不出现，落到「收起的列」通道里，想看得回来。
 */
export function isLaneVisible(
  lane: BoardLane,
  hasContent: boolean,
  manuallyHidden = false,
): boolean {
  if (manuallyHidden) return false;
  return hasContent || lane.defaultVisible;
}

/**
 * 「等你」列里每件事为什么在等你。
 *
 * 它标在**每件事自己身上**，不是分组标题——为什么是单件事的属性，不是段落的属性；
 * 而且分组的动作入口完全一样（打开它）。标签写「要你做什么」而不是状态名，
 * 所以它不会跟列名重复（列叫「等你」，标签就不能再叫「等你确认」）。
 */
export const WAITING_REASON_LABELS: Partial<Record<TaskStatus, { zh: string; en: string }>> = {
  in_review: { zh: "待验收", en: "Review" },
  blocked: { zh: "被阻塞", en: "Blocked" },
};

export function laneById(id: BoardLaneId): BoardLane {
  const lane = BOARD_LANES.find((candidate) => candidate.id === id);
  if (!lane) throw new Error(`unknown board lane '${id}'`);
  return lane;
}
