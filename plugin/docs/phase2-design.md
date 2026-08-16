# 阶段 2 设计：卡片执行真实驱动 DSH 会话

**状态：已实现并在真实浏览器端到端验证（2026-08-16）。**

## 验证证据（Playwright + 验证实例 3095）

1. 看板任务详情点「在对话中打开」→ 捕获 iframe→ 壳的 `taskboard:dsh-execute` 消息
   （taskId `56dfe8be-...`、prompt（manage-taskboard skill 调用）、workspacePath
   `/Users/douba/Projects/deepseek-harness`）✓
2. client 半收到后：`POST /dsh-taskboard/api/tasks/:id/comments` 写入执行启动评论
   （API 返回评论，内容「已交给 DeepSeek Harness 执行：……PHASE2-1」）✓
3. 真实 DSH 会话创建于 workspacePath 对应会话目录（`~/.dsh/sessions/--Users-douba-Projects-deepseek-harness--/…`）✓
4. prompt 入队，agent 回合真实执行（session.log 可见 turn/step/tool 调用）✓
5. GUI `ctx.sessions.open` 已切到该会话（会话列表 +1 并成为当前项）

验证后已清理测试数据（项目/任务/评论/会话目录），用户仓库零改动。

## 已知限制

- 每次执行消耗 API 额度并真实驱动 agent（在工作区跑真实回合）——验证损耗真实资源。
- v1 只回写「执行启动」评论；完成态回写（订阅 turn 结束）为后续迭代。

## 已验证的技术路径（2026-08-16，源码确认）

客户端插件（browser 半）通过 `inject: ['sessions', 'workspaces', ...]` 获得服务：

```ts
// packages/client/ui-sidebar/src/client/index.ts:26 为官方先例
const sessionId = await ctx.sessions.create({ workspaceId, cwd })   // rpc → host 会话服务
const binding = ctx.sessions.binding(sessionId)                     // SessionBinding
await binding.session.prompt([{ type: 'text', text: prompt }], 'queue') // 排队一个用户回合
ctx.sessions.open(sessionId)                                        // GUI 切到该会话
```

- `SessionService.create`（runtime/src/client/sessions/service.ts:485）
- `SessionClient.prompt(content, 'queue')`（runtime/src/client/sessions/session.ts:190，返回
  `RpcResult<{accepted:true}>`；业务失败会进入会话快照的 promptError）
- `binding(id)`：create 后经 `resolve()` 拿到 `{ session: SessionFace, ctx: AgentContext }`

回写：client 半直接 `fetch('/dsh-taskboard/api/...')`（同源、经代理）加评论/更新状态，
任务板 server 的 SSE 广播自动把变更推给看板 UI——零额外机制。

## fork 侧改动（`web/src/App.tsx`）

现状（已读源码）：
- `openThread`（~1982）：`dsh-*` 线程已深链 `DSH_WEB_URL/?session=`；embedded 时 postMessage
  `taskboard:open-thread`。
- `openThreadByIdOrCreateConversation`（~2025）：非 dsh 线程走 `reasonix://new?prompt=...`
  （`if (!embedded || window.parent === window)` 分支）。

改动：`hostMessaging`（host=dsh）时，把 reasonix:// 分支替换为

```ts
window.parent.postMessage({
  type: "taskboard:dsh-execute",
  payload: { taskId, prompt, workspacePath, projectId },
}, "*")
```

同时保留 `dsh-*` 线程的深链（那些是 runner 已建的真实会话）。`reasonix://` 仅在
`!hostMessaging`（独立 Reasonix 运行）时使用。

## client 半改动（`plugin/src/client/index.ts`）

1. `inject: ['sessions', 'workspaces']`（apply 的 ctx 类型相应扩展）。
2. `window` 上监听 `message`，来源为看板 iframe（`event.source === iframe.contentWindow`），
   处理 `taskboard:dsh-execute`：
   - `ctx.sessions.create({ cwd: workspacePath })`（无 workspaceId 时用 cwd）
   - `binding(sessionId).session.prompt([{ type: 'text', text: prompt }], 'queue')`
   - `ctx.sessions.open(sessionId)` 切 GUI
   - 失败时 `ctx.sessions.open` 回看板并回写一条失败评论
3. 回写：执行开始（`RUNNING` 态/评论「已交给 DSH 执行」）、执行完成（从会话快照订阅
   turn 结束 → 回写评论/状态 → 状态写回任务板 API）。

## 交互细节

- 「在对话中打开」按钮语义保留：新建会话并 prompt（不是 reasonix 对话）。
- 已认领（heartbeat dsh-* 线程）的任务：仍深链打开 runner 会话（现状不变）。
- 看板不抢占 GUI 焦点：新建会话后切到 GUI（用户可见执行过程），看板面板保持
  data-active；用户可手动切回。
- AI 聊天（AI chat catalog）卡片同理可接（阶段 2.1）。

## 验证方案

真实浏览器（验证实例 3095）：
1. 项目已选 + 任务存在 → 点「开始工作」→ 断言 iframe 发出 `taskboard:dsh-execute`、
   client 半创建会话（GUI 会话列表 +1）、提示词进入会话、任务板出现回写评论。
2. 短 prompt + 即时取消（`binding.session.cancel()`）控制 API 消耗；验证重点是
   链路（postMessage → create → prompt 排队 → 回写），不是 agent 完整执行。

## 风险

- `binding(id)` 依赖会话已入列表；create 后若 resolve 未命中，先 `ctx.sessions.refresh()`。
- prompt 文本长度/内容限制以 host 会话服务为准（现有会话输入同路径）。
- 每次执行消耗 API 额度——UI 上用文案明示（`README` 已知限制）。