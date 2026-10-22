---
name: read-personal-os
description: Read user goals and saved tasks from Personal OS in BB. Use for priorities, next steps, blockers or task context; save an owner instruction only when explicitly requested. This plugin does not execute work.
---

Use the plugin's typed CLI rather than reading Personal OS SQLite or copying tasks into BB Tasks:

```sh
bb personal-os missions
bb personal-os mission <mission_id>
bb personal-os tasks <mission_id>
```

Choose the exact mission ID returned by `missions`. Responses are JSON. Exit code 2 means unavailable,
not an empty task list. A partial task list is marked `truncated`; counters may cover more rows than
the returned items. The plugin has no background refresh: `observedAt` is API read time, not fact freshness.

Keep `doing`, an agent's report, and accepted work separate. A historical `done` does not count as current
completion. Applied skills and evidence counts are recorded claims, not independent inspection.
Mission and task reads are separate observations; do not claim one atomic snapshot.

Reading is the default. Only when the user explicitly asks to save an instruction, use:

```sh
bb personal-os submit <request-uuid> <quoted-text>
bb personal-os submit-mission <request-uuid> <mission_id> <expected-version> <quoted-text>
bb personal-os submission <request-uuid>
```

Choose personal input unless the user explicitly targets a goal. For goal input, read that exact goal
and use its displayed version. Do not silently refresh the pinned version during a retry. Generate a
UUID before the first submission and retain the exact UUID, text, scope and goal version until the
outcome is known. The server pins the configured host before contacting Personal OS. Never choose a
different host to recover an uncertain request.

`submission` only reads the command ledger. It does not contact Personal OS, resend, or report the
current note status. `saved` is the original creation receipt, not execution or acceptance. After
`outcome_unknown` or `blocked`, preserve the exact request and resolve it with the same UUID and
payload; a retry can perform the same idempotent POST. Never generate another UUID for an unknown
outcome. A changed host setting blocks unresolved delivery. A terminal `not_sent` means no host was
configured and that UUID cannot later be sent; after setup, a new explicit submission uses a new UUID.

CLI exit code 0 confirms a successful read or saved receipt. Code 1 covers known rejection, terminal
`not_sent`, or a missing ledger entry. Code 2 means unavailable, blocked or unknown; keep its content
and target. A missing ledger entry is not permission to substitute a different request. Saving input
does not grant execution, dispatch, or automatic chat creation.

If the host is unconfigured, show the missing setup. For explicit setup, an operator selects the exact
enrolled Mac host ID with `bb plugin config personal-os set hostId <host_id>`. Never choose another host
or expose port7317 merely to make a read succeed. Further setup and limits are in [the plugin README](../../README.md).

The plugin can save owner input, but cannot start agents, edit goal/task status, answer decisions, change priorities, or open a Codex Desktop
chat. Read operations do not grant those actions. Personal OS owns user-goal acceptance; AiweApps owns
domain quality and acceptance of its product delivery.
