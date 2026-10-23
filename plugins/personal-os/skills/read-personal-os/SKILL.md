---
name: read-personal-os
description: Read user goals and saved tasks from Personal OS in BB. Use for priorities, next steps, blockers or task context; save an owner instruction only when explicitly requested. This plugin does not execute work.
---

Use the plugin's typed CLI rather than reading Personal OS SQLite or copying tasks into BB Tasks:

```sh
bb personal-os missions
bb personal-os mission <mission_id>
bb personal-os tasks <mission_id>
bb personal-os task-activity <task_id>
bb personal-os mission-activity <mission_id>
bb personal-os task-result <task_id> <task_execution_binding_id>
bb personal-os task-code-result <task_id> <task_execution_binding_id>
bb personal-os inputs
bb personal-os inputs <mission_id>
bb personal-os input <note_id>
bb personal-os input-artifact <note_id> <input_result_id>
bb personal-os task-chat <task_id>
```

Choose the exact mission ID returned by `missions`. Responses are JSON. Exit code 2 means unavailable,
not an empty task list. A partial task list is marked `truncated`; counters may cover more rows than
the returned items. The plugin has no background refresh: `observedAt` is API read time, not fact freshness.

Keep `doing`, an agent's report, and accepted work separate. A historical `done` does not count as current
completion. Applied skills and evidence counts are recorded claims, not independent inspection.
Mission and task reads are separate observations; do not claim one atomic snapshot.

Task activity reads saved phases through explicit owner bindings. A mission batch is bounded to 50
tasks and one binding/dispatcher each; a task detail reads up to five of each. Preserve truncation,
current/historical flags, and `live_process_verified:false`. Match the activity's task version to the
displayed task version before calling its phase current. A missing binding is not proof that the task
never ran elsewhere. Dispatcher `last_error` is history, separate from the current error.

Read `task-result` only with a binding ID returned for that exact task. The owner verifies the receipt;
the BB host verifies the exact bytes before projecting structured research. A received file can be
read before inbox attachment. Historical files remain historical. Metadata alone does not prove that
the file is currently accessible. Do not infer task completion or domain acceptance from a phase,
received file or consumer review. No dispatcher, task mirror, code/bundle download or new artifact
store is added by these commands.

Use `task-code-result` only for an explicit `artifact_kind:code` binding returned by that
exact task's bounded activity read. It rereads the owner-verified retained package, then
checks raw manifest size/hash, exact attempt/input identity, file set and saved reconstruction
proof before public projection. A reconstructed package has code.json, proposal.patch and
proposal.bundle; `not_produced` can retain a report and optional patch without a complete
package. Manifest limit is 256 KiB; patch 2 MiB; bundle 8 MiB. No file contents are applied,
executed or downloaded to the browser. Checks are executor reports; an empty list is not a
passed check. Preserve historical/unknown flags and distinguish byte integrity, saved Git
proof, native Delivery and overall acceptance. Omitted older code bindings are not a full archive.

Personal instructions are separate from goal-bound instructions. Read a note's original plan and
partial results through `input`; do not reconstruct them from chat summaries. `input-artifact`
verifies exact attachment bytes and projects structured text with that result's scoped review.
Hash verification is not product acceptance. A triage plan is proposed work, not execution. Its
mission-version flag is an audit comparison, not a semantic quality verdict.

Only when the user explicitly asks to open the task's linked chat, first read `task-chat` and use
the displayed monotonic link version:

```sh
bb personal-os open-task-chat <task_id> <expected-link-version>
```

The server rereads the owner binding and delegates to the existing Codex Desktop opener with an
expected-host constraint. Never infer a Desktop UUID from a BB/provider ID, title or directory.
Stale observations are not live activity. Opening acts on the configured Mac, including requests
from a phone. `open_requested` does not confirm the visible destination; unknown outcomes require
inspection before another explicit request. Opening does not create a chat or send a message.

Reading is the default. Only when the user explicitly asks to save an instruction, use:

```sh
bb personal-os submit <request-uuid> <quoted-text>
bb personal-os submit-mission <request-uuid> <mission_id> <expected-version> <quoted-text>
bb personal-os submit-task <request-uuid> <mission_id> <expected-mission-version> <task_id> <expected-task-version> <context_hash> <quoted-text>
bb personal-os submission <request-uuid>
```

Choose personal input unless the user explicitly targets a goal or task. For a task, pin its exact
ID/version, goal/version and semantic context hash. Saving it does not mutate task state or publish
a duplicate task. Never change these fields to recover an uncertain save.
For goal input, read that exact goal
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

Only when the user explicitly answers an existing local owner question, use:

```sh
bb personal-os owner-actions <mission_id>
bb personal-os answer-owner-action '<request-json>'
```

Submit the exact displayed answer envelope. Preserve
the returned configured-host hash, UUID, question/mission versions, context and chosen option.
A retry sends the same POST even if a later question read is resolved or omits that question.
Host changes and unknown HTTP outcomes keep recovery pending; do not substitute another host
or request. A saved answer records a local choice, not a grant or execution authority.

If the host is unconfigured, show the missing setup. For explicit setup, an operator selects the exact
enrolled Mac host ID with `bb plugin config personal-os set hostId <host_id>`. Never choose another host
or expose port7317 merely to make a read succeed. Further setup and limits are in [the plugin README](../../README.md).

The plugin can save owner input and explicitly request opening an owner-bound Desktop chat, but cannot
start agents, edit goal/task status or change priorities. Local owner-question answers require the
explicit user instruction and exact recovery envelope described above. Read operations do not grant
those actions. Personal OS owns user-goal acceptance; AiweApps owns
domain quality and acceptance of its product delivery.
