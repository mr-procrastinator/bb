# Personal OS fork: owner rules

- Automated tests are forbidden unless the owner separately and explicitly requests end-to-end tests. Do not add, edit, delete, or run tests by default. This applies to delegated agents too. Use source review, builds, and manual user flows.
- Work on the current branch. Do not create branches or push changes without an explicit owner request.
- Preserve upstream behavior, existing data, credentials, and unfinished work. Keep fork changes in plugins where supported.
- Personal OS owns user goals, priorities, goal requirements, decisions, received exact results, consumer inspection, and goal acceptance. AiweApps owns product requirements, the product plan, execution, resource reservations, and domain quality/acceptance of its delivery. BB owns its conversations and provider sessions.
- Do not create a second writer or dispatcher by mirroring Personal OS tasks into BB Tasks. A reported result or idle chat is not accepted work.
- Keep BB thread IDs, provider session IDs, and Codex Desktop chat IDs separate. Never infer their equivalence from names.
- Keep credentials in their native backend stores. Do not copy existing auth files for account pooling. Account login remains an explicit user flow.
- Use an isolated BB data directory. Never run reset, cleanup, migration, or automatic updates against existing user state as part of setup.
- Keep services on loopback until an explicit remote-access path and its authentication boundary are configured. Do not expose an unauthenticated execution API.
- One agent owns UI verification. Do not open parallel browsers or simulators.
