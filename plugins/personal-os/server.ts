import { createHash } from "node:crypto";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { lookupInputSchema, missionInputSchema, personalOsContract, personalOsHostContract, submissionResultSchema, submitInputSchema, listInputsInputSchema, getInputInputSchema, inputArtifactInputSchema, taskChatInputSchema, openTaskChatInputSchema, desktopOpenResultSchema, taskResultInputSchema, type MissionResult, type MissionsResult, type TasksResult, type SubmitInput, type SubmissionResult, type SubmissionLookupResult, type InputsResult, type InputDetailResult, type InputArtifactResult, type TaskChatResult, type OpenTaskChatResult, type TaskActivityResult, type MissionActivityResult, type TaskResult } from "./contract.js";

const HELP = "bb personal-os missions\nbb personal-os mission <mission_id>\nbb personal-os tasks <mission_id>\nbb personal-os task-activity <task_id>\nbb personal-os mission-activity <mission_id>\nbb personal-os task-result <task_id> <task_execution_binding_id>\nbb personal-os inputs [mission_id]\nbb personal-os input <note_id>\nbb personal-os input-artifact <note_id> <input_result_id>\nbb personal-os task-chat <task_id>\nbb personal-os open-task-chat <task_id> <expected-link-version>\nbb personal-os submit <request-uuid> <quoted-text>\nbb personal-os submit-mission <request-uuid> <mission_id> <expected-version> <quoted-text>\nbb personal-os submission <request-uuid>\nJSON reads, bounded owner input and explicit linked-chat navigation. Repeat unknown save outcomes with the exact request UUID, text and target. Configure the enrolled host ID with bb plugin config personal-os.";

const commandRowSchema = z.object({
  request_id: lookupInputSchema.shape.requestId,
  host_id: z.string().min(1).max(200).nullable(),
  request_json: z.string().max(131072),
  payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
  result_json: z.string().max(16384).nullable(),
});

