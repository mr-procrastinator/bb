# Packet research provider

This opt-in provider runs one real BB turn over one explicit source packet. BB owns
its thread, messages, events and session identity. The provider uses the existing
host-native ChatGPT subscription login in place. It creates no native Codex session.
No account pooling, API-key mode, model fallback, tool execution or task dispatch is
part of this provider. Personal OS and AiweApps keep their existing responsibilities.

## Enable a bounded pilot

The plugin defaults to `pilotEnabled=false` and registers no provider until explicitly
enabled and reloaded. Read, result and cancellation RPC remain available for recovery.
An operator must first observe an available model in the real native BB catalog.
There is deliberately no default model name and no model catalogue network probe.

Configure the exact enrolled `hostId`, `pilotModel`, and `modelSourceRef` through BB
plugin settings. On that same host, prepare a mode-600 `profile.json` in the plugin's
private `<daemonDataDir>/plugins/provider-packet-research/packet-research-v1/`
directory (mode 700). BB gives host RPC a `host-data/` directory and the provider
bridge a separate `bridge-data/` directory. Both use this shared sibling journal;
do not place a second profile or journal inside either process directory:

```json
{
  "schema_version": 1,
  "mode": "packet_research_v1",
  "enabled": true,
  "host_id": "<exact enrolled host ID>",
  "model": "<exact observed model ID>",
  "model_source_ref": "<reference to the observed catalog>",
  "timeout_ms": 180000,
  "max_response_bytes": 2097152
}
```

The local profile must exactly match the derived server profile. Enable
`pilotEnabled` and reload only after that preparation. Use the isolated BB runtime
whose launcher removes inherited provider/account overrides. This provider does
not copy or change authentication. An unavailable or expired login fails closed.

The public BB permission selector currently requires one generic mode. This provider
accepts only the workspace `accept-edits` ceiling; it never provides editing tools.
Full permissions, plan mode and an altered profile are refused.

## Packet and lifecycle

Send exactly one text input containing a JSON packet. `src/packet.ts` defines the
exact schema: version 1, operation UUID, caller, mission/delegation/revision/attempt,
question, expected result, 1–30 source cards, and `input_hash`. Hash the UTF-8 canonical
JSON of the packet without `input_hash`; object keys are sorted. The entire packet
is limited to 128 KiB and each source card to 40,000 characters. Non-text inputs,
file attachments, duplicate source IDs and mismatched hashes are refused.

`thread/start` only creates a durable provider session identity. The first separate
`turn/start` saves exclusive durable claims for that BB thread, caller attempt and
operation before network work. These are separate file operations; interrupted setup
holds the attempt. Fresh inference uses only the validated packet and fixed provider instructions.
Inherited BB instructions, skills, tools, histories and provider options are never
forwarded to the model. No shell, MCP, app, browser, filesystem or subagent tool is
registered with the inference request. Only inference networking is used.
The BB runtime adds `additionalWorkspaceWriteRoots` as transport metadata. The
bridge validates that bounded list but never uses it or forwards it to inference.
Other unexpected provider-option fields are refused. Protocol failures expose
fixed stage codes, never raw packet, Zod, filesystem or authentication errors.

The strict inference transport sends at most one POST. It has no redirect,
Cloudflare retry, alternate account or alternate model path. Success requires the
exact completed response ID and validates the original JSON report against the
source IDs. Original UTF-8 result bytes and their hash are committed before BB's
completed event. A partial EOF, timeout, malformed result or uncertain storage is
held; it cannot become a successful report.

Session construction, resume, a second turn and a repeated operation never re-run
inference. Cross-process O_EXCL claims preserve this boundary after a crash. A crash
between claim and delivery can permanently hold an attempt. Recovery reads its exact
journal; it never guesses that no model started. BB timeline recovery after a daemon
restart is not implemented. Native Codex session restoration is not available.
Mission, delegation and attempt IDs are caller-supplied input references. This plugin
does not create or authenticate native AiweApps records or grants. The future native
adapter must verify those references against its own immutable records.

## Receipts and cancellation

Public plugin RPC and CLI require both the exact operation UUID and input hash:

```sh
bb packet-research status <host-id> <operation-uuid> <input-sha256>
bb packet-research result <host-id> <operation-uuid> <input-sha256>
bb packet-research stop <host-id> <operation-uuid> <input-sha256>
```

`status` and `result` only read existing files. They do not initialize storage or
start a model. `result` returns exact text only after receipt/hash/size validation.
`stop` records an exact cancellation request. The live bridge polls it and aborts
its own request; public BB stop alone is not confirmation of completion.

