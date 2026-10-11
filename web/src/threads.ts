/**
 * True when a threadId references a DeepSeek Harness session. Recognized
 * forms: the legacy `dsh-<uuid>` heartbeat ids, the store-minted
 * `session-<uuid>` ids, the in-process claim-runner `claim-<prefix>-<uuid>`
 * ids, and the companion-plugin `companion-<uuid>` ids (all minted by the dsh
 * host and each carrying a real session log under ~/.dsh/sessions). Everything
 * else is treated as an external AI thread and must NOT open a DSH session
 * page.
 */
export function isDshThreadId(threadId: string | null | undefined): boolean {
  return typeof threadId === "string"
    && (threadId.startsWith("dsh-")
      || threadId.startsWith("session-")
      || threadId.startsWith("claim-")
      || threadId.startsWith("companion-"));
}
