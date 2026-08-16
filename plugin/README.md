# @ttmouse/dsh-taskboard

独立版 DSH 双面插件（fork 自 [reasonix-taskboard](https://github.com/ttmouse/reasonix-taskboard) / [dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)）：把完整任务看板（看板/列表/Gantt/工作流/仪表盘/AI 对话）挂进 DSH Web GUI。

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

- **host 半**（`lib/index.mjs`）：cordis 插件，在宿主进程内以进程内方式启动 fork 自 reasonix-taskboard 的 server（`node:sqlite`，零 npm 依赖，随插件 vendored 到 `vendor/`），仅监听回环端口；通过 `ctx.webServer.register({ kind: 'prefix', path: '/dsh-taskboard' })` 把完整应用（静态资源 + `/api` + SSE）同源代理到 GUI webserver。
- **client 半**（`src/client/index.ts` → `lib/client.js`）：注入侧边栏「任务看板」入口，在中间列挂载同源 iframe。复用官方插件家族的挂载协议：`data-dsh-taskboard-active` 激活属性 + `dsh-panel-activate` 事件，与 SSH 面板互斥。
- **数据**：`~/.dsh/storages/dsh-taskboard/taskboard.sqlite`（可配置）。

## 构建

```sh
# 在本仓库根目录构建 SPA
npm run build
# 组装插件产物（vendor/ + lib/client.js）
cd plugin && npm install && npm run build
```

## 安装（本地 profile）

```sh
# 1) 加入 profile 依赖（link 形式）
dsh plugin --profile web add link:/Users/douba/Projects/dsh-taskboard/plugin

# 2) 把包名加进 profile 的 bundles 列表（package.json 的 dsh.profile.bundles）
#    ~/.dsh/profiles/web/package.json → "@ttmouse/dsh-taskboard"

# 3) 重启 dsh web
dsh web
```

## 配置（cordis.yml / 设置）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 插件总开关 |
| `dataDirectory` | `~/.dsh/storages/dsh-taskboard` | SQLite/附件/云配置目录 |
| `routePrefix` | `/dsh-taskboard` | GUI webserver 上的代理前缀 |
| `port` | `0`（系统分配） | 内部回环端口 |
| `announceToAgent` | `true` | 是否在 system-prompt 中向 agent 宣告本插件 |

## 与官方 dsh-task-board 的关系

本插件与 `@linxin666/dsh-client-ui-task-board` 共用同一面板互斥协议（`data-dsh-taskboard-active` / `dsh-panel-activate`）。若两者同时安装，侧边栏会出现两个「任务看板」入口，且官方版的隐藏规则（`!important`）会盖住本插件的视图。二选一：本插件已把自身的显示规则提到更高特异性（元素类型选择器 + `!important`），但建议直接禁用官方版：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml（用户层，追加）：
- id: ui-task-board
  disabled: true
```

## 对 fork 的修复

插件化过程中发现并修复了 reasonix-taskboard 的子路径部署问题：

1. `web/src/App.tsx` 的 SSE 广播订阅用硬编码绝对路径 `new EventSource("/api/events")`，在 `/dsh-taskboard/` 子路径下丢前缀（改为 `resolveTaskboardUrl("/api/events")`）。其余 API 调用均已走 `resolveTaskboardUrl`（相对 `document.baseURI`）。
2. 新增 `host=dsh` 宿主模式：把父窗口消息协议（主题同步等）与 Codex 自动化路由解耦，使 iframe 内嵌 DSH 时主题可跟随、自动化仍走独立直连。

## 阶段路线

- [x] 阶段 0：插件包骨架 + host 半拉起现有 server + client 半 iframe 挂载（真实浏览器验证：侧边栏入口、点击激活、视图显示、完整应用渲染、SSE 实时同步）
- [x] 阶段 1：深度集成——主题跟随（GUI ⇄ 看板：`?theme=` 初载 + `taskboard:theme` postMessage 实时推送）、面板互斥（阶段 0 已含）。直接 React 挂载调研后判定成本过高（12296 行 CSS 含 16 处裸元素选择器，Shadow DOM 不可行，需构建期 CSS 作用域变换引擎），降级为可选延后项；地基已预埋（`themeTarget` / `taskboardUrl` / `embed.tsx`，见 `docs/phase1-design.md`）
- [x] 阶段 2：卡片执行接真实 DSH 会话——「在对话中打开」在 host=dsh 模式下发 `taskboard:dsh-execute`，client 半 `inject: ['sessions','workspaces']` → 注册工作区 → `workspaces.startSession` 建会话 → `binding().session.prompt(...,'queue')` 入队 → `sessions.open` 切 GUI → 执行启动评论回写任务板（SSE 实时更新）。已在真实浏览器端到端验证（真实会话创建 + agent 回合执行 + 评论回写），见 `docs/phase2-design.md`
- [x] 阶段 3：i18n 走 client-locale、设置卡片入 `web-ui.plugin.item`、心跳 runner 迁 host 半（进程内 ticker，锁协议与看板状态 API 零改动兼容；验证见 `docs/phase3-design.md`）、`dsh plugin add` 安装体验
- [ ] 阶段 4：卡片执行完成回写（订阅 turn 结束）、`dsh plugin add` 安装后 patch 说明

## License

MIT
