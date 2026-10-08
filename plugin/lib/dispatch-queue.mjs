/**
 * dsh-taskboard — 派发排队（一轮在跑时收到的请求排到它后面）。
 *
 * 为什么单独一个模块：这段语义是「不静默丢活」的全部依据——每议题至多排一条、
 * 取走即消费、绝不因为忙碌而消失。它必须能被直接测，而不是只能靠读代码相信。
 *
 * 调用方是 plugin/lib/index.mjs 的派发管线；人类评论不进这个队列（它由在跑
 * 那一轮的队列读送达，再排一轮会执行两遍）。
 */
export function createDispatchQueue() {
  /** taskId -> { comment, reason, queuedAt } */
  const pending = new Map()

  return {
    /**
     * 排一条。同一议题已有排队时保留先到的那条（先来的意图优先，
     * 也避免自动化反复触发把队列堆起来）。
     * @returns {boolean} true 表示这次真的排进去了（不是重复排队）
     */
    enqueue(taskId, entry) {
      if (pending.has(taskId)) return false
      pending.set(taskId, { comment: entry?.comment ?? null, reason: entry?.reason ?? 'busy', queuedAt: Date.now() })
      return true
    },

    /** 取走并消费（取走后再调用返回 null——一次排队只换来一轮）。 */
    take(taskId) {
      const entry = pending.get(taskId)
      if (entry === undefined) return null
      pending.delete(taskId)
      return entry
    },

    has(taskId) {
      return pending.has(taskId)
    },

    /** 当前排了多少条（诊断/测试用）。 */
    size() {
      return pending.size
    },
  }
}
