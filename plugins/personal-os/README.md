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

Open **Personal OS** in the BB sidebar. If exactly one saved goal is active, the
default route opens its task board. Otherwise it shows the goal chooser. The explicit
**Цели** route keeps that chooser open. This navigation does not bind personal input
to a goal. The composer starts with **Личное входящее**; **К текущей цели** is an explicit
choice that pins the displayed goal version. Existing drafts keep their own target.
**Личные поручения** opens the single instruction list in personal scope, including
from a goal board. **Эта цель** explicitly selects goal-linked instructions in that
same list; it does not create another feed or change the composer target.
Read and save operations are also available through typed plugin RPC and CLI:

```sh
bb personal-os missions
bb personal-os owner-actions <mission_id>
bb personal-os answer-owner-action '<request-json>'
bb personal-os mission mission_0123456789abcdef0123456789abcdef
bb personal-os tasks mission_0123456789abcdef0123456789abcdef
bb personal-os task-activity task_0123456789abcdef0123456789abcdef
bb personal-os mission-activity mission_0123456789abcdef0123456789abcdef
bb personal-os task-result task_0123456789abcdef0123456789abcdef task_execution_0123456789abcdef0123456789abcdef
bb personal-os task-code-result <task_id> <task_execution_binding_id>
bb personal-os inputs
bb personal-os inputs mission_0123456789abcdef0123456789abcdef
bb personal-os input note_0123456789abcdef0123456789abcdef
bb personal-os input-artifact note_0123456789abcdef0123456789abcdef input_result_0123456789abcdef0123456789abcdef
bb personal-os task-chat task_0123456789abcdef0123456789abcdef
bb personal-os open-task-chat task_0123456789abcdef0123456789abcdef 1
bb personal-os submit 01234567-89ab-4def-8123-456789abcdef "Collect my next three priorities"
bb personal-os submit-mission 11234567-89ab-4def-8123-456789abcdef mission_0123456789abcdef0123456789abcdef 12 "Clarify the next step"
bb personal-os submit-task <request-uuid> <mission_id> <expected-mission-version> <task_id> <expected-task-version> <context_hash> "Clarify this task"
bb personal-os submission 01234567-89ab-4def-8123-456789abcdef
```

CLI responses are JSON. Exit code 0 means a successful read or confirmed saved
input/answer; 1 means known rejection, no configured host before input preparation, or no ledger
entry; 2 means an unavailable, blocked or uncertain outcome. Unknown states are
not converted into empty successful lists. There is no polling; explicit reads and
confirmed saves refresh their own views.
Read time records when the plugin read the API, not when an agent last worked.

Task state `doing` is not proof of a running process. Historical `done` tasks do
appear in a separate expandable history, outside current **Готово**. An unspecified
executor remains explicitly unknown. Evidence counts refer to recorded sources, not
independent inspection. Full product acceptance remains separate.

## Task activity

`getMissionActivity` reads one batch of up to 50 tasks, with at most one binding
and dispatcher per task. `getTaskActivity` reads up to five bindings and five
dispatchers for one exact task. Counts and truncation remain explicit. Current
and historical bindings are separate; a missing registered binding does not prove
that no one worked on the task through another tool.

The projection reports saved continuation phases, received file metadata and
scoped review. It explicitly retains `live_process_verified:false` and does not
change task status or acceptance. Dispatcher current errors are separate from
historical `last_error`. The task version is included in task reads so the UI can
fence an activity observation against the version of the displayed task. These
remain separate reads, not an atomic task/activity snapshot.

`getTaskResult` accepts only an exact task ID and its execution binding ID. It
rereads the owner's binding and received receipt, matches its delegation,
attempt and revision to the bound continuation, then fetches the owner's verified
task artifact route. The shared research reader verifies raw size and SHA-256
before JSON parsing. Only structured research content and that binding's review
and currentness are projected. This works before an inbox-result attachment
exists. Historical exact results remain readable with historical flags. Current
file accessibility is established only when the read succeeds; metadata alone
retains `availability:not_rechecked`.

`getTaskCodeResult` / `task-code-result` is a separate reader for a binding explicitly
marked `artifact_kind:code`. **Проверить code-пакет** opens its exact task/binding page.
The activity projection contains metadata only. An explicit file read asks the owner
to recheck all retained package files and their saved reconstruction proof. BB then
verifies the raw `code.json` size and SHA-256 before parsing, matches delegation,
attempt, revision, input hash and the exact retained-file set, and returns public
summary/checks/file names. Repository paths and private receipt/source fields stay
on the host. Code results require a binding in the bounded five-item task history;
omitted older code bindings are unavailable through this reader.

