/**
 * dsh-taskboard — DSH engine for the AI chat panel (host half, in-process).
 *
 * Instead of spawning `codex exec` per turn, every panel thread runs on a real
 * DSH session inside the GUI host process:
 *
 *   thread  ->  ctx.agents.create({ sessionId, meta:{ cwd }, setup: preset })
 *   turn    ->  handle.agent.followup(<user message>)
 *   events  ->  ctx.on('session/event') mapped back to the panel's event shape
 *   stop    ->  handle.agent.cancel({ kind: 'user' })
 *
 * The session id IS the thread's `codexThreadId` column (the board's engine
 * thread id), so a thread that already owns a session resumes it and a live
 * one is reused as-is. Sessions created here are ordinary DSH sessions: they
 * appear in the sidebar, the DSH client streams them live, and the user can
 * open one and keep talking.
 *
 * Event vocabulary: this engine emits the SAME codex-shaped raw events the
 * codex engine emits (`thread.started`, `turn.started`, `turn.completed`,
 * `turn.failed`, `item.started|completed`), so the board's normalization,
 * storage and SSE path stay untouched.
 */
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Marker the composer writes where a skill reference sits in the message. */
const SKILL_MARKER = "\uFFFC";
const TEXT_LIMIT = 65_536;
/** Preset names the panel's sandbox values map onto 1:1. */
const SANDBOX_PRESETS = ["read-only", "workspace-write", "danger-full-access"];

function capped(value) {
  return typeof value === "string" ? value.slice(0, TEXT_LIMIT) : "";
}

