import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * 自动认领开关：把 taskboard 项目的 automation 状态同步到
 * 心跳任务文件，由外部宿主轮询执行。支持两个执行宿主：
 * - reasonix：~/.reasonix/heartbeat-tasks.json，Reasonix App 轮询；
 * - dsh：$DSH_HOME（默认 ~/.dsh）/heartbeat-tasks.json，DeepSeek Harness
 *   心跳 runner（scripts/heartbeat-runner.mjs）轮询。
 *
 * ⚠️ 2026-08-16：dsh 宿主已停用 —— 自研心跳 runner
 * （scripts/heartbeat-runner.mjs / start-heartbeat-runner.sh /
 * com.douba.dsh-heartbeat.plist）已删除，备份在
 * ~/Desktop/heartbeat-removal-backup-20260816-1959/。
 * 仅保留 reasonix 宿主（Reasonix App 轮询）逻辑；
 * 下方 dsh 相关常量（DSH_HEARTBEAT_FILE / HEARTBEAT_RUNNER_LOCK /
 * RUNNER_PLIST / RUNNER_WRAPPER）为历史遗留，勿再启用。
 *
 * 开关打开 → 创建/启用一个 scope=project 的心跳任务，
 * 让宿主 AI 定期扫描该项目 todo 并认领。
 * 开关关闭 → 停用该心跳任务（保留记录，不删除）。
 */

const REASONIX_HEARTBEAT_FILE = process.env.REASONIX_HOME
  ? path.join(process.env.REASONIX_HOME, "heartbeat-tasks.json")
  : path.join(os.homedir(), ".reasonix", "heartbeat-tasks.json");

/**
 * 按执行宿主解析心跳任务文件路径；未知宿主回退到 Reasonix 文件。
 * ⚠️ 2026-08-16：dsh 宿主已停用（自研 runner 已删除），仅 reasonix 有效。
 */
export function resolveHeartbeatFile(host) {
  return REASONIX_HEARTBEAT_FILE;
}

export function heartbeatTaskId(projectId) {
  return `taskboard_claim_${projectId}`;
}

function intervalLabel(minutes) {
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function buildClaimPrompt({ projectId, projectName, workspacePath, skillPath, host = "reasonix" }) {
  const skillRef = skillPath
    ? `[$manage-taskboard](${skillPath})`
    : "manage-taskboard skill（命令手册见 skills/manage-taskboard/references/cli.md）";
  const attribution = "归因：每条写操作带上当前会话 id（REASONIX_THREAD_ID），无法获取时用 --thread-id reasonix-heartbeat。";
  return [
    `通过 ${skillRef} 检查任务看板「${projectName}」项目（项目 ID：${projectId}，项目目录：${workspacePath}）。`,
    `每次仅处理一个 todo：\`taskctl issue list --project ${projectId} --status todo\` 找到最早的 todo，用 \`taskctl issue get <identifier>\` 读取最新议题内容，并用 \`taskctl comment list <identifier>\` 读取全部评论（评论是需求的一部分，含已完成后被打回的返工要求）。`,
    `认领时使用最新 version 将议题移动到 in_progress：\`taskctl issue move <identifier> --status in_progress --if-version <最新version>\`；若发生版本冲突或最新状态已变化，立即跳过，避免多个 Agent 抢同一任务。`,
    "若议题已绑定 branch 或 worktree，必须在该议题绑定的开发上下文执行，避免并行 Agent 修改同一工作目录。",
    "执行完成并验证后，先用 `taskctl comment add <identifier> --body <关键改动/验证结果/剩余风险>` 记录，再使用最新 version 将议题移动到 in_review；不要直接标记为 done（done 必须由用户在页面确认验收）。",
    attribution,
  ].join("\n");
}

async function readHeartbeatFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { tasks: [] };
  }
}

/**
 * 同步 automation 状态到心跳任务文件。
 * @param {object} input { projectId, projectName, workspacePath, enabled, intervalMinutes, skillPath, host }
 * @returns {Promise<{id: string, host: string, enabled: boolean, interval: string}>}
 */
export async function reconcileHeartbeatAutomation(input) {
  const {
    projectId,
    projectName,
    workspacePath,
    enabled,
    intervalMinutes = 10,
    skillPath = "",
    host = "reasonix",
  } = input;

  const file = await readHeartbeatFile(resolveHeartbeatFile(host));
  const tasks = Array.isArray(file.tasks) ? file.tasks : [];
  const id = heartbeatTaskId(projectId);
  const interval = intervalLabel(intervalMinutes);
  const existing = tasks.find((task) => task.id === id);

  const base = {
    id,
    title: `任务看板自动认领 · ${projectName}`,
    prompt: buildClaimPrompt({ projectId, projectName, workspacePath, skillPath, host }),
    interval,
    scope: "project",
    workspaceRoot: workspacePath,
    createdAt: existing?.createdAt ?? Date.now(),
    approvalMode: "yolo",
  };

  const next = existing
    ? tasks.map((task) => (task.id === id ? { ...task, ...base, enabled } : task))
    : [...tasks, { ...base, enabled }];

  const heartbeatFile = resolveHeartbeatFile(host);
  // 原子写入：先写临时文件再 rename
  await mkdir(path.dirname(heartbeatFile), { recursive: true });
  const tmp = `${heartbeatFile}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...file, tasks: next }, null, 2), "utf8");
  await rename(tmp, heartbeatFile);

  return { id, host, enabled, interval };
}

/** 读取某项目的 automation 状态（host + enabled + interval）。 */
export async function readHeartbeatAutomation(projectId, host = "reasonix") {
  const file = await readHeartbeatFile(resolveHeartbeatFile(host));
  const tasks = Array.isArray(file.tasks) ? file.tasks : [];
  const task = tasks.find((item) => item.id === heartbeatTaskId(projectId));
  if (!task) return { host, enabled: false, intervalMinutes: null };
  const minutes = task.interval?.endsWith("h")
    ? Number(task.interval.slice(0, -1)) * 60
    : Number(task.interval?.replace("m", ""));
  return {
    host,
    enabled: Boolean(task.enabled),
    intervalMinutes: Number.isFinite(minutes) ? minutes : null,
  };
}
