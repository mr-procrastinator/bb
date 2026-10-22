---
name: open-codex-desktop
description: Find local Codex Desktop chats already observed by Personal OS and open an existing chat on the configured Mac when requested. Use through the BB Codex Desktop plugin; this is not BB thread creation, provider resume or message sending.
---

Use the owning plugin's typed CLI:

```sh
bb codex-desktop chats
bb codex-desktop open <codex_desktop_thread_uuid>
```

`chats` reads a saved Personal OS monitor snapshot. Choose the exact Desktop
`threadId` returned for the requested chat. A BB thread ID or provider session
ID is not a Desktop identity unless that exact ID is independently present in
the observed local Codex list. Do not match by similar IDs or silently choose
a different chat when the requested target is absent or ambiguous.

Open only when the user asks to open the chat. The plugin reads the owner
snapshot again before dispatch and refuses unknown, nonlocal, unsupported or
malformed targets. The command cannot accept URLs, paths or a host override.

Responses are JSON. Exit code 1 means invalid arguments; exit code 2 means
unavailable or an unknown opening outcome. `open_requested` and
`navigationConfirmed: false` mean the macOS command returned, not that the
intended chat was seen. Do not claim a verified transition from that response.
If the outcome is unknown, inspect the existing Codex window when authorized;
do not automatically repeat the command.

`observedAt` on the list result is API read time. Each chat's observation time,
freshness and `inCurrentScope` describe the saved source. They do not prove
current agent activity, full history coverage or product acceptance. Unknown
source data is not an empty successful chat list.

If setup is missing, report the missing configuration. For explicit setup,
the operator selects the exact enrolled BB host ID of the Mac running both
Codex Desktop and Personal OS:

```sh
bb plugin config codex-desktop set hostId <enrolled_host_id>
```

Opening always acts on that configured Mac, including requests from a mobile
browser. Do not switch hosts, expose port 7317 or copy credentials to make an
opening succeed. Further setup and limits are in [the plugin README](../../README.md).

This workflow cannot create chats, send follow-ups, resume provider sessions,
run models or change Personal OS tasks. Those actions need their own supported
workflow and authority.
