# 阶段 1 设计：从 iframe 到直接 React 挂载（含已交付的集成层）

## 结论（2026-08-16，调研 + 实施后修正）

**直接挂载的高成本已实测确认，本阶段改为「保留 iframe + 深度集成」，直接挂载降级为可选延后项。**

## 已交付（阶段 1 集成层，已在真实浏览器验证）

### 1. 主题跟随（GUI → 看板）

- GUI 主题信号：`document.body[data-ds-dark-theme]`（ui-theme 的 boot-theme/ThemePresenter 写入）。
- client 半：iframe 初载带 `?theme=<当前GUI主题>`；`MutationObserver` 监听 body 属性变化，经 App 已有的 `taskboard:theme` postMessage 协议实时推送；load 后 800ms 重试覆盖 React 挂载晚于 load 事件的空窗。
- 验证：body 属性移除后看板实时切到浅色 ✓。

### 2. host=dsh 模式（fork 改动，`web/src/App.tsx`）

问题：App 的父窗口消息协议被 `if (!embedded || window.parent === window) return` 门控，而 `embedded = query.get("host") === "codex"`——用 host=codex 会连带把自动化路由切成「发给 Codex 宿主」（sendAutomationRequest），对 DSH 场景错误（DSH 的 server 就在本机，应走独立直连）。

改动：新增 `hostMessaging = host === "codex" || host === "dsh"`，消息监听 effect 的门控与依赖数组改用 `hostMessaging`。`embedded` 语义（自动化路由、drag-region、expand-sidebar、reasonix 标识）保持不变。

效果：iframe URL `?host=dsh&theme=...` → 主题消息协议开、自动化仍走独立直连。

### 3. 主题桥与 URL 沙箱地基（`web/src/themeTarget.ts`、`web/src/taskboardUrl.ts`、`web/src/embed.tsx`）

为直接挂载预埋的、SPA 构建不引用的独立模块（独立运行行为零变化）：
- `themeTarget.ts`：可注入主题写入目标 + 双向主题桥（`publishTheme`/`onTaskboardThemeChange`）。
- `taskboardUrl.ts`：虚拟 location（`getTaskboardLocation`/`taskboardPushState`/`taskboardReplaceState`），嵌入时把 App 的 history 路由（8 处调用点已改）隔离在私有 URL 空间。
- `embed.tsx`：`mountTaskboard(container, options)` 库入口。

## 直接挂载的成本（延后理由）

1. **样式隔离**：`styles.css` 12296 行含 16 处裸元素选择器（input/button/select/svg…）+ 28 处 `:root`；Shadow DOM 不可行（`:root[data-theme]` 在 shadow 树内永不匹配）；需构建期 CSS 作用域变换引擎（选择器加 `.tb-scope` 前缀 + keyframe 重命名 + dhtmlx-gantt 140KB CSS 逐条核对），这是独立工作包。
2. **收益有限**：iframe 已 100% 像素保真 + 主题跟随 + SSE 实时同步 + 面板互斥；直接挂载的边际收益（无文档边界）不抵回归风险。
3. **回归面**：动 fork 的 App 路由（已完成沙箱）与构建链，需要用户 review。

## 阶段 2 衔接

host=dsh 模式已就位：后续卡片执行接 `ctx.sessions` 的 `session.prompt` 时，可用同一 postMessage 协议（`taskboard:host-context` / 深链）把「在对话中打开」从 reasonix:// 换成 DSH 会话导航。
