import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { packetHostContract, type PacketReceipt } from "./contract.js";
import { PacketJournal } from "./src/journal.js";

export { experimental_providerBridge } from "./src/bridge.js";

function snapshot(journal: PacketJournal, hostId: string, operationId: string, inputHash: string) {
  const base = { operation_id: operationId, input_hash: inputHash, native_stop_proven: false as const, resource_release_available: false as const };
  try {
    const intent = journal.intent(operationId, inputHash);
    if (!intent) return { ...base, state: "not_found" as const, stop_requested: false, receipt: null, error_code: null };
    if (intent.host_id !== hostId) throw new Error("host_binding_invalid");
    const receipt = journal.receipt(intent);
    return { ...base, state: receipt?.state === "completed" ? "completed" as const : "held" as const, stop_requested: journal.stopRequested(intent), receipt, error_code: receipt?.error_code ?? (receipt ? null : "delivery_unconfirmed") };
  } catch {
    return { ...base, state: "unavailable" as const, stop_requested: false, receipt: null, error_code: "operation_unavailable" };
  }
}

export default experimental_defineHostEntry({
  contract: packetHostContract,
  handlers: {
    status(input, context) {
      return snapshot(new PacketJournal(context.experimental_paths.dataDir, "host-data"), input.hostId, input.operationId, input.inputHash);
    },
    result(input, context): { receipt: PacketReceipt; text: string } {
      try {
        const journal = new PacketJournal(context.experimental_paths.dataDir, "host-data");
        const intent = journal.intent(input.operationId, input.inputHash);
        if (intent && intent.host_id !== input.hostId) throw new Error("host_binding_invalid");
        const receipt = intent && journal.receipt(intent);
        if (!intent || !receipt || receipt.state !== "completed") throw new Error("unconfirmed");
        return { receipt, text: journal.result(intent, receipt) };
      } catch { throw new Error("Packet research result is unavailable or unconfirmed"); }
    },
    requestStop(input, context) {
      const journal = new PacketJournal(context.experimental_paths.dataDir, "host-data");
      try {
        const intent = journal.intent(input.operationId, input.inputHash);
        if (intent && intent.host_id === input.hostId) journal.requestStop(intent);
      } catch {}
      return snapshot(journal, input.hostId, input.operationId, input.inputHash);
    },
  },
});
