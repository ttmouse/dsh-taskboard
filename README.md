[English](README.md) | [简体中文](README.zh-CN.md)

# dsh-taskboard

A local-first issue board **plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)**. It embeds a complete task board — Kanban / list / Gantt / workflow / dashboard views plus per-task AI chat — into the DSH Web GUI. Data lives in a local SQLite database (`~/.dsh/storages/dsh-taskboard/taskboard.sqlite`); no external service, no cloud dependency.

## Install

```sh
dsh plugin --profile web add @ttmouse/dsh-taskboard
```

Restart `dsh web` afterwards. See [`plugin/README.md`](plugin/README.md) for permissions, configuration, disable and uninstall instructions.

## Features

- **Multi-view task board**: Kanban / list / Gantt / workflow / dashboard
- **Task details**: relations, attachments, labels, filters, and per-task AI chat
- **Auto-claim**: each workspace-mapped project claims its oldest `todo` issue and executes it through dsh-routines (headless session), writing progress back as comments — no heartbeat files, no daemon jobs
- **Workspaces = projects**: DSH workspaces auto-sync into board projects
- **Conversation links**: 「在对话中打开」opens the task in a real DSH session and records the thread id on the task

## Build from source

```sh
# 1) build the SPA
npm install
npm run build

# 2) assemble the plugin artifacts (vendor/ + lib/client.js)
cd plugin && npm install && npm run build
```

## Derivation & Credits

This is an open-source derivative of **[dashi-taskboard (Codex Taskboard)](https://github.com/chuspeeism/dashi-taskboard)** (`chuspeeism/dashi-taskboard`, Apache-2.0); the Web UI, server, and data model originate from it. Upstream Apache-2.0 portions remain under Apache License 2.0 (see [NOTICE](NOTICE)); new and modified portions are licensed under the MIT License (see [LICENSE](LICENSE)).