Receipts distinguish a confirmed remote completion from local request quiescence
and unknown remote outcome. Every receipt explicitly reports
`native_stop_proven=false` and `resource_release_available=false`. These fields must
not be used as an AiweApps resource-release proof. The future native adapter and its
external-execution recovery contract need separate implementation and verification.
Raw source packets, private paths and authentication data are not returned by these
RPCs. Requested model and actually returned model remain separate. Unknown usage is
not reported as zero.
New failure receipts may include `transport_diagnostics`: only the HTTP status and
bounded normalized MIME content type, never headers, body, URL or account data.
Missing diagnostics on an old receipt remain unknown. Existing bytes and hashes
are not rewritten or supplemented after the request. A failed turn shows a short
reason and the hold in its BB timeline; it does not trigger another request.
All turn-specific deltas carry the same exact provider turn ID as the receipt.
An explicitly named `turn.open` does not establish BB's implicit current turn, so
mixing named and unnamed deltas would lose accepted-input, result and completion
events. This fix affects new event publication; old stored events are not rebuilt.

## Development

```sh
pnpm exec turbo run typecheck --filter=bb-plugin-provider-packet-research
pnpm exec turbo run prepare:bundled --filter=bb-plugin-provider-packet-research
```

The workspace already includes `plugins/*`. Required workspace packages are
`@bb/plugin-build` and `@get-bb/plugin-sdk`; the root `pnpm.overrides` pins Zod to
4.6.5. A frozen filtered install uses the checked-in importer:

```sh
pnpm install --offline --ignore-scripts --frozen-lockfile --filter bb-plugin-provider-packet-research...
```

The host build bundles `provider-codex/src/ai/codex-auth.ts`, its `codex-home.ts`
helper and the small failure class from sibling source files. It does not need a
running or separately built Codex provider. Copying this source directory alone
outside the monorepo is unsupported. `prepare:bundled` stages beside the source
plugin, so relative sibling imports still resolve. The generated `.bundled-runtime`
contains the bundled host artifact and a rewritten runtime manifest.

Turbo's generic cache inputs do not track those sibling sources. After changing
the imported Codex helpers, force the provider build rather than reuse its cache:

```sh
pnpm exec turbo run typecheck prepare:bundled --filter=bb-plugin-provider-packet-research --force
```

No automated tests are included or authorized. A successful build does not prove a
live subscription request, BB timeline behavior or stop/recovery. The operator's
first live request on 2026-10-22 passed the response.ok check but had an unsupported content type
and produced a held receipt. It did not produce a verified research report. That
attempt must not be retried. Its original receipt has no transport diagnostics;
the missing MIME value remains unknown. The old timeline also missed its terminal
events because named and unnamed turn deltas were mixed. The source now uses
consistent named deltas, but that old saved history is not repaired. No public
receipt-only timeline repair is implemented; archival preserves the evidence.

## Operator commands for one local turn

These are operator steps, not automatic setup. Keep the provider disabled until
the reviewed artifacts, enrolled host and exact profile are ready. Use the existing
isolated server and its enrolled host; do not enroll another host or copy a login.
From the repository root, bind the built CLI explicitly:

```sh
packetNode="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
packetRepo='/Users/Andrey/devs/AI/bb'
bbpilot() {
  env -u BB_CLI -u BB_THREAD_ID -u BB_PROJECT_ID \
    BB_SERVER_URL=http://127.0.0.1:7319 BB_HOST_DAEMON_PORT=7320 \
    "$packetNode" "$packetRepo/apps/cli/dist/index.js" "$@"
}
bbpilot plugin install "path:$packetRepo/plugins/provider-packet-research/.bundled-runtime" --yes --json
bbpilot plugin config provider-packet-research set pilotEnabled false
bbpilot plugin config provider-packet-research set hostId host_edkwka5dxn
bbpilot plugin config provider-packet-research set pilotModel gpt-6-astra
bbpilot plugin config provider-packet-research set modelSourceRef evidence:codex-model-catalog-20261022
```

`gpt-6-astra` was observed as the native catalog default for that host on
2026-10-22. The operator's compressed catalog evidence lives outside the checkout.
This is catalog evidence, not evidence that the strict endpoint accepts the model.
Use the actual observed host/model if operating another installation.

The profile target for this isolated runtime is
`~/.local/share/bb-personal-os/plugins/provider-packet-research/packet-research-v1/profile.json`.
Prepare the exact JSON from the enable section with host `host_edkwka5dxn`, model
`gpt-6-astra` and source ref `evidence:codex-model-catalog-20261022`. Create a new
profile with exclusive file creation, mode 600 and file/parent fsync. The containing
journal directory must be mode 700. Do not overwrite an existing profile or
unresolved journal during setup. Never put credentials into this file.

After the operator has prepared and checked that profile:

```sh
bbpilot plugin config provider-packet-research set pilotEnabled true
bbpilot plugin reload provider-packet-research --json
bbpilot provider models codex-packet-research --host host_edkwka5dxn --json
bbpilot project list --include-personal --json
bbpilot environment list --project '<existing-project-id>' --host host_edkwka5dxn --status ready --json
```

