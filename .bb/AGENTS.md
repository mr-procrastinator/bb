# Personal OS fork: owner rules

- Automated tests are forbidden unless the owner separately and explicitly requests end-to-end tests. Do not add, edit, delete, or run tests by default. This applies to delegated agents too. Use source review, builds, and manual user flows.
- Work on the current branch. Do not create branches without an explicit owner request. Publishing to the owner's fork follows the scope of the owner's task.
- Preserve upstream behavior, existing data, credentials, and unfinished work. Keep fork changes in plugins where supported.
- Personal OS owns user goals, priorities, goal requirements, decisions, received exact results, consumer inspection, and goal acceptance. AiweApps owns product requirements, the product plan, execution, resource reservations, and domain quality/acceptance of its delivery. BB owns its conversations and provider sessions.
- Do not create a second writer or dispatcher by mirroring Personal OS tasks into BB Tasks. A reported result or idle chat is not accepted work.
- Keep BB thread IDs, provider session IDs, and Codex Desktop chat IDs separate. Never infer their equivalence from names.
- Keep credentials in their native backend stores. Do not copy existing auth files for account pooling. Account login remains an explicit user flow.
- Use an isolated BB data directory. Setup must not reset existing user state or silently accept upstream data migrations or automatic updates.
- Personal OS input commands pin host, UUID, payload, scope and mission version before delivery. The plugin database stores transport intents, not tasks. Keep applied migration statements byte-for-byte immutable and append reviewed migrations, even when the live table appears empty.
- Codex Desktop opening accepts only an observed local Desktop UUID, rechecks its owner binding and constructs the fixed deep link on the host. A successful macOS open request is not automatic confirmation of the destination window.
- The local runtime manager owns only processes it starts. Keep Node/native ABI, process birth identity, loopback listeners and compressed logs consistent; do not adopt another running service or reuse inherited provider API-key overrides for a subscription pilot.
- Keep services on loopback until an explicit remote-access path and its authentication boundary are configured. Do not expose an unauthenticated execution API.
- One agent owns UI verification. Do not open parallel browsers or simulators.
