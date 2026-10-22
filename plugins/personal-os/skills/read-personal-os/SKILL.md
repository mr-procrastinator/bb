---
name: read-personal-os
description: Read user goals and their saved tasks from the Personal OS plugin in BB. Use for reviewing priorities, next steps, blockers or task context; this plugin does not write or execute work.
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

If the host is unconfigured, show the missing setup. For explicit setup, an operator selects the exact
enrolled Mac host ID with `bb plugin config personal-os set hostId <host_id>`. Never choose another host
or expose port7317 merely to make a read succeed. Further setup and limits are in [the plugin README](../../README.md).

The plugin cannot start agents, edit goals, answer decisions, change priorities, or open a Codex Desktop
chat. Read operations do not grant those actions. Personal OS owns user-goal acceptance; AiweApps owns
domain quality and acceptance of its product delivery.