Prepare one bounded packet file before launch. Preserve its UUID, attempt and hash.
Use a real mission/delegation/attempt only when its native owner authorizes them;
standalone provider pilots must label fixture references as fixtures. The provider
does not promote such references to real native records. Do not place secrets or
unbounded chat histories into source cards. Use only operator-approved text.

Reuse an existing project and environment. An environment already pins its host;
do not combine an environment ID with `--host`. Run this spawn command once only:

```sh
bbpilot thread spawn --project '<existing-project-id>' --environment '<existing-environment-id>' \
  --provider codex-packet-research --model gpt-6-astra --reasoning-level high \
  --permission-mode accept-edits --prompt-file '<absolute-prepared-packet.json>' \
  --title 'Packet research · single pilot' --json
bbpilot packet-research status host_edkwka5dxn '<same-operation-uuid>' '<same-input-sha256>'
bbpilot packet-research result host_edkwka5dxn '<same-operation-uuid>' '<same-input-sha256>'
```

Do not run a separate send command or spawn again after timeout/unknown output.
Read the same operation instead. `status` can exit zero with `held` or `unavailable`;
inspect its JSON state and exact receipt. A completed receipt plus matching original
result is provider delivery evidence. BB's visible thread, turn and result still
need the operator's manual check. Failure ends this one-turn pilot without retry.
For cancellation use the same identity with `bbpilot packet-research stop`; it is
a local cancellation request and retains the resource-release limitation above.
Disable `pilotEnabled` after the bounded pilot; journal reads remain available.

## Future AiweApps adapter boundary

This contract is proposed, not implemented. AiweApps remains the only job, budget,
grant and resource owner. Add a BB execution adapter to its existing attempt runner;
do not mirror jobs into BB Tasks or introduce another dispatcher or queue.

Proposed AiweApps file boundary: `agent/native_bb.py` handles only the trusted BB
profile, exact submit/lookup/cancel/result transport and external identity.
`agent/native_runner.py` keeps attempt/GO/recovery/artifact publication;
`agent/native_resources.py` keeps the existing fence. `agent/native_artifacts.py`
continues authenticated artifact reads. A typed external-execution state must be
added to that owner lifecycle before enabling the adapter. Do not put a fabricated
local PID or `stopped: true` into the current process-based runner contract.

| Existing owner | Minimal BB mapping |
| --- | --- |
| Prepared native attempt | Pin caller, mission, did/revision, attempt, operation UUID, BB server/host/project/environment, provider/profile hash and exact packet bytes/hash before HTTP. Validate the existing grant and budget; the packet cannot grant itself authority. |
| Native submit intent | Persist `http_attempts=1` before the single BB spawn with initial packet. Supply `origin: plugin`, an adapter plugin ID and exact attempt/operation/input hashes in `pluginMetadata`. No separate create-plus-send sequence. |
| Unknown submit | Never repeat POST. A bounded metadata scan may locate one exact BB thread, but mutable metadata is only a locator. Verify against immutable native intent and the provider journal. Zero, multiple, truncated, inaccessible or mismatched results remain held. |
| Native event cursor | Bind BB thread ID, accepted client request ID, provider turn ID and BB turn scope separately. Save the cursor with its projection; gaps require explicit reconciliation. No title-based identity or inferred Codex Desktop chat ID. |
| Native result receipt | Call exact `result(hostId, operationId, inputHash)`. Verify receipt hash, all saved IDs, profile/requested model, completed response ID, original UTF-8 bytes/size/SHA-256 and the native artifact schema before publishing through the existing native artifact owner. Delivery does not imply review or product acceptance. |
| Native stop/resource fence | Map only the exact attempt to plugin cancellation and read its receipt. Public BB stop, an idle timeline and local HTTP abort are insufficient release evidence. Keep the reservation held until a separately implemented owner contract proves safe external termination; never kill BB's shared worker PID. |

The native attempt's `input_hash` hashes its native launch envelope. The BB packet's
`input_hash` hashes its own packet body. Preserve both bindings; never assume they
are equal. The BB report is the inner research result, not the native `research.json`
envelope. Keep its original bytes and provider receipt as delivery evidence, then
let the native artifact owner validate and construct its existing envelope with a
separate file hash. Neither envelope construction nor consumer inspection creates
a confirmed external-stop receipt.

Public BB create/send currently has no durable caller operation key. Therefore
automatic retry/recreate is outside this contract. The provider journal prevents
another inference for a claimed operation or caller attempt, but does not make BB
spawn exactly-once or restore a missing timeline after restart. A future core
operation receipt owner can improve reconciliation without changing the single
native outbox owner. The first adapter pilot should be one already authorized
packet research attempt with exact result receipt, followed by independent consumer
review. Native resource release is a separate prerequisite, not an implied feature.
