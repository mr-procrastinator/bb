# Personal OS

A BB panel with bounded owner input for the local Personal OS. It displays goals, their next
steps, four task states and task details. Personal OS remains the owner of user goals,
their tasks, received evidence and goal acceptance. AiweApps keeps product quality and
acceptance of its delivery. This plugin does not copy tasks into BB Tasks.

## Configure

Install this local plugin through BB's plugin installer, then set the exact enrolled
BB host ID of the Mac running Personal OS:

```sh
bb plugin config personal-os set hostId <enrolled-host-id>
```

The service must listen at `http://127.0.0.1:7317` on that host.
Reload the plugin after changing its configuration.

The browser calls BB plugin RPC. The server forwards a typed request to the
configured host entry. Only that host accesses Personal OS over loopback. This also
supports a remote browser without exposing port 7317. Remote access to BB itself
must use its configured access boundary; this plugin does not add authentication.

## Use

Open **Personal OS** in the BB sidebar, choose a goal, then open a task card.
The same operations are available through typed plugin RPC and CLI:

```sh
bb personal-os missions
bb personal-os mission mission_0123456789abcdef0123456789abcdef
bb personal-os tasks mission_0123456789abcdef0123456789abcdef
bb personal-os inputs
bb personal-os inputs mission_0123456789abcdef0123456789abcdef
bb personal-os input note_0123456789abcdef0123456789abcdef
bb personal-os input-artifact note_0123456789abcdef0123456789abcdef input_result_0123456789abcdef0123456789abcdef
bb personal-os task-chat task_0123456789abcdef0123456789abcdef
bb personal-os open-task-chat task_0123456789abcdef0123456789abcdef 1
bb personal-os submit 01234567-89ab-4def-8123-456789abcdef "Collect my next three priorities"
bb personal-os submit-mission 11234567-89ab-4def-8123-456789abcdef mission_0123456789abcdef0123456789abcdef 12 "Clarify the next step"
bb personal-os submission 01234567-89ab-4def-8123-456789abcdef
```

CLI responses are JSON. Exit code 0 means a successful read or confirmed saved
input; 1 means known rejection, no configured host before preparation, or no ledger
entry; 2 means an unavailable, blocked or uncertain outcome. Unknown states are
not converted into empty successful lists. Refresh is manual.
Read time records when the plugin read the API, not when an agent last worked.

Task state `doing` is not proof of a running process. Historical `done` tasks do
appear in a separate expandable history, outside current **Готово**. An unspecified
executor remains explicitly unknown. Evidence counts refer to recorded sources, not
independent inspection. Full product acceptance remains separate.

## Instructions, results and linked chats

`listInputs` reads up to 20 personal instructions by default, or instructions for
an explicitly selected goal. Scope is checked against the returned items; general
inbox items are not silently assigned to the active goal. Total count and
`truncated` describe omitted records. `getInput` returns the original text, current
saved note state, original validated triage plan and attached partial results.
The plan records proposed work, not execution. Its goal-version flag compares an
audit version, not semantic product acceptance.

`getInputArtifact` accepts only the note and attached result IDs. The host first
reads that exact attachment's descriptor, then fetches its owner route. It checks
the original byte length and SHA-256 before parsing JSON. Only bounded research
summary, findings, recommendations and limitations reach the browser, alongside
that result's scoped review and currentness. No raw HTML, local URL, receipt
locator, model metadata or source history is projected. A successful byte check
does not change review or complete the instruction.

`getTaskChat` reads Personal OS's explicit task-to-Desktop binding. `openTaskChat`
accepts only a task ID and the displayed link version. It rereads the owner on the
captured configured host and requires current task/context, an available target,
and the same link version. It then calls the existing Codex Desktop plugin opener
with the exact bound UUID and an expected-host constraint. Different plugin host
settings reject opening; a browser cannot choose a host or URL. No workspace or
title matching creates a binding. Stale observations remain marked as such.

Opening is explicit navigation on the configured Mac, including requests from a
phone. `open_requested` retains `navigationConfirmed:false`: it does not prove the
intended chat appeared. Unknown opening outcomes are not automatically retried.
No new chat, message, provider resume or model execution is added.

## Owner input and recovery

