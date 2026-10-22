import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { operationInputSchema, packetHostContract } from "./contract.js";
import { canonical, MODE, profileSchema, PROVIDER_ID, sha256 } from "./src/packet.js";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    pilotEnabled: { type: "boolean", label: "Enable packet research pilot", default: false },
    hostId: { type: "string", label: "Exact enrolled pilot host ID", default: "", experimental_schema: z.string().max(200) },
    pilotModel: { type: "string", label: "Model observed in the native BB catalog", default: "", experimental_schema: z.string().max(100) },
    modelSourceRef: { type: "string", label: "Evidence for the observed model", default: "", experimental_schema: z.string().max(1000) },
  });
  const host = bb.hosts.experimental_client({ contract: packetHostContract });
  async function hostId(expected: string) {
    const current = await settings.get();
    if (!current.hostId || current.hostId !== expected) throw new Error("Packet pilot host binding changed");
    return current.hostId;
  }
  const handlers: PluginRpcHandlers<typeof packetHostContract> = {
    status: async input => host.call("status", input, { hostId: await hostId(input.hostId), timeoutMs: 5000 }),
    result: async input => host.call("result", input, { hostId: await hostId(input.hostId), timeoutMs: 5000 }),
    requestStop: async input => host.call("requestStop", input, { hostId: await hostId(input.hostId), timeoutMs: 5000 }),
  };
  bb.rpc.register(packetHostContract, handlers);
  bb.cli.register({
    name: "packet-research",
    summary: "Inspect exact packet attempt receipts; never starts inference",
    commands: [
      { name: "status", summary: "Read exact operation state", usage: "bb packet-research status <host-id> <operation-uuid> <input-sha256>" },
      { name: "result", summary: "Read a confirmed exact result", usage: "bb packet-research result <host-id> <operation-uuid> <input-sha256>" },
      { name: "stop", summary: "Request cancellation; not a native stop proof", usage: "bb packet-research stop <host-id> <operation-uuid> <input-sha256>" },
    ],
    async run(argv) {
      if (argv.length !== 4 || !["status", "result", "stop"].includes(argv[0])) return { exitCode: 1, stderr: "Use bb packet-research status|result|stop <host-id> <operation-uuid> <input-sha256>" };
      const parsed = operationInputSchema.safeParse({ hostId: argv[1], operationId: argv[2], inputHash: argv[3] });
      if (!parsed.success) return { exitCode: 1, stderr: "Invalid operation identity" };
      try {
        const value = argv[0] === "result" ? await handlers.result(parsed.data) : argv[0] === "stop" ? await handlers.requestStop(parsed.data) : await handlers.status(parsed.data);
        return { exitCode: 0, stdout: JSON.stringify(value, null, 2) };
      } catch { return { exitCode: 2, stderr: "Packet operation unavailable; do not resend an unresolved attempt" }; }
    },
  });
  bb.experimental_hooks.on("message.dispatch", async context => {
    if (context.requestedExecution.providerId !== PROVIDER_ID) return { action: "proceed" };
    const current = await settings.get();
    return current.pilotEnabled === true && current.hostId === context.host?.id && current.pilotModel === context.requestedExecution.model
      ? { action: "proceed" }
      : { action: "reject", message: "Packet pilot disabled or exact host/model binding changed" };
  });
  const current = await settings.get();
  if (current.pilotEnabled !== true) return;
  const profile = profileSchema.parse({ schema_version: 1, mode: MODE, enabled: true,
    host_id: current.hostId, model: current.pilotModel, model_source_ref: current.modelSourceRef, timeout_ms: 180000, max_response_bytes: 2 * 1024 * 1024 });
  if (!current.hostId) throw new Error("Packet pilot needs an exact enrolled host");
  const model = { id: profile.model, displayName: profile.model, description: "Operator-observed pinned model; no tools",
    supportedReasoningEfforts: [{ reasoningEffort: "high" as const, description: "High" }], defaultReasoningEffort: "high" as const, isDefault: true };
  bb.providers.register({
    id: PROVIDER_ID, displayName: "Packet research · без инструментов", icon: "BookOpen",
    experimental_bridgeOptions: { schema_version: 1, mode: MODE },
    models: { fallback: [model] }, maintenance: { health: true, usage: false, installation: false },
    capabilities: { fork: "none", supportsManualCompaction: false, supportsThreadArchive: false,
      supportsThreadRename: false, supportsServiceTier: false, supportsNativeUserQuestion: false,
      permissionModes: ["accept-edits"], reasoningLevels: ["high"] },
    composerActions: [], completedTurnDisplay: "flat",
    deriveProviderOptions(context) {
      if (context.settings.pilotEnabled !== true || context.settings.hostId !== profile.host_id || context.model !== profile.model || context.settings.pilotModel !== profile.model || context.settings.modelSourceRef !== profile.model_source_ref || context.permissionMode !== "accept-edits" || context.promptMode !== undefined) throw new Error("Packet pilot profile changed");
      return { schema_version: 1, mode: MODE, profile, profile_hash: sha256(canonical(profile)) };
    },
  });
}
