import { createHash } from "node:crypto";
import { readdir, readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

import { TaskboardDatabase } from "./database.mjs";

const REASONIX_HOME = process.env.REASONIX_HOME ?? path.join(os.homedir(), ".reasonix");
const PROJECTS_DIR = path.join(REASONIX_HOME, "projects");

/** 从 Reasonix 会话 meta 读取 workspace_root，返回去重后的绝对路径列表。 */
async function readReasonixWorkspaces() {
  const workspaces = new Set();
  let projectDirs;
  try {
    projectDirs = await readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const sessionsDir = path.join(PROJECTS_DIR, entry.name, "sessions");
    let metaFiles;
    try {
      metaFiles = await readdir(sessionsDir);
    } catch {
      continue; // 无 sessions 目录的项目跳过
    }
    for (const file of metaFiles) {
      if (!file.endsWith(".meta")) continue;
      try {
        const meta = JSON.parse(await readFile(path.join(sessionsDir, file), "utf8"));
        const root = meta.workspace_root ?? meta.workspaceRoot;
        if (typeof root === "string" && root.length > 0 && root.startsWith("/")) {
          workspaces.add(root);
        }
      } catch {
        // 单个 meta 解析失败不影响其他
      }
    }
  }
  return [...workspaces];
}

/** Reasonix 全局工作区（非真实项目）特征，跳过。 */
function isReasonixGlobalWorkspace(root) {
  const normalized = root.replaceAll("\\", "/").toLowerCase();
  return normalized.includes("/.reasonix/")
    || normalized.includes("reasonix/global-workspace")
    || normalized.includes("reasonix-global-workspace");
}

/** worktree 子路径（如 <root>/.worktrees/xxx）跳过，避免与主项目重复；以 '.' 开头的目录也跳过。 */
function isNestedOrHiddenWorkspace(root) {
  const segments = root.split(/[/\\]/).filter(Boolean);
  return segments.some((segment) => segment === ".worktrees" || segment.startsWith("."))
    || root.endsWith("/desktop");
}

function projectIdForWorkspace(root) {
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 12);
  return `r-${hash}`;
}

/**
 * 同步 Reasonix 项目到 taskboard 数据库：扫描 Reasonix projects 目录下
 * 各 session 的 .meta 文件（workspace_root 字段），为每个真实项目
 * 创建缺失的 taskboard project。返回 { created, existing, skipped }。
 */
export async function syncReasonixProjects(databasePath) {
  const database = new TaskboardDatabase(databasePath);
  try {
    const workspaces = await readReasonixWorkspaces();
    const result = { created: [], existing: [], skipped: [] };
    for (const root of workspaces) {
      if (isReasonixGlobalWorkspace(root) || isNestedOrHiddenWorkspace(root)) {
        result.skipped.push(root);
        continue;
      }
      // 跳过磁盘上已不存在的路径
      try {
        await access(root, constants.F_OK);
      } catch {
        result.skipped.push(root);
        continue;
      }
      const id = projectIdForWorkspace(root);
      const existing = database.getProject(id);
      if (existing) {
        result.existing.push({ id, workspacePath: root });
        continue;
      }
      try {
        database.createProject({
          id,
          name: path.basename(root) || root,
          workspacePath: root,
        });
        result.created.push({ id, workspacePath: root });
      } catch (error) {
        if (String(error.message).includes("PROJECT_EXISTS")) {
          result.existing.push({ id, workspacePath: root });
        } else {
          result.skipped.push(root);
        }
      }
    }
    return result;
  } finally {
    database.close();
  }
}