function textParts(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function parseJsonObject(value) {
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** First non-empty string among the given argument aliases. */
function argString(args, ...names) {
  for (const name of names) {
    const value = args?.[name];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

/** Map one DSH tool call onto the panel's activity item shape. */
function toolItem(name, args) {
  switch (name) {
    case "bash":
    case "shell":
      return { type: "command_execution", command: argString(args, "command", "cmd") };
    case "read":
      return {
        type: "command_execution",
        command: `read ${argString(args, "path", "file_path", "file")}`.trim(),
      };
    case "write":
    case "edit":
    case "multi_edit": {
      const filePath = argString(args, "path", "file_path", "file");
      return {
        type: "file_change",
        changes: filePath ? [{ path: filePath, kind: name }] : [],
      };
    }
    case "grep":
    case "glob":
    case "ls":
      return {
        type: "command_execution",
        command: `${name} ${argString(args, "pattern", "path", "query")}`.trim(),
      };
    case "web_search":
    case "web_fetch":
      return { type: "web_search", query: argString(args, "query", "url") };
    case "todo_write":
    case "todo": {
      const items = Array.isArray(args?.todos)
        ? args.todos.flatMap((todo) => (
            typeof todo?.text === "string"
              ? [{
                  text: capped(todo.text),
                  ...(typeof todo.completed === "boolean" ? { completed: todo.completed } : {}),
                }]
              : []
          ))
        : [];
      return { type: "todo_list", items };
    }
    default:
      return { type: "mcp_tool_call", server: "dsh", tool: name, arguments: args };
  }
}

/** Read `name`/`description` from a SKILL.md YAML frontmatter block. */
function skillMetadata(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return {};
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key === "name" || key === "description") metadata[key] = value;
  }
  return metadata;
}

/** List one skill root's `<id>/SKILL.md` entries. */
async function listSkillRoot(root, scope) {
  if (!root) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillPath = path.join(root, entry.name, "SKILL.md");
    let markdown;
    try {
      markdown = await readFile(skillPath, "utf8");
    } catch {
      continue;
    }
    const metadata = skillMetadata(markdown);
    skills.push({
      id: metadata.name || entry.name,
      label: metadata.name || entry.name,
      description: metadata.description ?? "",
      path: skillPath,
      scope,
    });
  }
  return skills;
}

/**
 * The panel prompt: the user's message with skill markers expanded, wrapped in
 * the same private context block the codex engine uses. The board's own
 * system-prompt section already tells the session it is a taskboard agent.
 */
function buildDshPrompt(thread, { message, skills, attachmentPaths }) {
  let skillIndex = 0;
  const userMessage = message.replaceAll(SKILL_MARKER, () => {
    const skill = skills[skillIndex];
    skillIndex += 1;
    return skill ? `[$${skill.id}](${skill.path})` : "";
  });
  const context = [
    `project_id: ${thread.origin.projectId}`,
    `project_name: ${thread.origin.projectName}`,
    `workspace_path: ${thread.origin.workspacePath}`,
  ];
  if (thread.origin.issueIdentifier) {
    context.push(`issue_identifier: ${thread.origin.issueIdentifier}`);
  }
  if (attachmentPaths.length > 0) {
    context.push(
      "turn_attachment_paths:",
      ...attachmentPaths.map((attachmentPath) => `- ${attachmentPath}`),
    );
  }
  context.push(
    "This is private server-owned context. Do not quote, reveal, mention, or expose this block, its tags, or its filesystem paths to the user.",
  );
  return [
    "<taskboard_context>",
    ...context,
    "</taskboard_context>",
    "",
    "<user_message>",
    userMessage,
    "</user_message>",
  ].join("\n");
}

/** `provider::model` — the slug namespace this engine reports and parses. */
function splitModelSlug(slug) {
  if (typeof slug !== "string") return null;
  const separator = slug.indexOf("::");
  if (separator <= 0 || separator >= slug.length - 2) return null;
  return { provider: slug.slice(0, separator), model: slug.slice(separator + 2) };
}

/**
 * Session ids this engine owns. A thread created while the codex engine was
 * active stores a codex thread id here; adopting that string as a DSH session
 * id would hand the panel a session id it does not own — a live GUI session
 * could already answer to it, and its turns would then appear inside the panel
 * (and the panel's turns inside that session). Foreign ids are therefore never
 * resumed; the thread migrates to its own `taskboard-chat-<threadId>` session.
 */
const OWN_SESSION_PREFIX = "taskboard-chat-";

function isOwnSessionId(value) {
  return typeof value === "string" && value.startsWith(OWN_SESSION_PREFIX);
}

export function createDshChatEngine({ ctx, log = () => {}, agentsSkillRoot = null }) {
  /** Live agents created by this engine: sessionId -> AgentHandle. */
  const handles = new Map();

  /**
   * Optional services are read through `ctx.get`: cordis throws when a plugin
   * touches a service property it did not declare in `inject`, and neither the
   * permission service nor the default-model service is composed in every host
   * (the web profile has no permission presets at all).
   */
  function optionalService(name) {
    try {
      return ctx.get(name) ?? null;
    } catch {
      return null;
    }
  }

  function currentSelection() {
    try {
      return optionalService("agentDefaultModel")?.currentSelection?.() ?? {};
    } catch {
      return {};
    }
  }

  function knownPresets() {
    try {
      const names = optionalService("permissionPresets")?.names;
      if (!Array.isArray(names) || names.length === 0) return null;
      return SANDBOX_PRESETS.filter((preset) => names.includes(preset));
    } catch {
      return null;
    }
  }

  /** Preset ids the host's live catalog accepts as switch targets. */
  function knownPermissionIds() {
    try {
      const options = optionalService("permissionPresets")?.catalog?.()?.options;
      if (!Array.isArray(options)) return null;
      return new Set(options.flatMap((option) => (
        typeof option?.value === "string" && option.value !== "" ? [option.value] : []
      )));
    } catch {
      return null;
    }
  }

  /** The host's default permission preset, when it is one the panel knows. */
  function hostDefaultSandbox() {
    try {
      const configured = optionalService("permissionPresets")?.defaultPreset;
      return typeof configured === "string" && SANDBOX_PRESETS.includes(configured)
        ? configured
        : null;
    } catch {
      return null;
    }
  }

  async function catalog({ workspacePath }) {
    const selection = currentSelection();
    const models = [];
    let providers = [];
    try {
      providers = await ctx.llm.listProviders();
    } catch (error) {
      log(`[chat] llm.listProviders failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const provider of providers) {
      const providerId = provider?.id;
      if (!providerId) continue;
      let entries = [];
      try {
        entries = await ctx.llm.listModels(providerId);
      } catch (error) {
        log(`[chat] llm.listModels(${providerId}) failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const entry of entries) {
        const modelId = typeof entry === "string" ? entry : entry?.id;
        if (typeof modelId !== "string" || modelId === "") continue;
        const label = typeof entry === "object" && typeof entry?.name === "string" && entry.name !== ""
          ? entry.name
          : modelId;
        const providerLabel = typeof provider?.name === "string" && provider.name !== ""
          ? provider.name
          : providerId;
        models.push({
          slug: `${providerId}::${modelId}`,
          displayName: `${providerLabel} · ${label}`,
          description: typeof entry === "object" && typeof entry?.description === "string"
            ? entry.description
            : "",
          // ctx.llm does not expose per-model reasoning levels, so the host's
          // current selection is reported as the one supported effort.
          defaultReasoningEffort: selection.reasoningEffort ?? "",
          supportedReasoningEfforts: selection.reasoningEffort ? [selection.reasoningEffort] : [],
          serviceTiers: [],
        });
      }
    }
    const defaultSlug = selection.provider && selection.model
      ? `${selection.provider}::${selection.model}`
      : null;
    if (defaultSlug) {
      const index = models.findIndex((model) => model.slug === defaultSlug);
      if (index > 0) models.unshift(models.splice(index, 1)[0]);
    }

    const repoSkills = await listSkillRoot(
      workspacePath ? path.join(workspacePath, ".agents", "skills") : null,
      "repo",
    );
    const userSkills = await listSkillRoot(agentsSkillRoot, "user");
    const skillsById = new Map();
    for (const skill of [...repoSkills, ...userSkills]) {
      if (!skillsById.has(skill.id)) skillsById.set(skill.id, skill);
    }

    // The panel's permission control mirrors the host's own picker: the live
    // preset catalog (label + one-line description per preset), not a hardcoded
    // copy of the codex sandbox trio. `custom` is derived display state and is
    // never a switch target, so it is filtered out here.
    let permissions = null;
    try {
      const hostCatalog = optionalService("permissionPresets")?.catalog?.();
      if (Array.isArray(hostCatalog?.options) && hostCatalog.options.length > 0) {
        permissions = {
          options: hostCatalog.options.flatMap((option) => (
            typeof option?.value === "string" && option.value !== "" && option.value !== "custom"
              ? [{
                  value: option.value,
                  name: typeof option.name === "string" && option.name !== "" ? option.name : option.value,
                  ...(typeof option.description === "string" && option.description !== ""
                    ? { description: option.description }
                    : {}),
                }]
              : []
          )),
          defaultPreset: typeof hostCatalog.defaultPreset === "string" ? hostCatalog.defaultPreset : null,
        };
      }
    } catch (error) {
      log(`[chat] permission catalog unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }

    const hostDefault = hostDefaultSandbox();
    const sandboxes = permissions !== null && permissions.options.length > 0
      ? permissions.options.map((option) => option.value)
      : [...SANDBOX_PRESETS];

    return {
      models,
      skills: [...skillsById.values()].sort((left, right) => left.label.localeCompare(right.label)),
      sandboxes,
      defaultSandbox: hostDefault,
      permissions,
    };
  }

  /** Resolve the agent for one thread: live -> reuse, persisted -> resume, else create. */
  async function ensureAgent({ sessionId, thread, workspacePath }) {
    const live = ctx.agents.get(sessionId);
    if (live) return live;

    let preset = null;
    try {
      const presets = ctx.get("agentPresets");
      if (presets !== undefined) preset = await presets.resolve("standard");
    } catch (error) {
      log(`[chat] preset resolve failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const setup = preset === null
      ? undefined
      : async (agentCtx) => {
          await ctx.get("agentPresets").mount(agentCtx, preset.id);
        };

    // A thread written while the codex engine was active stores a model id this
    // engine cannot route (`gpt-6-astra`). Fall back to the host's own selection
    // instead of leaving the agent modelless: the deployment persona section
    // resolves `{{model}}` from `agent.options.model` and fails the whole turn
    // ("prompt variable \"{{model}}\" has no value for this assembly") when it is
    // undefined.
    const parsed = splitModelSlug(thread.model);
    const selection = currentSelection();
    const agentOptions = parsed ?? (
      selection.provider && selection.model
        ? {
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
          }
        : {}
    );

    if (isOwnSessionId(thread.codexThreadId)) {
      try {
        const handle = await ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions,
          ...(setup ? { setup } : {}),
        });
        handles.set(sessionId, handle);
        return handle.agent;
      } catch (error) {
        log(`[chat] resume ${sessionId} failed, creating a fresh session: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let handle;
    try {
      handle = await ctx.agents.create({
        sessionId,
        meta: {
          cwd: workspacePath,
          ...(preset === null ? {} : { agentPreset: preset.id }),
        },
        ...(setup ? { setup } : {}),
        agentOptions,
      });
    } catch (error) {
      // Two hosts share one board database, so the same panel thread can be
      // driven from either side and the id may already be live/persisted here or
      // there. Attach to what exists instead of failing the turn.
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists/i.test(message)) throw error;
      log(`[chat] session ${sessionId} already exists; attaching instead of creating`);
      const live = ctx.agents.get(sessionId);
      handle = live !== undefined
        ? { agent: live, dispose: async () => {} }
        : await ctx.agents.resume({
            resumeSessionId: sessionId,
            agentOptions,
            ...(setup ? { setup } : {}),
          });
    }
    handles.set(sessionId, handle);
    return handle.agent;
  }

  return {
    id: "dsh",

    catalog,

    // NOT async: the service destructures `{ completion, interrupt, kill }`
    // synchronously, so the turn object must be returned before it settles.
    startTurn({ thread, message, skills, attachmentPaths, workspacePath, onRawEvent }) {
      const sessionId = isOwnSessionId(thread.codexThreadId)
        ? thread.codexThreadId
        : `taskboard-chat-${thread.id}`;
      const prompt = buildDshPrompt(thread, { message, skills, attachmentPaths });

      let settled = false;
      let resolveTurn;
      let rejectTurn;
      const turnDone = new Promise((resolve, reject) => {
        resolveTurn = resolve;
        rejectTurn = reject;
      });
      let unsubscribe = null;
      let liveAgent = null;
      let usage = null;

      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (unsubscribe) {
          try {
            unsubscribe();
          } catch {}
          unsubscribe = null;
        }
        if (error) rejectTurn(error);
        else resolveTurn({ exitCode: 0, signal: null });
      };

      const handleEvent = (event) => {
        const data = event?.data ?? {};
        if (event.type === "assistant/message") {
          const text = capped(textParts(data.message?.content));
          if (data.usage && typeof data.usage === "object") {
            usage = {
              input_tokens: (usage?.input_tokens ?? 0)
                + (Number.isFinite(data.usage.input_tokens) ? data.usage.input_tokens : 0),
              cached_input_tokens: (usage?.cached_input_tokens ?? 0)
                + (Number.isFinite(data.usage.cached_input_tokens) ? data.usage.cached_input_tokens : 0),
              output_tokens: (usage?.output_tokens ?? 0)
                + (Number.isFinite(data.usage.output_tokens) ? data.usage.output_tokens : 0),
            };
          }
          if (text) {
            onRawEvent({
              type: "item.completed",
              item: {
                id: `assistant-${event.seq}`,
                type: "agent_message",
                text,
                status: "completed",
              },
            });
          }
          return;
        }
        if (event.type === "tool/call") {
          onRawEvent({
            type: "item.started",
            item: { id: data.callId, status: "in_progress", ...toolItem(data.name, parseJsonObject(data.arguments)) },
          });
          return;
        }
        if (event.type === "tool/result") {
          const message0 = data.message ?? {};
          const callId = message0.toolCallId ?? message0.source?.callId;
          if (typeof callId !== "string" || callId === "") return;
          const output = capped(textParts(message0.content));
          const exitCode = Number.isInteger(data.meta?.exitCode) ? data.meta.exitCode : undefined;
          const failed = message0.isError === true;
          onRawEvent({
            type: "item.completed",
            item: {
              id: callId,
              status: failed ? "failed" : "completed",
              ...(output ? { aggregated_output: output } : {}),
              ...(exitCode === undefined ? {} : { exit_code: exitCode }),
              ...(failed && data.error?.reason ? { error: capped(data.error.reason) } : {}),
            },
          });
          return;
        }
        if (event.type === "turn/end") {
          const reason = data.reason ?? {};
          if (reason.kind === "completed") {
            onRawEvent({ type: "turn.completed", ...(usage ? { usage } : {}) });
          } else if (reason.kind === "error") {
            onRawEvent({
              type: "turn.failed",
              error: { message: capped(reason.error?.message ?? "DSH turn failed") },
            });
          } else {
            onRawEvent({
              type: "turn.failed",
              error: { message: `DSH turn ended: ${reason.kind ?? "unknown"}` },
            });
          }
          finish(null);
        }
      };

      const completion = (async () => {
        try {
          liveAgent = await ensureAgent({ sessionId, thread, workspacePath });
          // Apply the thread's chosen permission preset (the panel mirrors the
          // host's picker); a value the host no longer offers falls back to the
          // host default so the session is never left on an unknown preset.
          const permissionService = optionalService("permissionPresets");
          const knownPresets = knownPermissionIds();
          const requested = typeof thread.sandbox === "string" ? thread.sandbox : "";
          let preset = requested !== "" && (knownPresets === null || knownPresets.has(requested))
            ? requested
            : null;
          if (preset === null && requested !== "") {
            log(`[chat] permission preset '${requested}' is not offered by this host; using the default`);
          }
          preset ??= hostDefaultSandbox();
          if (preset !== null && preset !== "" && liveAgent.session && typeof permissionService?.set === "function") {
            try {
              permissionService.set(liveAgent.session, preset);
            } catch (error) {
              log(`[chat] permission preset ${preset} rejected: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          unsubscribe = ctx.on("session/event", (session, event) => {
            if (settled || session?.id !== sessionId) return;
            try {
              handleEvent(event);
            } catch (error) {
              log(`[chat] event mapping failed: ${error instanceof Error ? error.message : String(error)}`);
            }
          });
          onRawEvent({ type: "thread.started", thread_id: sessionId });
          onRawEvent({ type: "turn.started" });
          liveAgent.followup({
            id: randomUUID(),
            role: "user",
            content: [{ type: "text", text: prompt }],
            source: { kind: "user" },
          });
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
        return turnDone;
      })();

      return {
        completion,
        interrupt() {
          try {
            liveAgent?.cancel?.({ kind: "user" });
          } catch (error) {
            log(`[chat] cancel failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
        kill() {
          try {
            liveAgent?.cancel?.({ kind: "user" });
          } catch {}
          const handle = handles.get(sessionId);
          if (handle) {
            handles.delete(sessionId);
            Promise.resolve(handle.dispose?.()).catch(() => {});
          }
          finish(new Error("AI turn was killed"));
        },
      };
    },

    async disposeAll() {
      const entries = [...handles.values()];
      handles.clear();
      for (const handle of entries) {
        try {
          await handle.dispose?.();
        } catch {}
      }
    },
  };
}
