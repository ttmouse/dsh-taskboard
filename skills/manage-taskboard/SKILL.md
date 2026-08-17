---
name: manage-taskboard
description: Manage taskboard projects, issues, comments, and status transitions through the dsh-taskboard HTTP API (localhost:47825). Use when the agent needs to track a new requirement, inspect project work, create or update issues, add progress notes, claim a task, record completion, or coordinate concurrent updates. The API is the single interface of the dsh-taskboard plugin — no taskctl, no CLI.
---

# Manage Taskboard

Use the dsh-taskboard HTTP API for every project, issue, and comment operation. Base URL: `http://127.0.0.1:47825` (loopback, no auth). Read [references/api.md](references/api.md) before choosing an endpoint or field.

## Attribution rule

Every mutation (move, comment, relation) must declare its actor — otherwise
the board records the change as the local user (本地用户). Send the agent
identity headers on every write:

```sh
-H "X-Taskboard-Client: taskctl" \
-H "X-Taskboard-Agent-Id: ${TASKCTL_AGENT_ID:-dsh-agent}" \
-H "X-Taskboard-Agent-Name: ${TASKCTL_AGENT_NAME:-DSH Agent}"
```

Reads may omit them. The recorded actor becomes the AI Agent, and the change
is attributed correctly in the activity feed.

## Concurrency rule (non-negotiable)

Every write response returns the task's current `version`. Every mutation must carry the version from the **latest read** (`GET /api/tasks/<id>`). A `version` mismatch means someone else updated the task — re-read, reconcile, and retry with the fresh version. Never write without a version; never overwrite a newer state.

## Workflow

1. Search for an existing issue before creating one. List the project's issues (`GET /api/tasks?projectId=<id>`), compare identifiers, titles, descriptions, and status.
   - If an issue already tracks the same requirement, append the new requirement or acceptance detail to that issue without discarding its existing scope.
   - If the work depends on, blocks, is blocked by, or is closely related to another issue, add the matching issue relation.
   - Use a parent/sub-issue relation when one requirement is a contained part of a larger issue. A child has one parent; a parent may have many sub-issues.
   - Create a new issue only when no existing issue reasonably tracks the requirement.
   - Do not create, append, or relate a tiny or trivial request that does not benefit from durable tracking.
2. Before executing an issue, read the latest issue content (`GET /api/tasks/<id>`) and all comments (`GET /api/tasks/<id>/comments`). Treat comments as part of the current requirements, especially when completed work has been returned for changes.
   - In a description or comment, `![alt](/api/attachments/<id>/content)` marks an inline image at that exact position in the text. When understanding that image is necessary, download it (e.g. `curl -o /tmp/attachment <base>/api/attachments/<id>/content`) and inspect the saved file with an available image-viewing tool.
3. Create or update issues with `POST /api/tasks` / `POST /api/tasks/<id>/move`; consume their JSON output. Issues created through the API belong to the project you pass in `projectId`.
4. To claim a `todo` issue, move it to `in_progress` (`POST /api/tasks/<id>/move` with `{"version": <latest>, "status": "in_progress"}`) before starting implementation. If the claim reports a version conflict, or a fresh read shows the status changed, skip the issue and do not implement it.
5. Include the latest `version` on every concurrent update (move, comment, relation, archive), using the version returned by the most recent read.
6. Before requesting review, verify the requested work and acceptance criteria.
7. After implementation and self-verification, add a comment summarizing the key changes, verification, result, and remaining risks (`POST /api/tasks/<id>/comments` with `{"body": "..."}`); then move the issue to `in_review` with the latest version. Never move it directly to `done`.
8. Move an issue from `in_review` to `done` only when the user explicitly confirms acceptance or explicitly asks to mark it complete. Self-verification alone is not sufficient.
9. Move work that cannot continue to `blocked`, and work that will not continue to `canceled`.

For version conflicts outside the initial claim, read the issue again, reconcile the newer state, and retry with its current version.
