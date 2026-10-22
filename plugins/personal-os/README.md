# Personal OS

A read-only BB panel for the local Personal OS. It displays goals, their next
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
configured host entry. Only that host reads Personal OS over loopback. This also
supports a remote browser without exposing port 7317. Remote access to BB itself
must use its configured access boundary; this plugin does not add authentication.

## Use

Open **Personal OS** in the BB sidebar, choose a goal, then open a task card.
The same read operations are available through typed plugin RPC and CLI:

```sh
bb personal-os missions
bb personal-os mission mission_0123456789abcdef0123456789abcdef
bb personal-os tasks mission_0123456789abcdef0123456789abcdef
```

CLI responses are JSON. Exit code 2 means the host or service is unavailable;
unknown states are not converted into empty successful lists. Refresh is manual.
Read time records when the plugin read the API, not when an agent last worked.

Task state `doing` is not proof of a running process. Historical `done` tasks do
appear in a separate expandable history, outside current **Готово**. An unspecified
executor remains explicitly unknown. Evidence counts refer to recorded sources, not
independent inspection. Full product acceptance remains separate.

## Boundaries

Only GET `/api/missions`, `/api/missions/<mission_id>` and
`/api/tasks?mission_id=<mission_id>` are used. Responses are limited to 2 MiB,
100 goals and 500 tasks; requests time out after five seconds. IDs and responses
are validated at the host boundary. Redirects are rejected. Raw responses,
credentials, source payloads and arbitrary URLs are not sent to the frontend.

`/api/control` is deliberately excluded because it records skill observations.
The plugin has no write, dispatch, model, chat-creation or Codex deep-link action.
Decisions, partial-result documents and thread bindings are outside this first
slice. It has no database or background poller.

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
