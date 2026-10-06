# 自动化承接的会话挂载方式：每次新建 / 固定对话（评估与改造方案）

> 议题：09582F74F86A-13「自动化承接」
> 结论先行：二选一完全可行，宿主已有现成 API（`ctx.agents.resume`）；改动集中在 4 个文件 + 2 处 UI，**核心难点不是「能不能挂」，而是共享会话下的停止语义、并发排队与上下文预算**。

## 1. 需求

> 自动化承接任务的时候希望可以选择，是挂在一个指定的对话下面，还是每次默认执行一次都会新建一个对话。

拆成两种模式：

| 模式 | 语义 | 现状 |
|---|---|---|
| `new`（默认） | 每轮认领开一个新会话，跑完即卸载 | **已经是这样** |
| `fixed` | 所有轮次追加到同一个指定会话里，用户可随时进去看/接手 | 待实现 |

## 2. 现状：每轮都是一次性新会话（代码事实）

1. **会话 id 每轮现生成**：`plugin/lib/claim-executor.mjs:184`
   `const sessionId = `claim-${project.id.slice(0, 8)}-${randomUUID().slice(0, 8)}``
2. **在 GUI 宿主进程内建会话**：`plugin/lib/claim-executor.mjs:208` 调 `ctx.agents.create({ sessionId, meta: { cwd, agentPreset }, setup, agentOptions })`——所以 claim 会话是「一等公民会话」，会出现在侧栏、能被打开和继续聊。
3. **投递任务**：`claim-executor.mjs:248` `handle.agent.followup({ id, role: 'user', content: [{ type: 'text', text: prompt }] })`。
4. **收尾即卸载**：轮询 `ctx.sessions.get(sessionId).events` 等 `turn/end`（`claim-executor.mjs:259-266`，deadline 60 分钟），`finally` 里 `control.handle.dispose()`（`claim-executor.mjs:297`）。按 `dsh-agent/lib/types/index.d.ts:135-136`，`dispose()` 会「停 loop、卸载 agent、把会话从 store 移除」——磁盘上的 session 日志仍在（`~/.dsh/sessions/…/claim-*` 可见），但它不再是 live 会话。
5. **调度**：`plugin/lib/index.mjs:495` 的 sweep（`claimPollMs` 默认 30s，`index.mjs:114`）→ `index.mjs:402 runInProcessClaim()` 做前置门控（todo 校验 + 可选 check 脚本）→ `index.mjs:481` 调 `executeClaimInProcess()`。
6. **配置落库**：`server/database.mjs:819 getProjectAutomation()` / `:836 setProjectAutomation()`，字段就 4 个：`automation_enabled / automation_interval_minutes / automation_model / last_claim_at`。线上库实测 `PRAGMA table_info(projects)` 确认**没有**任何「会话模式 / 目标会话」列。
7. **HTTP**：`server/app.mjs:2103` `GET|POST /api/projects/:id/automation`（post 的 key 白名单在 `:2129`，只认 `enabled / intervalMinutes / automationModel`）。
8. **例行任务映射**：`plugin/lib/claim-routines.mjs` 把每个 claim 映射成 `taskboard-claim-<projectId 前 12>` 的 yaml（页面上的开关就是 automation 开关），运行记录写在 `<workspace>/.dsh/routines/runs/*.json`（`claim-executor.mjs:75`）。
9. **UI**：项目头部 ▶ 菜单 `web/src/components/ProjectAutomationMenu.tsx`、自动化页 `web/src/components/RoutinesView.tsx`（详情侧栏 + 运行记录 tab）。

## 3. 可行性：宿主有现成 API（本机已核实）

`@deepseek-ai/dsh-agent` 的 `ctx.agents`（AgentRegistry）提供：

| API | 位置 | 用途 |
|---|---|---|
| `create(options)` | `dsh-agent/lib/types/index.d.ts:278` | 现状：新建会话 |
| `resume(ownerCtx, { resumeSessionId, agentOptions, setup })` | `index.d.ts:109-128` | **挂到已有持久会话**：先加载持久化日志，再重建 scoped world |
| `get(id): Agent \| undefined` | `index.d.ts:343` | 目标会话当前是否已 live（用户开着 / 上一轮还在跑） |
| `list(): Agent[]` | `index.d.ts:357` | 兜底枚举 |

本机两端可用性实测：CLI 安装的 `dsh-agent-loop/lib/index.js` 含 `resumeSessionId`；桌面 App 的 `app.asar` 里 `resumeSessionId` 命中 26 处。→ `resume` 不是纸面接口，两个 profile 都能用。

**推论**：`fixed` 模式 = `agents.resume(resumeSessionId: <指定会话>)` + `followup(prompt)`；若目标会话已经 live（`agents.get(id)` 有值），直接用那个 agent 的 `followup`，**绝不能 dispose**（否则等于把用户的对话卸掉）。

## 4. 影响面清单

