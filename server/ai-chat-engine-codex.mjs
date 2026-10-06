/**
 * Codex engine for the taskboard AI chat.
 *
 * One turn = one `codex exec --json` child process driven through stdin, with
 * the project workspace as cwd. This is the default engine: the board server
 * builds it from the codex executable/state paths unless a host injects a
 * different engine (the DSH plugin injects an in-process DSH session engine).
 *
 * Engine contract (implemented here and by host engines):
 *   id      — engine label, for diagnostics.
 *   catalog({ projectId, workspacePath, database })
 *           -> { models, skills, sandboxes } consumed by the panel selectors.
 *   startTurn({ thread, message, skills, attachmentPaths, imagePaths,
 *               addDirectories, onRawEvent })
 *           -> { completion, interrupt(), kill() }
 *   `onRawEvent` receives codex-shaped JSONL events (`thread.started`,
 *   `turn.completed`, `turn.failed`, `item.started|updated|completed`), which
 *   is the vocabulary the service normalizes, stores and streams.
 */
import { discoverAiCatalog } from "./ai-chat-catalog.mjs";
import { buildCodexArgs, buildCodexPrompt, spawnCodexTurn } from "./ai-chat-process.mjs";

/** Signal a whole child process group, falling back to the child itself. */
function signalProcessGroup(child, signal) {
  if (Number.isInteger(child?.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try {
    child?.kill(signal);
  } catch {}
}

export function createCodexEngine(options) {
  const codexExecutable = options.codexExecutable;
  const codexStatePath = options.codexStatePath;
  const skillPath = options.manageTaskboardSkillPath ?? options.skillPath;
  const processEnv = options.processEnv ?? process.env;
  const killGraceMs = options.killGraceMs ?? 1_000;

  return {
    id: "codex",

    catalog({ projectId, database }) {
      return discoverAiCatalog({
        codexExecutable,
        codexStatePath,
        database,
        projectId,
        processEnv,
      });
    },

    startTurn({ thread, message, skills, attachmentPaths, imagePaths, addDirectories, onRawEvent }) {
      const args = buildCodexArgs(thread, addDirectories, imagePaths);
      const prompt = buildCodexPrompt(
        thread,
        { message, skills, attachmentPaths },
        skillPath,
      );
      const { child, completion } = spawnCodexTurn({
        executable: codexExecutable,
        args,
        prompt,
        env: processEnv,
        onRawEvent,
      });
      let settled = false;
      const done = completion.then(
        (result) => {
          settled = true;
          return result;
        },
        (error) => {
          settled = true;
          throw error;
        },
      );
      return {
        completion: done,
        interrupt() {
          signalProcessGroup(child, "SIGTERM");
          const timer = setTimeout(() => {
            if (!settled) signalProcessGroup(child, "SIGKILL");
          }, killGraceMs);
          timer.unref();
        },
        kill() {
          signalProcessGroup(child, "SIGKILL");
        },
      };
    },
  };
}
