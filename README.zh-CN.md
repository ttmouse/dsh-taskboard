[English](README.md) | [简体中文](README.zh-CN.md)

# dsh-taskboard

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的**本地优先任务看板插件**：把完整任务看板——看板/列表/Gantt/工作流/仪表盘视图 + 任务级 AI 对话——挂进 DSH Web GUI。数据存本地 SQLite（`~/.dsh/storages/dsh-taskboard/taskboard.sqlite`），无外部服务、无云端依赖。

## 安装

```sh
dsh plugin --profile web add @ttmouse/dsh-taskboard
```

装完重启 `dsh web`。权限、配置、关闭与卸载说明见 [`plugin/README.md`](plugin/README.md)。

## 功能特性

- **多视图任务看板**：看板 / 列表 / Gantt / 工作流 / 仪表盘
- **任务详情**：关系、附件、标签、过滤器、任务级 AI 对话
- **自动认领**：每个映射工作区的项目自动认领最早的 `todo` 议题，经 dsh-routines 以无头会话执行并把进度回写为评论——无心跳文件、无长驻作业
- **工作区即项目**：DSH 工作区自动同步为看板项目
- **会话链接**：「在对话中打开」以真实 DSH 会话处理任务并回写会话 ID

## 从源码构建

```sh
# 1) 构建 SPA
npm install
npm run build

# 2) 组装插件产物（vendor/ + lib/client.js）
cd plugin && npm install && npm run build
```

## 衍生与致谢

本项目为 **[dashi-taskboard（Codex Taskboard）](https://github.com/chuspeeism/dashi-taskboard)**（`chuspeeism/dashi-taskboard`，Apache-2.0）的开源衍生项目；Web UI、server 与数据模型源自于此。上游 Apache-2.0 部分继续以 Apache License 2.0 授权（见 [NOTICE](NOTICE)）；新增与改造部分以 MIT License 授权（见 [LICENSE](LICENSE)）。
