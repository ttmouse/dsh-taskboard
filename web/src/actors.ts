import type { ActorIdentity, AssigneeTarget } from "./types";

export const CODEX_AGENT_ACTOR: ActorIdentity = {
  type: "agent",
  id: "codex-agent",
  name: "Reasonix Agent",
  avatarUrl: null,
};

/** DeepSeek Harness 心跳执行身份的看板展示实体（与心跳 runner 注入的 TASKCTL_AGENT_ID 一致）。 */
export const DSH_AGENT_ACTOR: ActorIdentity = {
  type: "agent",
  id: "dsh-agent",
  name: "DeepSeek Harness",
  avatarUrl: null,
};

export function actorKey(actor: ActorIdentity): string {
  return `${actor.type}:${actor.id}`;
}

export function actorForAssigneeTarget(
  target: AssigneeTarget,
  currentUser: ActorIdentity,
): ActorIdentity {
  return target === "codex-agent" ? CODEX_AGENT_ACTOR : currentUser;
}

export function assigneeTargetForActor(
  actor: ActorIdentity,
  currentUser: ActorIdentity,
): AssigneeTarget | undefined {
  if (actor.type === "agent") return "codex-agent";
  return actor.id === currentUser.id ? "current-user" : undefined;
}
