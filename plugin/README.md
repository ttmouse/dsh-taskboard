# @ttmouse/dsh-taskboard

DSH 双面插件（上游 fork 自 [dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard) / Codex Taskboard）：把完整任务看板（看板/列表/Gantt/工作流/仪表盘/AI 对话）挂进 DSH Web GUI。

## 架构

```
dsh web 宿主进程                         浏览器 GUI
┌─────────────────────────────┐         ┌──────────────────────────┐
│ host 半 (lib/index.mjs)      │         │ client 半 (lib/client.js) │
│  createTaskboardServer()     │         │  侧边栏入口（DOM 注入）    │
│  SQLite + API + SSE          │         │  中间列 iframe 挂载        │
│  listen 127.0.0.1:<port>     │         │  src=/dsh-taskboard/      │
│  webServer.register          │────┐    └──────────┬───────────────┘
│  prefix /dsh-taskboard ──────┼─┐  │               │
└─────────────────────────────┘ │  │  ┌────────────▼──────────────┐
                                │  └──►  webserver (同源代理，无CORS)│
                                └─────►  vendor/web 静态资源 + /api │
                                      └───────────────────────────┘
```

- **host 半**（`lib/index.mjs`）：cordis 插件，在宿主进程内以进程内方式启动上游看板的 server（`node:sqlite`，零 npm 依赖，随插件 vendored 到 `vendor/`），仅监听回环端口；通过 `ctx.webServer.register({ kind: 'prefix', path: '/dsh-taskboard' })` 把完整应用（静态资源 + `/api` + SSE）同源代理到 GUI webserver。
- **client 半**（`src/client/index.tsx` → `lib/client.js`）：走 DSH 官方 slot 契约注册入口（与官方 Plugins / 定时任务面板同一套协议），**不再有 DOM 注入或自定义互斥 CSS**。当前占用的座位：
  - `sidebar.panellist` + `main`（keyed）——左侧栏两个面板行（任务看板 `order 20`、自动化 `order 30`）与中间列 iframe 视图；面板选中/互斥由 shell 的 layout store 负责。
  - `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`（配 `ctx.sidebarRightTabs.register`，kind `taskboard-tasks`）——右栏「任务」tab，按当前会话 `cwd` 匹配看板项目后内嵌列表视图。
  - `conversation.session.header.utilities`（id `taskboard-open`，`order -1`）——会话头部快捷入口：点击调 `ctx.sidebarRight.openTab('taskboard-tasks', { params: { sessionId } })`（该 API 内部会展开右栏，插件不必管展开态）。此槽是 **list 槽，按 `(priority, order)` 升序左→右**；本机其它占用：`open-in-app` `-10`、官方定时任务 `schedule-catalog` `-5`、会话日志「更多操作 ⋯」不写 order（默认 `0`），所以 `-1` 正好落在「⋯」左侧——改动这个数字前先确认同槽其它占用者的 order，不要与 `0` 打平（同 order 只能靠注册顺序决定）。
  - `web-ui.plugin.item`——设置面板里的插件卡片。
  图标统一用官方 `IconChecklistOutlineRegular` 的任务清单几何（内联路径，不引 primitives 包），头部入口与左侧栏任务看板行共用同一图形。
- **数据**：`~/.dsh/storages/dsh-taskboard/taskboard.sqlite`（可配置）。
- **工作区同步**：host 半通过 `ctx.workspaceRegistry.list()` 把 DSH 工作区自动同步为看板项目（项目 id = 工作区 id，`workspace_path` = 工作区路径），启动即同步 + 周期刷新；看板不再创建独立项目，「全局」保留为不挂工作区任务的收纳处。

## 构建

```sh
# 在本仓库根目录构建 SPA
npm run build
# 组装插件产物（vendor/ + lib/client.js）
cd plugin && npm install && npm run build
```

## 安装

### 方式一：npm 发布版（推荐）

```sh
dsh plugin --profile web add @ttmouse/dsh-taskboard
```

### 方式二：本地 link（开发）

```sh
# 1) 加入 profile 依赖（link 形式）
dsh plugin --profile web add link:/Users/douba/Projects/dsh-taskboard/plugin

# 2) 把包名加进 profile 的 bundles 列表（package.json 的 dsh.profile.bundles）
#    ~/.dsh/profiles/web/package.json → "@ttmouse/dsh-taskboard"

# 3) 重启 dsh web
dsh web
```

两种方式装完都需重启 `dsh web`。

## 权限与数据

插件运行在 DSH 宿主进程内，访问以下本地资源：

| 资源 | 用途 |
| --- | --- |
| `~/.dsh/storages/dsh-taskboard/` | SQLite 数据库、附件、配置（可经 `dataDirectory` 重定向） |
| `~/.dsh/routines/taskboard-claim-*.yaml` | 认领例程开关文件（由看板 DB 开关驱动，恒 `paused: true`） |
| 回环端口 `47825` | 内部 HTTP API（认领 prompt / skill 写死的基址，可经 `port` 修改） |
| DSH 工作区注册表 / 会话 API | 工作区 → 项目同步、「在对话中打开」驱动 DSH 会话执行 |

