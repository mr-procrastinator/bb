import { createHash } from "node:crypto";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { lookupInputSchema, missionInputSchema, personalOsContract, personalOsHostContract, submissionResultSchema, submitInputSchema, type MissionResult, type MissionsResult, type TasksResult, type SubmitInput, type SubmissionResult, type SubmissionLookupResult } from "./contract.js";

const HELP = "bb personal-os missions\nbb personal-os mission <mission_id>\nbb personal-os tasks <mission_id>\nbb personal-os submit <request-uuid> <quoted-text>\nbb personal-os submit-mission <request-uuid> <mission_id> <expected-version> <quoted-text>\nbb personal-os submission <request-uuid>\nJSON reads and bounded owner input. Repeat unknown outcomes with the exact request UUID, text and target. Configure the enrolled host ID with bb plugin config personal-os.";

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

  const handlers: PluginRpcHandlers<typeof personalOsContract> = {
    listMissions: () => hostCall(hostId => host.call("listMissions", null, { hostId, timeoutMs: 10000 })),
    getMission: input => hostCall(hostId => host.call("getMission", input, { hostId, timeoutMs: 10000 })),
    listTasks: input => hostCall(hostId => host.call("listTasks", input, { hostId, timeoutMs: 10000 })),
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
      { name: "submit", summary: "Save a personal instruction with a stable request UUID", usage: "bb personal-os submit <request-uuid> <quoted-text>" },
      { name: "submit-mission", summary: "Save an instruction pinned to a goal version", usage: "bb personal-os submit-mission <request-uuid> <mission_id> <expected-version> <quoted-text>" },
      { name: "submission", summary: "Read a saved command outcome without network or dispatch", usage: "bb personal-os submission <request-uuid>" },
    ],
    async run(argv) {
      if (argv.length === 0 || (argv.length === 1 && ["help", "--help", "-h"].includes(argv[0]))) return { exitCode: 0, stdout: HELP };
      let result: MissionsResult | MissionResult | TasksResult | SubmissionLookupResult;
      if (argv[0] === "missions" && argv.length === 1) {
        result = await handlers.listMissions(null);
      } else if ((argv[0] === "mission" || argv[0] === "tasks") && argv.length === 2) {
        const input = missionInputSchema.safeParse({ missionId: argv[1] });
        if (!input.success) return { exitCode: 1, stderr: "Invalid mission ID.\n" + HELP };
        result = argv[0] === "mission" ? await handlers.getMission(input.data) : await handlers.listTasks(input.data);
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
      return { exitCode: result.state === "available" || result.state === "saved" ? 0 : ["not_sent", "rejected", "not_found"].includes(result.state) ? 1 : 2, stdout: JSON.stringify(result, null, 2) };
    },
  });
}