| # | 层 | 文件 | 要改什么 | 风险 |
|---|---|---|---|---|
| 1 | 数据 | `server/database.mjs` | 加两列 `automation_session_mode TEXT DEFAULT 'new'`、`automation_session_id TEXT`；迁移照 `:508-521` 的 `projectColumns` 探测模式；`getProjectAutomation`/`setProjectAutomation` 读写 | 迁移是纯 ALTER ADD，幂等，风险低 |
| 2 | HTTP | `server/app.mjs` | `POST /automation` 的白名单（`:2129`）加 `sessionMode`/`sessionId` + 校验（`fixed` 必须有 id；id 必须真实存在）；`/api/projects` 带出字段 | 校验不严会把「挂载」写成悬空 id |
| 2b | HTTP | `server/app.mjs` | 新增候选列表 `GET /api/projects/:id/claim-sessions`：从 run 记录（`claim-executor.mjs:125` 已经在读 `record.sessionId`）聚合出 `sessionId + startedAt + digest`，供 UI 下拉 | 9401 条 run 记录要限制/去重，否则列表接口变慢 |
| 3 | 调度 | `plugin/lib/index.mjs` | `runInProcessClaim`（`:402`）把 automation 的 mode/sessionId 透传给 `executeClaimInProcess`（`:481`） | 无 |
| 4 | 执行器 | `plugin/lib/claim-executor.mjs` | ① `fixed` 分支走 `resume`（`get(id)` 有 live agent 时直接 followup）；② **不 dispose 共享会话**——`finally`（`:297`）与 `stopClaimSession`（`:306`）都要按「自有 / 借用」分叉；③ 忙则跳过：同一会话上一轮没结束不能再 followup，记 `status: skipped, error: 'busy'`；④ run 记录的 `sessionId` 会重复（一会话多 run），`activeClaimSessions()`（`:324`）的 UI 语义要写清 | **最高**：错 dispose 会打断用户正在聊的对话；并发 followup 会串话 |
| 5 | 例行映射 | `plugin/lib/claim-routines.mjs` | yaml 目前只写开关；模式信息写进 `description`（dsh-routines 的 yaml 没有会话字段，不要硬塞以免宿主解析走偏） | 低 |
| 6 | 前端 | `ProjectAutomationMenu.tsx` / `RoutinesView.tsx` / `web/src/i18n.tsx` / plugin 的 `NS` 字典 | 二选一控件（每次新建 / 固定会话 + 会话选择器）、详情侧栏展示当前模式与目标会话、运行记录按会话分组 | 中：UI 状态与 DB 要一致（保存后回读） |
| 7 | 关联语义 | 任务 `threadId`、「查看对话」 | `fixed` 下所有任务回写的 threadId 都会指向同一会话——这正是需求想要的效果，但要确认 move/comment 回写不把「任务↔会话」关系搞乱；「查看对话」会一直落到同一会话 | 中：需要明确「一会话多任务」的展示 |
| 8 | 生命周期 | `plugin/lib/index.mjs` / `claim-executor.mjs` | 会话被归档/删除、宿主重启后不再是 live、`resume` 抛错 → 写明确 run 记录（failed + 原因）并**降级回落 `new`**，不能静默卡死；启动时的 `finalizeInterruptedRuns` 逻辑不受影响 | 中高：降级策略要显式可见（自动化页要有提示） |
| 9 | 上下文预算 | 新一轮（策略） | 固定会话会持续累积上下文（token 成本 + 模型上下文上限）。方案必须含轮转策略：达到 N 轮或上下文阈值后自动新建并归档旧会话 | 高（长期）：不处理会越跑越贵直至撞上下文墙 |
| 10 | 测试 | `plugin/tests/*.test.mjs` | 用例：模式解析、`fixed` 不 dispose、busy 跳过、resume 失败回落 | 低 |

## 5. 分期落地建议

**P0（最小可用，1 次改动）**
1. DB 两列 + 迁移 + `get/setProjectAutomation`；
2. `POST /automation` 接受 `sessionMode: 'new' | 'fixed'` 与 `sessionId`；
3. `ProjectAutomationMenu` 加二选一（`fixed` 时从 `claim-sessions` 候选中挑一个，或「用最近一次」）；
4. `claim-executor` 的 `fixed` 分支：`resume` + 不 dispose + busy 跳过。

验收断言（命令行可验）：
- POST 保存 `fixed` + 某 sessionId → `GET /automation` 回读一致；
- 触发一轮 claim → 新 run 记录的 `sessionId` **等于**配置的会话 id（而不是 `claim-xxxx-<uuid>` 新值）；
- 连续两轮 → 同一会话里出现两个 turn（`ctx.sessions` 日志断言）；
- 停止自动化 → 目标会话仍是 live（`agents.get(id)` 有值），只打断当前 turn。

**P1**：RoutinesView 模式展示/切换 + 运行记录按会话分组；`resume` 失败降级提示。

**P2**：上下文预算与轮转（N 轮自动新建 + 归档）；「常驻会话」优化（跨轮保留 handle，省掉每轮 resume 的加载成本）；允许挂到任意用户会话（含正在聊的），需额外处理用户输入与自动输入的插队顺序。

## 6. 需要拍板的三点

1. **固定会话从哪来**：只允许从「本项目历史 claim 会话」里挑（安全、可控），还是允许挑任意会话（含用户正在聊的，灵活但会互相插队）？
2. **上下文预算**：永不轮转（简单、会越来越贵），还是到 N 轮 / 上下文阈值自动新建并归档旧会话（推荐，需要 P2）？
3. **停止语义**：停止自动化时只打断当前 turn（推荐，会话保留可续），还是顺带把会话归档？

> 本文只做评估，不含代码改动。P0 落地前请先确认第 6 节三点。