A reconstructed package has `code.json` (≤256 KiB), `proposal.patch` (≤2 MiB) and
`proposal.bundle` (≤8 MiB). A failed `not_produced` attempt can retain only its report
and optional patch; it is not shown as a complete package. Checks are reported by
the executor; an empty check list remains unknown work, not a passed check. The
page displays saved Git reconstruction proof without running Git, building, applying
or downloading the proposal. Full-set native Delivery is separate from byte
integrity and from product/goal acceptance. The research reader remains unchanged.

Task activity also exposes `completion` as a separate projection of recorded
completion grounds. A `done` task update can increment task version while its
explicitly referenced result remains valid evidence. The old execution binding
still stays historical and cannot authorize another launch. Completion state is
read from the task; neither receiving a file nor its consumer review creates it.

Only exact `artifact-receipt:artifact_receipt_<32hex>` and
`consumer-review:consumer_review_<32hex>` evidence locators are resolved. A file
receipt must match one exact task/continuation binding and any recorded SHA-256.
The named review must match that same explicitly recorded file and its candidate;
the shared quality reader selects that exact review, including an older review,
instead of substituting the latest. A review source carrying an unsupported
SHA-256 stays unavailable. Other sources, including compressed evidence reports,
remain `recorded_only` and are never opened by this projection. Raw locators and
private paths do not reach the browser. Resolution confirms identity, not that
all task requirements are fulfilled or that the whole goal passed acceptance.

An explicitly resolved completion file can be opened even when its execution
binding is older than the five-item activity history. The existing raw-byte
reader and owner route still verify its exact identity, size and hash. The result
response keeps `completionEvidence` separate from execution currentness and its
review, so recorded completion grounds do not silently enable historical work.

This slice does not add code/bundle downloads, another artifact store, automatic
dispatch or editable task copies. Opening a file does not complete the task or
promote its consumer review to domain acceptance.

### Profile inspection

Attempt reviews and pinned completion reviews may include a bounded readiness
projection for that exact candidate/review pair. It records the proposed goal
profile, five dimensions, the report's requirement scope, explicit criterion/state
entries and remaining blockers. It is not a native quality gate. Numeric scores
have `score_origin: assessment_request`; they are recorded claims, not inferred
reviewer grades. Unknown scores remain null. `reported_checked` counts supplied
entries, including unknown/not_run; it does not count successful scenarios.

The task and exact-file pages show this projection next to the corresponding
review. Matching candidate/review IDs prevent substitution from another attempt;
the same review is not rendered twice. No new board summary or status writer is
added. Calibration, independence and profile adoption remain unconfirmed; opening
the projection never performs inspection, checks files or completes work. Profile
payloads, source locators and actor metadata stay on the owner.

## Native Delivery and exact profile reads

`TaskExecutionBinding.domainDelivery`, completion-file grounds and
`TaskResult.data.domainDelivery` expose only an exact received file's saved native
Delivery metadata. Personal OS reads the existing synchronized snapshot; GET does
not contact AiweApps, inspect files, create schema, or run a reviewer. The native
collection contains at most five deliveries with total count and truncation.
DID/revision/attempt/input/request/profile and artifact hashes are bound before
selecting a record. Historical profile hashes remain native-owner attestations;
private resolved profiles are not copied or independently revalidated here. A historical R1 file cannot inherit R2's result. Missing,
contradictory or omitted history stays unavailable; known absence is not_assessed.

`passed`, the outcome and native `acceptance` are separate fields. Native acceptance
is an acknowledgement for that bounded native delivery, not task completion,
mission acceptance, or an owner quality rating. `files:not_rechecked` describes Delivery metadata; the separate exact artifact
read verifies bytes without rewriting that metadata. Legacy `execution.quality_gate:not_run` and
immutable result manifests are unchanged. An old missing input hash leaves Delivery
unknown without hiding the existing task or received file. The shared Delivery DTO also
recognizes `bounded_code_source_review`. This does not add a code-file reader:
`getTaskResult` and its page still accept only the verified research result.

`getQualityProfile({missionId,profileId,version,profileHash})` and the CLI below use
only the fixed exact-version owner route. The host checks all four identities and
returns proposed criteria, states and example/counterexample descriptions. Source
locators, reference hashes, credentials and private policy are omitted. Historical
profiles retain their currentness flags; reading a profile does not adopt it or
verify its declared examples.