不上传任何数据到外部网络；所有 API 仅监听 `127.0.0.1`。

## 关闭与卸载

- **临时关闭**：设置 `enabled: false`（cordis.yml 或插件设置），或关闭「自动化」面板中的项目认领开关。
- **卸载**：`dsh plugin --profile web remove @ttmouse/dsh-taskboard`（link 安装则 remove 对应 link 包名），然后删除 `~/.dsh/storages/dsh-taskboard/`（连同数据）并重启 `dsh web`。

## 配置（cordis.yml / 设置）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 插件总开关 |
| `dataDirectory` | `~/.dsh/storages/dsh-taskboard` | SQLite/附件/云配置目录 |
| `routePrefix` | `/dsh-taskboard` | GUI webserver 上的代理前缀 |
| `port` | `47825` | 内部回环端口（认领 prompt / skill 写死的 API 基址） |
| `announceToAgent` | `true` | 是否在 system-prompt 中向 agent 宣告本插件 |
| `syncWorkspaces` | `true` | 是否把 DSH 工作区同步为看板项目（工作区 = 项目，自动增减） |
| `syncIntervalMs` | `60000` | 工作区 → 项目同步间隔（ms，0 关闭周期同步） |
| `routinesEnabled` | `true` | 认领例程管理（开关 ⇄ ~/.dsh/routines/taskboard-claim-*.yaml） |

## 与同座位插件的关系

- **`dsh-task-board`**（`github:xuanlanwuta/dsh-task-board`，v1.0.0，本机 web profile 已装且 `disabled: false`）：同样占用会话头部座位（id `kanban-toggle`，`order -10`），并以 `shell.overlay` 渲染自己的看板浮层。它与本插件不共享代码或状态；实测在普通会话里它不渲染任何头部按钮（该槽运行时只有 open-in-app / 本插件 / 会话日志三项），因此没有视觉冲突——但**它占的是同一个槽**，本插件头部入口的 order 需要按上一节的排序规则选取。
- **`@linxin666/dsh-client-ui-task-board`**：本文档早期版本描述的对象，两个 profile 均已不再安装，仓库内除本节外无任何引用。当时为它写的 `data-dsh-taskboard-active` / `dsh-panel-activate` DOM 注入与 `!important` 特异性互斥规则，已随 client 半改走官方 slot 契约一并移除——排查"两个任务看板入口打架"时不要再按那套机制找原因。

需要停用某个同座位插件时，走 profile 覆盖即可：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml（用户层，追加）：
- id: dsh-task-board
  disabled: true
```

## 对 fork 的修复

插件化过程中发现并修复了上游看板代码的子路径部署问题：

1. `web/src/App.tsx` 的 SSE 广播订阅用硬编码绝对路径 `new EventSource("/api/events")`，在 `/dsh-taskboard/` 子路径下丢前缀（改为 `resolveTaskboardUrl("/api/events")`）。其余 API 调用均已走 `resolveTaskboardUrl`（相对 `document.baseURI`）。
2. 新增 `host=dsh` 宿主模式：把父窗口消息协议（主题同步等）与上游遗留的宿主自动化路由解耦，使 iframe 内嵌 DSH 时主题可跟随、自动化走 DSH 会话直连。

## 阶段路线

- [x] 阶段 0：插件包骨架 + host 半拉起现有 server + client 半 iframe 挂载（真实浏览器验证：侧边栏入口、点击激活、视图显示、完整应用渲染、SSE 实时同步）
- [x] 阶段 1：深度集成——主题跟随（GUI ⇄ 看板：`?theme=` 初载 + `taskboard:theme` postMessage 实时推送）、面板互斥（阶段 0 已含）。直接 React 挂载调研后判定成本过高（12296 行 CSS 含 16 处裸元素选择器，Shadow DOM 不可行，需构建期 CSS 作用域变换引擎），降级为可选延后项；地基已预埋（`themeTarget` / `taskboardUrl` / `embed.tsx`，见 `docs/phase1-design.md`）
- [x] 阶段 2：卡片执行接真实 DSH 会话——「在对话中打开」在 host=dsh 模式下发 `taskboard:dsh-execute`，client 半 `inject: ['sessions','workspaces']` → 注册工作区 → `workspaces.startSession` 建会话 → `binding().session.prompt(...,'queue')` 入队 → `sessions.open` 切 GUI → 执行启动评论回写任务板（SSE 实时更新）。已在真实浏览器端到端验证（真实会话创建 + agent 回合执行 + 评论回写），见 `docs/phase2-design.md`
- [x] 阶段 3：i18n 走 client-locale、设置卡片入 `web-ui.plugin.item`、心跳 runner 迁 host 半（进程内 ticker，锁协议与看板状态 API 零改动兼容；验证见 `docs/phase3-design.md`）、`dsh plugin add` 安装体验
- [ ] 阶段 4：卡片执行完成回写（订阅 turn 结束）、`dsh plugin add` 安装后 patch 说明

## License

MIT
