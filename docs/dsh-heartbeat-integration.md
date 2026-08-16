# 自动接单迁移到 DeepSeek Harness（方案 A：心跳文件换宿主）

> 状态：设计中（2026-08-14）。目标：看板的"自动认领"（自动接单）从 Reasonix 心跳任务迁移到 DeepSeek Harness（dsh）headless 执行，Reasonix 路径保持兼容。

## 1. 现状链路

```
看板 UI「自动认领」开关（非 Codex 模式）
  → POST /api/projects/:id/automation { enabled, intervalMinutes, workspacePath }
  → server/heartbeat-automation.mjs
  → 写入 ~/.reasonix/heartbeat-tasks.json
     { id: "taskboard_claim_<projectId>", title, prompt, interval, scope: "project",
       workspaceRoot, createdAt, approvalMode: "yolo", enabled }
  → Reasonix App 轮询该文件，到点运行 agent 执行 prompt（认领工作流）
```

消费方（Reasonix App）拥有调度权与执行权；看板只负责写一份"任务卡"（heartbeat 条目）。

## 2. 目标链路

```
同一个开关 → 选择执行宿主（reasonix | dsh）
  → host=dsh 时写入 ~/.dsh/heartbeat-tasks.json（同格式，不动 Reasonix 文件）
  → 新的心跳 runner（scripts/heartbeat-runner.mjs）轮询该文件
  → 到点 spawn: dsh --profile headless "<prompt>"（cwd=workspaceRoot，env 继承）
  → headless agent 执行认领工作流（manage-taskboard skill + taskctl 均已在环境就绪）
```

## 3. 改动清单

### 看板侧（reasonix-taskboard 仓库）

| 文件 | 改动 |
|---|---|
| `server/heartbeat-automation.mjs` | `HEARTBEAT_FILE` 常量改为 `resolveHeartbeatFile(host)`：`reasonix` → 原路径；`dsh` → `$DSH_HOME`（默认 `~/.dsh`）下 `heartbeat-tasks.json`。`buildClaimPrompt` 增加 host 参数：dsh 归属行改为 `--thread-id dsh-heartbeat`。`reconcileHeartbeatAutomation` / `readHeartbeatAutomation` 接受 host |
| `server/app.mjs` | `GET/POST /api/projects/:id/automation` 接受可选 `host: "reasonix" \| "dsh"`（POST 在 body，GET 在 query；默认 `reasonix`，向后兼容），响应附带 `host` |
| `web/src/api.ts` | `AutomationStateView` / `AutomationUpdateInput` 增加 `host`；`getProjectAutomation` 增加 host 查询参数 |
| `web/src/components/ProjectAutomationMenu.tsx` | 非 Codex 模式增加"执行宿主"下拉（Reasonix / DeepSeek Harness） |
| `web/src/App.tsx` | `ProjectAutomationRecord` 增加 `host`；读写自动化时透传 host |
| `package.json` | 增加 `heartbeat` script 便于启动 runner |

### dsh 侧（新增，放看板仓库 scripts/）

**`scripts/heartbeat-runner.mjs`**（约 150 行）—— 心跳消费端，与 Reasonix App 的轮询角色对等：

- 每 30s（`HEARTBEAT_POLL_MS` 可配）轮询 `~/.dsh/heartbeat-tasks.json`
- 对每个 `enabled` 任务：`now - lastRunAt >= interval` 且无 in-flight 运行 → spawn `dsh --profile headless <prompt>`，cwd=workspaceRoot
- 运行结束（成功或失败）后原子写回 `lastRunAt`（临时文件 + rename，`revision` 自增）；失败也记录，避免失败重试风暴
- 单实例互斥：进程内 in-flight 集合 + 每任务串行（一次只认领一个，与 prompt 语义一致）
- 间隔解析：仅支持看板写出的 `5m`~`60m`、`1h` 格式
- 环境变量：`DSH_BIN`（默认 `dsh`，已确认在 PATH）、`HEARTBEAT_POLL_MS`、`DSH_HOME`
- 启动：`npm run heartbeat`（前台调试）/ `nohup` / launchd

### 现成条件（零成本）

headless profile 已存在（`dsh-base` + `dsh-headless`）、`manage-taskboard` skill 已在 `~/.agents/skills`、`taskctl` 在 PATH、dsh CLI 在 PATH、模型配置共用 `~/.dsh/settings.yaml`。

## 4. 验证计划（OPEN_API_KEY 就绪后）

1. smoke：`dsh --profile headless "输出当前时间"` 确认 headless 可用
2. 打开测试项目 automation（host=dsh）→ 检查 `~/.dsh/heartbeat-tasks.json` 内容与 prompt
3. 端到端：测试项目建一张 todo 卡 → 跑 runner 一个 tick → headless agent 认领（`in_progress`）→ 干活 → 评论 → `in_review` → 看板可见
4. 回归：host=reasonix 时行为与改动前完全一致（原文件、原 prompt）

## 5. 边界与风险

- headless 每次冷启动数秒，5-60 分钟间隔可接受
- 重叠 tick：runner 单进程 + 每任务互斥；prompt 内 `--if-version` 防多 agent 抢卡
- Reasonix 与 dsh **不共享心跳文件**，可并行服务不同项目
- headless 无持久会话：归因用固定 `--thread-id dsh-heartbeat`；将来 tool-taskboard 插件落地后可升级为真实会话 id
- 失败的任务在下一个间隔自动重试（不立即重试，避免风暴）

## 6. 明确不做（YAGNI）

- 不写 dsh 仓库内的插件（tool-taskboard 插件留作后续第 2 层）
- 不改 Reasonix 心跳格式 / 路径（共存兼容）
- 不做 Webhook / ACP 直连（方案 B 留作后续选项）

## 7. 运维（launchd 托管，自 2026-08-15 起）

看板服务与 dsh 心跳 runner 均由 launchd 托管（`~/Library/LaunchAgents/`）：

| 服务 | 文件 | 说明 |
|---|---|---|
| 看板服务 | `com.douba.taskboard-server.plist` | `node server/index.mjs`，开机自启 + 崩溃自愈，端口 47824 |
| dsh 心跳 | `com.douba.dsh-heartbeat.plist` | 经 `scripts/start-heartbeat-runner.sh` 启动，自动从 `~/.local/share/opencode/auth.json` 取 key（不落盘不打印） |

**日常命令**（仓库根目录）：

```bash
npm run ops -- status    # 查看两个服务 + 心跳最近执行
npm run ops -- logs      # 实时日志（Ctrl+C 退出）
npm run ops -- up        # 启动全部（一般不需要：已开机自启）
npm run ops -- down      # 停止全部
npm run ops -- restart   # 重启全部
```

日志文件：`~/Library/Logs/taskboard-server.{log,err}`、`~/Library/Logs/dsh-heartbeat.{log,err}`。

**注意**：
- runner 是单实例（锁文件 `~/.dsh/heartbeat-runner.lock`）；**不要再手动 `node scripts/heartbeat-runner.mjs`**，会与 launchd 实例冲突或双跑。
- runner 轮询间隔 30s，任务间隔按心跳文件配置（默认 5 分钟）；启动后首个到期 tick 立即执行。

**看板内感知与自愈**：看板左侧导航底部常驻「心跳服务」状态行（每 30s 自动刷新，悬浮显示最近执行/错误）；runner 未运行时显示「启动」按钮，点击经 `POST /api/automation/heartbeat/start` 经 launchctl 重新拉起服务。