`submitInput` accepts a UUID, plain text up to 20,000 UTF-16 code units, and one
explicit target: personal inbox, or a goal ID with the exact version read by the
user. Personal is the default UI scope. The plugin does not silently adopt a
newer goal version. It fixes `input_kind` to `text`.

Before contacting a host, the server transactionally stores the exact command,
its hash and selected host in its plugin SQLite command ledger. This ledger is
transport bookkeeping, not a second task owner or dispatch queue. A retry cannot
change the UUID, text, scope, goal version or host. A changed host setting blocks
an unresolved command. Confirmed saved receipts replay locally without network.
If no host is configured, a terminal `not_sent` ledger entry prevents an older
concurrent call from later sending that UUID. After configuring a host, a new
explicit submission uses a new UUID. A null host exists only in that terminal
entry; an unresolved command always retains its original selected host.

Personal input uses POST `/api/inbox` with `project_id:null`. Goal input uses
POST `/api/missions/<mission_id>/input` with the pinned version. Both use the same
stable `bb-personal-os:<UUID>` idempotency key on every retry. Personal OS owns
deduplication and the atomic note/goal link. A receipt's `new` state describes its
original creation, not the current status of the note or completion of its work.

Timeouts, transport failures and invalid replies leave the outcome unknown. A
validated post-receipt-check rejection such as `version_conflict` or
`idempotency_conflict` can establish rejection. Other HTTP errors do not erase a
previously uncertain outcome. GET-style `getInputSubmission` only reads the
existing local ledger; it does not contact Personal OS or resend. A user-initiated
retry sends the exact stored command and receives the owner's original receipt
if the first request was already saved. Never generate a new UUID to resolve an
unknown outcome.

The UI stores its draft and exact pending request in this browser's local storage.
It does not automatically submit after reload. A pending request locks text and
target until the outcome is established. Drafts are local to this browser, not a
cross-device draft service. The server ledger retains submitted text for exact
recovery; raw commands are not returned through the outcome lookup.
Submission requires Web Locks; without that browser capability, Add is disabled.
The shared local draft and pending request use a lock and compare-before-save
checks across tabs. If another tab changes the shared draft, this tab preserves
its unsent text separately in session storage. Restoration is offered only when
the shared composer is empty and has no pending request. That backup survives a
reload, but not closing the tab.

## Boundaries

Reads use only GET `/api/missions`, `/api/missions/<mission_id>` and
`/api/tasks?mission_id=<mission_id>`, the bounded `/api/inbox` list/detail and
exact note/result artifact routes, and `/api/task-chat-links?task_id=<task_id>`.
Responses are limited to 2 MiB for goals/tasks, 1 MiB for inbox lists, 512 KiB for
instruction details and exact artifact bytes, and 64 KiB for chat bindings;
100 goals and 500 tasks; requests time out after five seconds. IDs and responses
are validated at the host boundary. Redirects are rejected. Raw responses,
credentials, source payloads and arbitrary URLs are not sent to the frontend.
POST uses only the two owner-input endpoints above, with a 16 KiB reply limit.
The host adds the local client header; no credential is copied into the browser.

`/api/control` is deliberately excluded because it records skill observations.
The plugin has no task/status write, dispatch, model or chat-creation action.
Decision answers remain outside this slice. It delegates explicit Desktop
navigation to the existing opener rather than adding a second opener. The command ledger is initialized during plugin loading. Outcome reads
do not initialize storage. There is no background poller or automatic resend.

## Development

From the repository root, after installing this workspace's dependencies:

```sh
pnpm exec turbo run typecheck --filter=bb-plugin-personal-os
pnpm exec turbo run prepare:bundled --filter=bb-plugin-personal-os
```

The plugin uses BB's shared Button component and theme tokens. It has no custom
theme or stylesheet. No automated tests are included or authorized for this work.
Builds and a manual BB UI pass are separate checks; source creation does not
establish that the plugin was installed or the interface was verified.

Ledger migrations are append-only. Migration 0 retains its original non-null host
statement. Migration 1 copies every command field unchanged into a nullable-host
table and swaps it within the SDK migration transaction. This preserves existing
receipts and permits terminal `not_sent` entries; never reset the ledger or edit
an already recorded statement to recover a migration mismatch.
