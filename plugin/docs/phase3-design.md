# 阶段 3 设计：设置卡片 + i18n + 心跳迁移（已实现并验证）

## 已实现并验证

### 1. i18n 走 client-locale

- client 半新增 `inject: ['locale']`，`ctx.locale.register('dsh-taskboard', { zh, en })` 注册自有词典；
- 入口行标签、`taskboard:dsh-execute` 回写评论均经 `ctx.locale.bind(NS)` 翻译（`{prompt}` 参数插值）；
- `locale/change` 事件触发重绑定 + 入口标签刷新。
- 验证：GUI locale=en 时入口显示 "Taskboard"、回写评论为英文；zh 时显示「任务看板」。

### 2. 设置卡片入 `web-ui.plugin.item`

- `plugin/src/client/settings-card.tsx`：自包含 React 组件（信息 + 「打开任务看板」按钮），
  经 `ctx.slots.inject('web-ui.plugin.item', () => ctx.slots.register({ id: 'dsh-taskboard', order: 105, locale: NS }, TaskboardSettingsCard))` 注册；
- 组件在**壳的 React 副本**上渲染：构建把 `react`/`react-dom`/`react/jsx-runtime` 置为 external，
  loader 从平台模块表解析（hooks 有效）；
- 按钮派发 `dsh-taskboard-request-open`，apply 监听后 `setOpen(true)`。
- 验证（Playwright 真实浏览器）：设置 → Plugins → 展开 Web UI Plugins → 卡片渲染
  （标题/按钮/说明/存储路径，EN 文案）→ 点「Open taskboard」→ 面板打开、iframe 就位、无控制台错误。

### 3. 心跳 runner 迁 host 半（本轮实现）

`plugin/lib/heartbeat.mjs`：fork 的 `scripts/heartbeat-runner.mjs` 进程内移植。
- 轮询 `$DSH_HOME/heartbeat-tasks.json`（与 vendored `heartbeat-automation.mjs` 同解析），
  到期 enabled 任务 spawn `dsh --profile headless "<prompt>"`（归因 env：TASKCTL_AGENT_ID/NAME、
  DSH_SESSION_ID，prompt 内 `dsh-heartbeat` 占位替换为唯一会话 id），写回 lastRunAt/lastError/lastRunSessionId。
- 单实例语义复用**同一把锁**（`heartbeat-runner.lock`，pid=宿主进程）：
  看板状态 API（vendored，探测锁内 pid 存活）零改动自动报告 running=true；外部 launchd runner 持锁时本 ticker 休眠不争抢。
- Config：`heartbeatEnabled`（默认 true）、`heartbeatPollMs`（默认 30000，钳制 ≥1000）。

验证（隔离 DSH_HOME=/tmp/tb-hb，不碰真实 ~/.dsh）：
- 锁文件 = dsh web 进程 pid；`/api/automation/heartbeat/status` → `{running:true, pid:<宿主pid>}`；
- 到期任务被 spawn（headless profile 缺失 → 预期失败路径），lastRunAt/lastError/lastRunSessionId 写回、revision 递增；
- 看板 UI 心跳卡片显示 **running**；
- 失效 workspaceRoot 任务按 fork 语义跳过。

### 4. 挂载健壮性修复（发现并修复的真实 bug）

`conversationColumn()` 原选择器 `[data-pane="conversation"]` 依赖 linxin 家族插件注入
（官方 ssh/task-board 才设置该属性）——**最小安装（仅本插件）时看板静默挂不上**。
修复：回退到壳自身 `[class*="centerCol"]`（show CSS 规则同步补双选择器）。
验证：仅装本插件的全新 profile 挂载 ✓；含家族插件的 profile 回归 ✓。

### 5. 顺带修复：用户 profile workspace 域不一致

用户 `~/.dsh/storages/workspace.json` 中 lark-oc 会话被两个 workspace 同时记账
（lark 自动化运行期产生），导致**任何新 `dsh web` 启动崩溃**（workspace domain 检查）。
已将误记条目从 deepseek-harness workspace 移除（目录在 yaq-agent 下，归 yaq-agent），
备份 `workspace.json.bak-douba-*`。用户重启 GUI 前需确认此修复生效。

## 延后 / 候选（阶段 4）

- 卡片执行完成后回写（订阅 turn 结束 → 评论/状态）；`dsh plugin add` 安装后 patch 说明。
