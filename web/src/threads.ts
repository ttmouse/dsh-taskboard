/**
 * True when a threadId references a DeepSeek Harness session (either the
 * legacy `dsh-<uuid>` heartbeat ids or the current store-minted
 * `session-<uuid>` ids). Everything else is treated as a Codex/Reasonix
 * thread and must NOT open a DSH session page.
 */
export function isDshThreadId(threadId: string | null | undefined): boolean {
  return typeof threadId === "string"
    && (threadId.startsWith("dsh-") || threadId.startsWith("session-"));
}
