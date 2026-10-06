# Issue Tracker

Issues for this repo live in the **local dsh-taskboard board** — the SQLite-backed service this repo's own DSH plugin runs on loopback.

- Base URL: `http://127.0.0.1:47825` (loopback only, no auth, JSON in/out)
- Project: `dsh-taskboard`, `projectId` = `09582f74-f86a-44f6-b9d3-500fc168e291`
- The board is served by the running DSH host. If a request is refused, the board simply isn't running — say so; do not fall back to another tracker.
- Complete API surface lives in the `manage-taskboard` skill (`references/api.md`). This file is the **mapping** the engineering skills need.

## Vocabulary mapping

| mattpocock/skills concept | This tracker |
| --- | --- |
| issue / ticket | task |
| issue id | task `id` (uuid); quote the human-readable `identifier` when talking to a human (e.g. `09582F74F86A-13`, shape `<projectPrefix>-<n>`) |
| issue body | task `description` (Markdown) |
| open / in progress / closed | 7 statuses: `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`, `canceled` |
| agent-ready issue | `status: todo` + the `ready-for-agent` label |
| blocking edge | relation `blocks` / `blocked_by` (native blocking links between tasks) |
| parent / child | relation `parent` (a child has one parent; a parent may have many sub-issues — read as `relations.parent` / `relations.subIssues`) |
| label | free-form string in the task's `labels` array (max 20, no duplicates) — no registry to create first |
| comment | task comment: `POST /api/tasks/<id>/comments` |
| assignment / ownership | `assignee` (+ `participants`) |

**Status flow the board enforces:** `todo` → claim → `in_progress` → comment + `in_review` → **human acceptance** → `done`. `blocked` / `canceled` are the dead ends. Never move straight to `done`: `done` is the human's call, not the agent's.

## Concurrency (non-negotiable)

Every task carries a `version`. Read the task first (`GET /api/tasks/<id>`), then send that exact version on every mutation. A mismatch means someone else changed it — re-read, reconcile, retry with the fresh version. Never write without a version.

## Write attribution

Every write carries the agent identity headers; without them the board records the change as 本地用户:

```sh
AGENT_HEADERS=(-H "X-Taskboard-Client: taskctl" \
  -H "X-Taskboard-Agent-Id: ${TASKCTL_AGENT_ID:-dsh-agent}" \
  -H "X-Taskboard-Agent-Name: ${TASKCTL_AGENT_NAME:-DSH Agent}")
```

Include `threadId` (the executing DSH session id) in move/comment bodies so the task links back to the conversation that did the work.

## Commands

```sh
BASE=http://127.0.0.1:47825
PROJECT=09582f74-f86a-44f6-b9d3-500fc168e291

# list open issues (open = not done/canceled)
curl -s "$BASE/api/tasks?projectId=$PROJECT&status=todo"

# read one issue — you need this to get the latest version
curl -s "$BASE/api/tasks/<id>"

# create an issue
curl -s -X POST "$BASE/api/tasks" "${AGENT_HEADERS[@]}" -H 'Content-Type: application/json' \
  -d "{\"projectId\":\"$PROJECT\",\"title\":\"…\",\"description\":\"…\",\"status\":\"todo\",\"labels\":[\"ready-for-agent\"]}"

# edit fields — title, description, status, priority, labels (this is how labels are applied)
curl -s -X PATCH "$BASE/api/tasks/<id>" "${AGENT_HEADERS[@]}" -H 'Content-Type: application/json' \
  -d '{"version":<version>,"labels":["needs-triage"]}'

# claim / move status
curl -s -X POST "$BASE/api/tasks/<id>/move" "${AGENT_HEADERS[@]}" -H 'Content-Type: application/json' \
  -d '{"version":<version>,"status":"in_progress","threadId":"<sessionId>"}'

# comment
curl -s -X POST "$BASE/api/tasks/<id>/comments" "${AGENT_HEADERS[@]}" -H 'Content-Type: application/json' \
  -d '{"body":"…","threadId":"<sessionId>"}'

# blocking edge: <blocker> blocks <id>
curl -s -X POST "$BASE/api/tasks/<id>/relations/blocked_by/<blocker>" "${AGENT_HEADERS[@]}" \
  -H 'Content-Type: application/json' -d '{"version":<version>}'
```

Relation types accepted by the running server are exactly `parent`, `blocks`, `blocked_by`, `related` (underscore). Direction: `POST /api/tasks/A/relations/blocked_by/B` records **B blocks A**; `parent` records the related task as the parent of the task in the path.

## PRs as a request surface

**Off.** External pull requests are not treated as incoming requests to triage for this repo.

## How the skills should use this

- `/to-tickets` writes one task per ticket, with `blocked_by` relations for the blocking edges it declares; `/implement` picks any `todo` task whose blockers are all `done`.
- `/triage` applies one of the five label strings in `triage-labels.md` via `PATCH`.
- `/to-spec` reads the thread's tasks (title, description, comments, relations) and writes the spec; it does not move statuses on its own.
- The board's own rule wins over any flow's shortcut: **done requires explicit user acceptance**, and a task in `in_review` or `blocked` that receives a human comment starts a new round on that task.
