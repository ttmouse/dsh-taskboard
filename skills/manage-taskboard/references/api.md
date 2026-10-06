# dsh-taskboard HTTP API reference

Base URL: `http://127.0.0.1:47825` — loopback only, no auth, JSON in/out.

Every task carries a `version` integer. **All mutations must include the version from the latest read** (optimistic concurrency). A failed write reports a conflict — re-read, retry with the fresh version.

## Projects

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/projects` | List projects (mirrors DSH workspaces + `local` 全局) |
| GET | `/api/projects/<id>/automation` | Claim-automation state `{enabled, intervalMinutes, lastClaimAt}` |
| POST | `/api/projects/<id>/automation` | Set `{enabled: boolean, intervalMinutes?: 5..60}` |

## Tasks

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tasks?projectId=<id>&status=<status>` | List tasks. Filters: `projectId`, `status`, `archived`, ... |
| GET | `/api/tasks/<id>` | Task detail (includes current `version`, title, description, status, labels, relations, ...) |
| POST | `/api/tasks` | Create `{projectId, title, description?, status?, priority?, labels?, dueDate?, ...}` |
| PATCH | `/api/tasks/<id>` | Edit fields `{version, title?, description?, status?, priority?, labels?}` — **flat body, no `changes` wrapper**; this is how labels are applied |
| POST | `/api/tasks/<id>/move` | Move status `{version, status}` — statuses: `backlog, todo, in_progress, in_review, blocked, done, canceled` |
| POST | `/api/tasks/<id>/archive` | Archive `{version}` |
| POST | `/api/tasks/<id>/restore` | Restore `{version}` |

Status flow: `todo` → (claim) → `in_progress` → (verify + comment) → `in_review` → (user acceptance) → `done`. `blocked` / `canceled` for dead ends.

## Comments

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tasks/<id>/comments` | List comments (requirements context, incl. returned-for-changes notes) |
| POST | `/api/tasks/<id>/comments` | Add comment `{body}` (body required; threadId optional) |

## Relations

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/tasks/<taskId>/relations/<type>/<relatedTaskId>` | Add relation `{version}` — types: `parent`, `blocks`, `blocked_by`, `related` |
| DELETE | `/api/tasks/<taskId>/relations/<type>/<relatedTaskId>` | Remove relation `{version}` |

Relation types are **underscore-only**; the server rejects `blocked-by` / `sub` / `relates-to` / `duplicates` with 400 `INVALID_FIELD`. Direction: `POST /api/tasks/A/relations/blocked_by/B` records **B blocks A**; `parent` records the related task as the parent of the path task; `related` is symmetric. Read them back as `relations.blockedBy` / `blocks` / `parent` / `subIssues` / `related`.

## Examples

```sh
BASE=http://127.0.0.1:47825
# Agent identity for write attribution (otherwise the board records 本地用户):
AGENT_HEADERS=(-H "X-Taskboard-Client: taskctl" \
  -H "X-Taskboard-Agent-Id: ${TASKCTL_AGENT_ID:-dsh-agent}" \
  -H "X-Taskboard-Agent-Name: ${TASKCTL_AGENT_NAME:-DSH Agent}")
# List open todos of a project
curl -s "$BASE/api/tasks?projectId=<projectId>&status=todo"
# Read one task (get its latest version)
curl -s "$BASE/api/tasks/<taskId>"
# Edit fields — apply triage labels this way (not via /move). Body is flat: `changes` is rejected.
curl -s -X PATCH "$BASE/api/tasks/<taskId>" "${AGENT_HEADERS[@]}" \
  -H 'Content-Type: application/json' \
  -d '{"version": <latestVersion>, "labels": ["ready-for-agent"]}'
# Blocking edge: <blocker> blocks <taskId>
curl -s -X POST "$BASE/api/tasks/<taskId>/relations/blocked_by/<blocker>" "${AGENT_HEADERS[@]}" \
  -H 'Content-Type: application/json' -d '{"version": <latestVersion>}'
# Claim it (write -> agent headers; threadId links the task to this session)
curl -s -X POST "$BASE/api/tasks/<taskId>/move" "${AGENT_HEADERS[@]}" \
  -H 'Content-Type: application/json' \
  -d '{"version": <latestVersion>, "status": "in_progress", "threadId": "<sessionId>"}'
# Comment + move to review
curl -s -X POST "$BASE/api/tasks/<taskId>/comments" "${AGENT_HEADERS[@]}" \
  -H 'Content-Type: application/json' \
  -d '{"body": "关键改动/验证结果/剩余风险", "threadId": "<sessionId>"}'
curl -s -X POST "$BASE/api/tasks/<taskId>/move" "${AGENT_HEADERS[@]}" \
  -H 'Content-Type: application/json' \
  -d '{"version": <newLatestVersion>, "status": "in_review"}'
```
