# 优化审查记录

> 本文档由 ZCode 定时优化审查任务自动维护：定期扫描近期改动，聚焦最近修改的文件输出有代码依据的优化点。已有条目不重复记录，修复后请在对应条目标注「已修复（日期）」。

最近更新：2026-09-29 03:09

## 2026-09-29 03:09

本轮范围：plugin/package.json（0.5.0→0.5.1）、plugin/src/client/index.ts（style 归属修复，已验证与 build.mjs 注册 id 一致，改动干净）、新增 tmp/ 目录。

- [中] .gitignore:4 — 根目录 `tmp/`（含约 1.5MB 截图和调试脚本）未被忽略，处于未跟踪裸奔状态
  证据：`git status --short` 显示 `?? tmp/`；.gitignore 只写了 `.tmp/`，没有 `tmp/`；目录内有 `crop-*.png` 六张（约 670KB）、`probe-out/`（含多张 `round-*.png`）、`probe.mjs`、`verify-claim.mjs` 等调试产物（9 月 12-13 日）。
  为什么改：`git add -A` 一把就会把调试截图和一次性脚本提交进仓库；且 `.tmp/` 与 `tmp/` 一字之差，很容易以为已经覆盖了。
  怎么改：在根 .gitignore 加一行 `/tmp/`；或者把目录内容挪进已被忽略的 `.tmp/`，顺带消除与 `.tmp/` 的命名混淆。

- [低] plugin/src/client/index.ts:188 vs plugin/scripts/build.mjs:22 — `PLUGIN_ID` 在两处硬编码，靠注释约束同步
  证据：index.ts 新增 `const PLUGIN_ID = '@ttmouse/dsh-taskboard'`，注释说明它与 build.mjs 第 22 行注册进 `window.__ModuleLoader__.load` 的 id 必须一致，但没有任何机制保证；build.mjs 并没有读 package.json。
  为什么改：两个来源一旦漂移，`removeOwnedStyles`/`claimStyles` 的归属 key 对不上，会复发这次修的「style 被别的插件认领后丢失」问题，而且是静默复发。
  怎么改：让 build.mjs 从 `package.json` 读 `name` 作为单一来源，并通过 esbuild `define`（如 `__PLUGIN_ID__`）注入到 client 代码；index.ts 引用该常量而非重复字面量。

- [低] plugin/src/client/index.ts:205-207 — 同一个 style 标签挂了三个属性，其中两个值完全相同，旧的已属冗余
  证据：`tag.dataset.plugin`、`tag.dataset.pluginCss = tagId`、`tag.dataset.taskboardShellCss = tagId` 三行连续；`data-taskboard-shell-css` 全仓库只剩 203 行自查重这一处使用，注释也说官方约定就是 `data-plugin` + `data-plugin-css` 两个。
  为什么改：查重选择器可以直接用 `style[data-plugin-css="${tagId}"]`，省掉一个同值属性；少一个属性就少一处两套标记不同步的可能。
  怎么改：确认 DSH 宿主对 `data-plugin-css` 的用法后，把 203 行的选择器换成 `data-plugin-css`，删除 `data-taskboard-shell-css` 一行（若无其他外部依赖此属性）。