function requestHash(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

function identity(requestId: string) {
  return { requestId, observedAt: new Date().toISOString() };
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    hostId: {
      type: "string",
      label: "Personal OS host ID",
      description: "Exact enrolled BB host ID of the Mac running Personal OS on loopback port 7317.",
      experimental_schema: z.string().min(1).max(200).refine(value => value === value.trim()),
    },
  });
  const host = bb.hosts.experimental_client({ contract: personalOsHostContract });
  let commandDb: ReturnType<typeof bb.storage.database> | null = null;
  try {
    commandDb = bb.storage.database();
    bb.storage.migrate(commandDb, [
      `CREATE TABLE personal_os_input_commands (
        request_id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE personal_os_input_commands_v2 (
        request_id TEXT PRIMARY KEY,
        host_id TEXT,
        request_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO personal_os_input_commands_v2(request_id,host_id,request_json,payload_hash,result_json,created_at)
        SELECT request_id,host_id,request_json,payload_hash,result_json,created_at FROM personal_os_input_commands;
      DROP TABLE personal_os_input_commands;
      ALTER TABLE personal_os_input_commands_v2 RENAME TO personal_os_input_commands`,
    ]);
  } catch {
    commandDb = null;
    bb.log.warn("Personal OS input command storage unavailable; reads remain enabled");
  }

  function command(requestId: string) {
    if (!commandDb) throw new Error("storage_unavailable");
    const raw = commandDb.prepare("SELECT request_id,host_id,request_json,payload_hash,result_json FROM personal_os_input_commands WHERE request_id=?").get(requestId);
    if (raw === undefined) return null;
    const row = commandRowSchema.parse(raw);
    const input = submitInputSchema.parse(JSON.parse(row.request_json));
    if (row.request_id !== requestId || input.requestId !== requestId || row.payload_hash !== requestHash(row.request_json)) throw new Error("storage_unavailable");
    const result = row.result_json === null ? null : submissionResultSchema.parse(JSON.parse(row.result_json));
    if (result && result.requestId !== requestId) throw new Error("storage_unavailable");
    if ((row.host_id === null) !== (result?.state === "not_sent")) throw new Error("storage_unavailable");
    if (result?.state === "saved" && (input.target.scope === "personal"
      ? result.missionId !== null || result.missionVersion !== null
      : result.missionId !== input.target.missionId || result.missionVersion !== input.target.expectedMissionVersion + 1)) throw new Error("storage_unavailable");
    return { ...row, input, result };
  }

  function existingResult(input: SubmitInput): SubmissionResult | null {
    const row = command(input.requestId);
    if (!row) return null;
    if (row.request_json !== JSON.stringify(input)) return { ...identity(input.requestId), state: "blocked", reason: "request_mismatch" };
    return row.result?.state === "saved" || row.result?.state === "rejected" || row.result?.state === "not_sent" ? row.result : null;
  }

  function prepareInput(input: SubmitInput, hostId: string | null) {
    if (!commandDb) throw new Error("storage_unavailable");
    const db = commandDb;
    return db.transaction(() => {
      const previous = existingResult(input);
      if (previous) return { kind: "result" as const, result: previous };
      const row = command(input.requestId);
      if (row) {
        if (row.host_id === null) throw new Error("storage_unavailable");
        if (!hostId) return { kind: "result" as const, result: { ...identity(input.requestId), state: "blocked" as const, reason: "host_not_configured" as const } };
        if (row.host_id !== hostId) return { kind: "result" as const, result: { ...identity(input.requestId), state: "blocked" as const, reason: "host_changed" as const } };
        return { kind: "send" as const, input: row.input, hostId: row.host_id };
      }
      const raw = JSON.stringify(input);
      if (!hostId) {
        const result = { ...identity(input.requestId), state: "not_sent" as const, reason: "host_not_configured" as const };
        db.prepare("INSERT INTO personal_os_input_commands(request_id,host_id,request_json,payload_hash,result_json,created_at) VALUES(?,NULL,?,?,?,?)").run(input.requestId, raw, requestHash(raw), JSON.stringify(result), new Date().toISOString());
        return { kind: "result" as const, result };
      }
      db.prepare("INSERT INTO personal_os_input_commands(request_id,host_id,request_json,payload_hash,result_json,created_at) VALUES(?,?,?,?,NULL,?)").run(input.requestId, hostId, raw, requestHash(raw), new Date().toISOString());
      return { kind: "send" as const, input, hostId };
    })();
  }

  function recordResult(input: SubmitInput, result: SubmissionResult): SubmissionResult {
    if (!commandDb) throw new Error("storage_unavailable");
    const db = commandDb;
    return db.transaction(() => {
      const row = command(input.requestId);
      if (!row || row.request_json !== JSON.stringify(input) || result.requestId !== input.requestId) throw new Error("storage_unavailable");
      if (row.result?.state === "saved" || row.result?.state === "not_sent" || (row.result?.state === "rejected" && result.state !== "saved")) return row.result;
      db.prepare("UPDATE personal_os_input_commands SET result_json=? WHERE request_id=?").run(JSON.stringify(result), input.requestId);
      return result;
    })();
  }

  async function submitInput(input: SubmitInput): Promise<SubmissionResult> {
    try {
      const previous = existingResult(input);
      if (previous) return previous;
      const current = await settings.get();
      const prepared = prepareInput(input, current.hostId || null);
      if (prepared.kind === "result") return prepared.result;
      let result: SubmissionResult;
      try {
        result = await host.call("submitInput", prepared.input, { hostId: prepared.hostId, timeoutMs: 10000 });
      } catch {
        result = { ...identity(input.requestId), state: "outcome_unknown", reason: "host_unavailable" };
      }
      return recordResult(prepared.input, result);
    } catch {
      return { ...identity(input.requestId), state: "outcome_unknown", reason: "storage_unavailable" };
    }
  }

  function getInputSubmission(input: z.infer<typeof lookupInputSchema>): SubmissionLookupResult {
    try {
      const row = command(input.requestId);
      if (!row) return { ...identity(input.requestId), state: "not_found" };
      return row.result ?? { ...identity(input.requestId), state: "outcome_unknown", reason: "delivery_unconfirmed" };
    } catch {
      return { ...identity(input.requestId), state: "outcome_unknown", reason: "storage_unavailable" };
    }
  }

  async function hostCall<T>(call: (hostId: string) => Promise<T>) {
    const current = await settings.get();
    if (!current.hostId) return { state: "unavailable" as const, observedAt: new Date().toISOString(), reason: "host_not_configured" as const };
    try {
      return await call(current.hostId);
    } catch {
      return { state: "unavailable" as const, observedAt: new Date().toISOString(), reason: "host_unavailable" as const };
    }
  }

  async function openTaskChat(input: z.infer<typeof openTaskChatInputSchema>): Promise<OpenTaskChatResult> {
    const unavailable = (reason: Extract<OpenTaskChatResult, { state: "unavailable" }>["reason"]): OpenTaskChatResult => ({ state: "unavailable", observedAt: new Date().toISOString(), reason });
    let hostId: string;
    try {
      const current = await settings.get();
      if (!current.hostId) return unavailable("host_not_configured");
      hostId = current.hostId;
    } catch {
      return unavailable("host_unavailable");
    }
    let observation: TaskChatResult;
    try {
      observation = await host.call("getTaskChat", { taskId: input.taskId }, { hostId, timeoutMs: 10000 });
    } catch {
      return unavailable("host_unavailable");
    }
    if (observation.state !== "available") return observation;
    const data = observation.data;
    const link = data.link;
    if (data.state !== "available" || link === null) return unavailable("link_unavailable");
    if (link.version !== input.expectedLinkVersion) return unavailable("link_changed");
    if (data.task_current !== true) return unavailable("task_not_current");
    if (data.context_current !== true) return unavailable("context_not_current");
    if (data.target.state !== "available") return unavailable("target_unavailable");
    if (!data.can_open) return unavailable("link_unavailable");
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: "codex-desktop", method: "openThread", input: { threadId: link.desktop_thread_id, expectedHostId: hostId },
        outputSchema: desktopOpenResultSchema, signal: AbortSignal.timeout(18000),
      });
      if (result.state === "open_requested" && result.threadId !== link.desktop_thread_id) return unavailable("invalid_response");
      return result;
    } catch {
      return unavailable("open_outcome_unknown");
    }
  }

  const handlers: PluginRpcHandlers<typeof personalOsContract> = {
    listMissions: () => hostCall(hostId => host.call("listMissions", null, { hostId, timeoutMs: 10000 })),
    getMission: input => hostCall(hostId => host.call("getMission", input, { hostId, timeoutMs: 10000 })),
    listTasks: input => hostCall(hostId => host.call("listTasks", input, { hostId, timeoutMs: 10000 })),
    listInputs: input => hostCall(hostId => host.call("listInputs", input, { hostId, timeoutMs: 10000 })),
    getInput: input => hostCall(hostId => host.call("getInput", input, { hostId, timeoutMs: 10000 })),
    getInputArtifact: input => hostCall(hostId => host.call("getInputArtifact", input, { hostId, timeoutMs: 15000 })),
    getTaskChat: input => hostCall(hostId => host.call("getTaskChat", input, { hostId, timeoutMs: 10000 })),
    getTaskActivity: input => hostCall(hostId => host.call("getTaskActivity", input, { hostId, timeoutMs: 10000 })),
    getMissionActivity: input => hostCall(hostId => host.call("getMissionActivity", input, { hostId, timeoutMs: 10000 })),
    getTaskResult: input => hostCall(hostId => host.call("getTaskResult", input, { hostId, timeoutMs: 15000 })),
    openTaskChat,
    submitInput,
    getInputSubmission,
  };
  bb.rpc.register(personalOsContract, handlers);
  bb.cli.register({
    name: "personal-os",
    summary: "Read goals and save bounded Personal OS owner input through its enrolled host",
    commands: [
      { name: "missions", summary: "List goals", usage: "bb personal-os missions" },
      { name: "mission", summary: "Read one goal", usage: "bb personal-os mission <mission_id>" },
      { name: "tasks", summary: "Read goal tasks", usage: "bb personal-os tasks <mission_id>" },
      { name: "task-activity", summary: "Read exact task execution bindings and saved phases", usage: "bb personal-os task-activity <task_id>" },
      { name: "mission-activity", summary: "Read a bounded batch of goal task activity", usage: "bb personal-os mission-activity <mission_id>" },
      { name: "task-result", summary: "Read an exact task-bound received research file", usage: "bb personal-os task-result <task_id> <task_execution_binding_id>" },
      { name: "inputs", summary: "List personal instructions, or explicit goal instructions", usage: "bb personal-os inputs [mission_id]" },
      { name: "input", summary: "Read original instruction, saved plan and attached results", usage: "bb personal-os input <note_id>" },
      { name: "input-artifact", summary: "Read exact attached research as bounded public content", usage: "bb personal-os input-artifact <note_id> <input_result_id>" },
      { name: "task-chat", summary: "Read the owner's explicit Desktop chat binding", usage: "bb personal-os task-chat <task_id>" },
      { name: "open-task-chat", summary: "Explicitly request opening the current bound chat on its Mac", usage: "bb personal-os open-task-chat <task_id> <expected-link-version>" },
      { name: "submit", summary: "Save a personal instruction with a stable request UUID", usage: "bb personal-os submit <request-uuid> <quoted-text>" },
      { name: "submit-mission", summary: "Save an instruction pinned to a goal version", usage: "bb personal-os submit-mission <request-uuid> <mission_id> <expected-version> <quoted-text>" },
      { name: "submission", summary: "Read a saved command outcome without network or dispatch", usage: "bb personal-os submission <request-uuid>" },
    ],
    async run(argv) {
      if (argv.length === 0 || (argv.length === 1 && ["help", "--help", "-h"].includes(argv[0]))) return { exitCode: 0, stdout: HELP };
      let result: MissionsResult | MissionResult | TasksResult | SubmissionLookupResult | InputsResult | InputDetailResult | InputArtifactResult | TaskChatResult | OpenTaskChatResult | TaskActivityResult | MissionActivityResult | TaskResult;
      if (argv[0] === "missions" && argv.length === 1) {
        result = await handlers.listMissions(null);
      } else if ((argv[0] === "mission" || argv[0] === "tasks") && argv.length === 2) {
        const input = missionInputSchema.safeParse({ missionId: argv[1] });
        if (!input.success) return { exitCode: 1, stderr: "Invalid mission ID.\n" + HELP };
        result = argv[0] === "mission" ? await handlers.getMission(input.data) : await handlers.listTasks(input.data);
      } else if (argv[0] === "task-activity" && argv.length === 2) {
        const input = taskChatInputSchema.safeParse({ taskId: argv[1] });
        if (!input.success) return { exitCode: 1, stderr: "Invalid task ID.\n" + HELP };
        result = await handlers.getTaskActivity(input.data);
      } else if (argv[0] === "mission-activity" && argv.length === 2) {
        const input = missionInputSchema.safeParse({ missionId: argv[1] });
        if (!input.success) return { exitCode: 1, stderr: "Invalid mission ID.\n" + HELP };
        result = await handlers.getMissionActivity(input.data);
      } else if (argv[0] === "task-result" && argv.length === 3) {
        const input = taskResultInputSchema.safeParse({ taskId: argv[1], bindingId: argv[2] });
        if (!input.success) return { exitCode: 1, stderr: "Invalid task/execution binding ID.\n" + HELP };
        result = await handlers.getTaskResult(input.data);
      } else if (argv[0] === "inputs" && (argv.length === 1 || argv.length === 2)) {
        const input = listInputsInputSchema.safeParse(argv.length === 1 ? { scope: "personal" } : { scope: "mission", missionId: argv[1] });
        if (!input.success) return { exitCode: 1, stderr: "Invalid instruction scope.\n" + HELP };
        result = await handlers.listInputs(input.data);
      } else if (argv[0] === "input" && argv.length === 2) {
        const input = getInputInputSchema.safeParse({ noteId: argv[1] });
        if (!input.success) return { exitCode: 1, stderr: "Invalid note ID.\n" + HELP };
        result = await handlers.getInput(input.data);
      } else if (argv[0] === "input-artifact" && argv.length === 3) {
        const input = inputArtifactInputSchema.safeParse({ noteId: argv[1], resultId: argv[2] });
        if (!input.success) return { exitCode: 1, stderr: "Invalid note/result ID.\n" + HELP };
        result = await handlers.getInputArtifact(input.data);
      } else if (argv[0] === "task-chat" && argv.length === 2) {
        const input = taskChatInputSchema.safeParse({ taskId: argv[1] });
        if (!input.success) return { exitCode: 1, stderr: "Invalid task ID.\n" + HELP };
        result = await handlers.getTaskChat(input.data);
      } else if (argv[0] === "open-task-chat" && argv.length === 3) {
        const input = openTaskChatInputSchema.safeParse({ taskId: argv[1], expectedLinkVersion: /^[1-9][0-9]*$/.test(argv[2]) ? Number(argv[2]) : null });
        if (!input.success) return { exitCode: 1, stderr: "Invalid task ID or expected link version.\n" + HELP };
        result = await openTaskChat(input.data);
      } else if (argv[0] === "submission" && argv.length === 2) {
        const input = lookupInputSchema.safeParse({ requestId: argv[1] });
        if (!input.success) return { exitCode: 1, stderr: "Invalid request UUID.\n" + HELP };
        result = getInputSubmission(input.data);
      } else if ((argv[0] === "submit" && argv.length === 3) || (argv[0] === "submit-mission" && argv.length === 5)) {
        const input = submitInputSchema.safeParse(argv[0] === "submit"
          ? { requestId: argv[1], text: argv[2], target: { scope: "personal" } }
          : { requestId: argv[1], text: argv[4], target: { scope: "mission", missionId: argv[2], expectedMissionVersion: /^[1-9][0-9]*$/.test(argv[3]) ? Number(argv[3]) : null } });
        if (!input.success) return { exitCode: 1, stderr: "Invalid instruction, UUID or pinned goal version.\n" + HELP };
        result = await submitInput(input.data);
      } else {
        return { exitCode: 1, stderr: "Unknown command or arguments.\n" + HELP };
      }
      return { exitCode: result.state === "available" || result.state === "saved" || result.state === "open_requested" ? 0 : ["not_sent", "rejected", "not_found"].includes(result.state) ? 1 : 2, stdout: JSON.stringify(result, null, 2) };
    },
  });
}