```sh
bb personal-os quality-profile <mission_id> <profile_id> <version> <profile_hash>
bb personal-os quality-reference <mission_id> <profile_id> <version> <profile_hash> <dimension_id> <example|counterexample> <sample_id>
```

The profile page offers an explicit **Просмотреть материал** action.
`getQualityReference` uses the exact mission/profile/version/hash, dimension, sample
kind and sample ID. It reads only an owner-approved local reference with a pinned
SHA-256. The host and browser check the selected identity, decoded size and hash
before showing plain UTF-8 text or a PNG/JPEG preview. Images are limited to 2 MiB,
text to 256 KiB, and the response envelope to 3 MiB. Missing hashes, unsupported
sources, changed bytes or unavailable files keep the content hidden. No latest
profile or other sample substitutes for the selected one. Previewing bytes does
not confirm the sample, calibrate a reviewer or adopt the profile; historical and
unknown currentness remain explicit. Private source locators are not returned.
**Во весь размер** expands the same verified image inline, without refetching it or
opening a modal. **100%** retains its pixel size with scrolling; **По ширине** fits the
page. **Свернуть** or Escape restores the compact preview. This is a viewing mode,
not a second file or another integrity/acceptance result.

These are source-level read capabilities. Deployment, build and manual UI results
must be recorded separately; this section does not establish a live pass.

## Instructions, results and linked chats

`listInputs` reads up to 20 personal instructions by default, or instructions for
an explicitly selected goal. Scope is checked against the returned items; general
inbox items are not silently assigned to the active goal. Total count and
`truncated` describe omitted records. `getInput` returns the original text, current
saved note state, original validated triage plan and attached partial results.
The plan records proposed work, not execution. Its goal-version flag compares an
audit version, not semantic product acceptance. Optional `task_input` keeps the exact
recorded task/version/context and currentness; absent metadata remains unknown.
`plan_tasks` links a saved plan action by its exact run and ordinal to the task that
was published. Titles do not create or infer those links.

`getInputArtifact` accepts only the note and attached result IDs. The host first
reads that exact attachment's descriptor, then fetches its owner route. It checks
the original byte length and SHA-256 before parsing JSON. Only bounded research
summary, findings, recommendations and limitations reach the browser, alongside
that result's scoped review and currentness. No raw HTML, local URL, receipt
locator, model metadata or source history is projected. A successful byte check
does not change review or complete the instruction.

Both full research pages render structured report text as restricted Markdown with
GFM tables. HTML and media are excluded; links must be absolute HTTPS URLs. Tables
scroll inside the report. Long text keeps a read-more control without cutting the
Markdown source mid-table. Collapsed links remain plain text. Original instructions,
plans and partial-result summaries retain their existing plain-text presentation.
This rendering does not change the file, integrity check, currentness or scoped review.

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
explicit target: personal inbox, a goal/version, or an existing task with its goal
version, task version and semantic context hash read by the user. Personal is the default UI scope. The plugin does not silently adopt a
newer goal version. Optional `inputKind` is `text` or `voice`; omitted values retain
the existing `text` behavior. A dictation draft explicitly selects `voice`. This is
an input-origin label, not an audio upload or an execution request.

Before contacting a host, the server transactionally stores the exact command,
its hash and selected host in its plugin SQLite command ledger. This ledger is
transport bookkeeping, not a second task owner or dispatch queue. A retry cannot
change the UUID, text, input kind, scope, task/goal versions, context hash or host. A changed host setting blocks
an unresolved command. Confirmed saved receipts replay locally without network.
If no host is configured, a terminal `not_sent` ledger entry prevents an older
concurrent call from later sending that UUID. After configuring a host, a new
explicit submission uses a new UUID. A null host exists only in that terminal
entry; an unresolved command always retains its original selected host.

Personal input uses POST `/api/inbox` with `project_id:null`. Goal input uses
POST `/api/missions/<mission_id>/input` with the pinned version. Task input uses
POST `/api/tasks/<task_id>/input` with the exact mission ID/version, task version
and context hash. All three use the same stable `bb-personal-os:<UUID>` idempotency
key on every retry. Personal OS owns
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

**Дополнить задачу** opens the existing composer from a current task. An empty
draft can select that task; existing text requires an explicit **К этой задаче**
choice. Pending input cannot be rebound. Saving appends a note and immutable task
binding, increments the mission audit version, and leaves task version/state
unchanged. Triage can use the pinned task snapshot; it does not publish a duplicate
task or start execution. A saved response is accepted only with the matching
`taskBinding`; stale versions or context require a fresh explicit selection.

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

