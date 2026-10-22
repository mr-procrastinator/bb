# Codex Desktop

List local Codex chats already observed by Personal OS and explicitly request
opening one on the configured Mac. BB threads, provider sessions and Codex
Desktop chats keep separate identities. A BB thread ID or provider session ID
does not become a Desktop chat merely because its title or ID looks similar.

## Configure

Install the local plugin using BB's plugin installer, then select the exact
enrolled BB host ID of the Mac running both Personal OS and Codex Desktop:

```sh
bb plugin config codex-desktop set hostId <enrolled-host-id>
```

Personal OS must listen at `http://127.0.0.1:7317` on that Mac. The `codex://`
scheme must be registered with the desktop app. No credentials are copied and
the plugin does not expose port 7317. The configured BB host ID is a transport
destination; the observed Desktop host must independently equal `local`.

## Use

Open **Чаты Codex** in the BB sidebar. Search filters the loaded local chats by
title or Desktop UUID and shows the matching count. Refresh reads the saved
Personal OS monitor snapshot. Common source time and freshness appear once;
rows flag differing stale/unknown observations or absence from the last scope.
Each exact observation time and UUID remain available on the title's hover
text and as the open button's accessible description. A fresh snapshot does
not prove a running agent or current existence of a chat.

**Открыть в Codex** acts on the configured Mac, including requests made from
a mobile browser. It does not open Codex on the phone. The browser sends only
the selected Desktop `threadId`; it cannot choose an opener, URL, file path or
destination host.

The same contract is available through typed plugin RPC (`listThreads(null)`
and `openThread({threadId})`) and the CLI:

```sh
bb codex-desktop chats
bb codex-desktop open 01234567-89ab-cdef-0123-456789abcdef
```

Cross-plugin callers can constrain `openThread` with optional `expectedHostId`.
The server reads its configured host once, rejects a mismatch as `host_changed`,
and sends to that same captured host. This constraint never selects another
destination. Omitting it preserves ordinary direct opening. The existing host
opener still validates the observed local chat before invoking macOS.

The bundled [open-codex-desktop skill](skills/open-codex-desktop/SKILL.md)
documents target selection, configuration and opening limits for agents.

CLI responses are JSON. Exit code 1 means invalid arguments; exit code 2 means
unavailable or an unknown opening outcome. `open_requested` means the operating
system command returned successfully. `navigationConfirmed: false` remains
explicit: neither the command exit nor the saved source confirms that the
intended chat appeared. If the outcome is unknown, inspect Codex before another
explicit request. There is no automatic retry.

## Boundaries

The host entry reads only GET `/api/monitor` at the fixed loopback origin.
Redirects are rejected; HTTP reads and the opener each have a five-second
timeout. Responses are capped at 2 MiB and 5000 source records; at most 500
supported chats are projected. Missing source data stays unavailable, rather
than becoming an empty successful list.

Before every opening, the host reads the source again and requires exact
`codex_app` source, thread kind, local Desktop host, UUID and `codex:<UUID>`
entity binding. Unknown, nonlocal and unsupported targets are refused. The
only generated URL is `codex://threads/<validated-UUID>`. The host invokes
`/usr/bin/open` with an argument array, without a shell. No file opener or
arbitrary external URL is added to BB's general browser routing.

The browser receives only the narrow typed projection. Working directories,
project paths, source reports, summaries, raw monitor payloads and credentials
are not projected. Titles containing path, URL or credential markers are
replaced with a short ID label. This marker filter is not general secret DLP.

The plugin has no database, background poller, model invocation, chat creation,
message sending, provider resume or goal/task writes. It does not modify the
Personal OS plugin or mirror its task database.

## Development

From the repository root after workspace dependencies are installed:

```sh
pnpm exec turbo run typecheck --filter=bb-plugin-codex-desktop
pnpm exec turbo run prepare:bundled --filter=bb-plugin-codex-desktop
```

This implementation uses BB's shared Button and native theme tokens. No tests
were added or run. Build, installation, real opening and UI verification are
separate checks. Source creation alone establishes none of those outcomes.

The supported Codex chat scheme is documented in
[OpenAI's commands reference](https://developers.openai.com/codex/reference/commands#deep-links).
