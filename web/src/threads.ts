/**
 * True when a threadId references a DeepSeek Harness session. Recognized
 * forms: the legacy `dsh-<uuid>` heartbeat ids, the store-minted
 * `session-<uuid>` ids, and the in-process claim-runner `claim-<prefix>-<uuid>`
 * ids (all minted by the dsh host). Everything else is treated as a
 * Codex/Reasonix thread and must NOT open a DSH session page.
 */
export function isDshThreadId(threadId: string | null | undefined): boolean {
  return typeof threadId === "string"
    && (threadId.startsWith("dsh-")
      || threadId.startsWith("session-")
      || threadId.startsWith("claim-"));
}