## Local owner questions and answers

`getOwnerActions` / `owner-actions` read bounded local questions for one exact goal;
legacy unbound questions remain read-only history. The board can show an option
choice or comment form. `answerOwnerAction` / `answer-owner-action` accept JSON with
`request_id` (stable UUID), the read envelope's `host_binding`, exact `selection`
(`mission_id`, `mission_version`, `decision_id`, `decision_version`, `context_hash`),
and `response` (`option_id`, `comment`). The UI saves this full request before POST.

The binding is a SHA-256 of the configured host ID, used only as a constraint.
Changed or absent host settings leave the outcome unknown and do not retarget the
answer. Retry sends the same POST to `/api/decision-answers` with the same UUID and
payload, even if a fresh read shows the question resolved or omits it. Pending
recovery stays separate from the bounded question list. No new question is created.

Only an exact 200 receipt with matching mission/decision, both incremented versions,
resolved status and local-only/no-external-action flags confirms saving. Known typed
version/context/request conflicts can reject; transport, non-JSON and 5xx outcomes
stay unknown. No automatic retry follows reload. An answer records a local choice;
it is not a grant, task execution, native answer delivery or quality acceptance.

## Voice drafting

**Диктовать** starts browser speech recognition only after a click, when the browser
exposes `SpeechRecognition` or `webkitSpeechRecognition` in a secure context.
Microphone permission and device availability belong to that browser. The microphone
is on the browser device; its speech service may process audio externally. Personal OS
receives the resulting text, not audio. No local-only audio processing is promised.

Final recognized fragments join the protected draft. Interim words are visibly unsaved.
Stop dictation, check the text, then press **Добавить** separately; dictation never submits
an instruction. Sending and target changes are blocked during capture. A route/target
change cancels capture. Unconfirmed fragment writes remain visible for manual recovery;
they are not silently treated as saved. Reload never resumes capture or submission.
Denied permission, unsupported recognition and network failure keep text entry and system
dictation as alternatives. Actual microphone capture and speech recognition in external
Chrome or on a phone remain unverified; source support is not a live voice pass.

## Boundaries

Reads use only GET `/api/missions`, `/api/missions/<mission_id>` and
`/api/tasks?mission_id=<mission_id>`, the bounded `/api/inbox` list/detail and
exact note/result artifact routes, and `/api/task-chat-links?task_id=<task_id>`.
Task activity uses only `/api/task-execution?task_id=<task_id>` or the fixed
mission batch query, and `/api/task-execution/<binding_id>/artifact?task_id=<task_id>`.
Exact profiles use `/api/quality/profile-versions/<profile_id>?version=<version>&hash=<sha256>`
with a 128 KiB reply limit. Exact sample reads use only `/api/quality/reference`
with the seven validated selection fields and a 3 MiB reply limit. Local questions
use only `/api/owner-actions?mission_id=<mission_id>` with a 256 KiB reply limit.
Responses are limited to 2 MiB for goals/tasks, 1 MiB for inbox lists, 512 KiB for
instruction details and exact artifact bytes, 1 MiB for task activity and 64 KiB for chat bindings;
100 goals and 500 tasks; requests time out after five seconds. IDs and responses
are validated at the host boundary. Redirects are rejected. Unprojected owner
responses, credentials, workflow source payloads and arbitrary URLs are excluded;
only explicit verified sample content and structured result fields reach the frontend.
POST uses only the three owner-input endpoints and local decision-answer endpoint
above, with a 16 KiB reply limit.
The host adds the local client header; no credential is copied into the browser.

`/api/control` is deliberately excluded because it records skill observations.
The plugin has no task/status write, dispatch, model or chat-creation action.
Skill-package bytes, manifests, problem links and reported evaluations remain owned
by Personal OS. This plugin does not refresh that catalog, capture packages or
promote a skill; it does not keep a second skill library.
Local answers use the existing Personal OS decision owner; they add no execution
permissions. Answer drafts and pending requests use a shared Web Lock per storage key
and compare the previous bytes before every write. Browsers without Web Locks keep
the data and disable submission. An unknown pending request retains its original host
binding and remains available even when the question has moved into history.
The plugin delegates explicit Desktop navigation to the existing opener rather than adding a second opener. The command ledger is initialized during plugin loading. Outcome reads
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
