import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { z } from "zod";
import { receiptSchema, type PacketReceipt, type ReceiptTransportDiagnostics } from "../contract.js";
import { canonical, checksumSchema, operationSchema, profileSchema, sha256, type Packet, type Profile } from "./packet.js";

const idText = z.string().min(1).max(200);
const sessionSchema = z.object({ schema_version: z.literal(1), host_id: idText, bb_thread_id: idText, provider_thread_id: idText, profile_hash: checksumSchema }).strict();
const intentSchema = z.object({
  ...sessionSchema.shape, operation_id: operationSchema, attempt_id: z.string().regex(/^attempt_[a-f0-9]{32}$/),
  input_hash: checksumSchema, provider_turn_id: idText, client_request_id: idText,
  requested_model: z.string().min(1).max(100), created_at: z.string().datetime(),
}).strict();
export type Intent = z.infer<typeof intentSchema>;
export type Session = z.infer<typeof sessionSchema>;

function privateDirectory(path: string, create: boolean): void {
  const target = resolve(path);
  let current = parse(target).root;
  for (const part of relative(current, target).split("/").filter(Boolean)) {
    const next = join(current, part);
    try { lstatSync(next); }
    catch (error) {
      if (!create || !missing(error)) throw error;
      mkdirSync(next, { mode: 0o700 });
      const parent = openSync(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(parent); } finally { closeSync(parent); }
    }
    const component = lstatSync(next);
    if (!component.isDirectory() || component.isSymbolicLink()) throw new Error("storage_unsafe");
    current = next;
  }
  if (realpathSync(path) !== resolve(path)) throw new Error("storage_unsafe");
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("storage_unsafe");
}

function read(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.nlink !== 1 || info.size > limit) throw new Error("storage_unsafe");
    const value = readFileSync(fd, { encoding: "utf8" });
    const after = fstatSync(fd);
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || Buffer.byteLength(value) > limit) throw new Error("storage_changed");
    return value;
  } finally { closeSync(fd); }
}

function exclusive(path: string, value: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, value, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export class PacketJournal {
  readonly root: string;
  constructor(dataDir: string, kind: "host-data" | "bridge-data") {
    const pluginRoot = dirname(dataDir);
    if (!isAbsolute(dataDir) || resolve(dataDir) !== dataDir || basename(dataDir) !== kind || basename(pluginRoot) !== "provider-packet-research" || basename(dirname(pluginRoot)) !== "plugins") throw new Error("storage_binding_invalid");
    this.root = join(pluginRoot, "packet-research-v1");
  }

  profile(): Profile {
    privateDirectory(this.root, false);
    return profileSchema.parse(JSON.parse(read(join(this.root, "profile.json"), 16384)));
  }

  session(threadId: string, profile: Profile): Session {
    privateDirectory(this.root, false);
    const directory = join(this.root, "sessions");
    privateDirectory(directory, true);
    const value = sessionSchema.parse({ schema_version: 1, host_id: profile.host_id, bb_thread_id: threadId, provider_thread_id: "packet_" + sha256(threadId).slice(0, 40), profile_hash: sha256(canonical(profile)) });
    const path = join(directory, sha256(threadId) + ".json");
    try { exclusive(path, canonical(value)); }
    catch (error) {
      const saved = sessionSchema.parse(JSON.parse(read(path, 16384)));
      if (canonical(saved) !== canonical(value)) throw new Error("session_binding_conflict");
      throw new Error("session_already_created");
    }
    return value;
  }

  claim(session: Session, packet: Packet, clientRequestId: string, profile: Profile): Intent {
    privateDirectory(this.root, false);
    const sessions = join(this.root, "sessions");
    privateDirectory(sessions, false);
    const intent = intentSchema.parse({ ...session, operation_id: packet.operation_id, attempt_id: packet.attempt_id,
      input_hash: packet.input_hash, provider_turn_id: "packet_turn_" + packet.operation_id,
      client_request_id: clientRequestId, requested_model: profile.model, created_at: new Date().toISOString() });
    exclusive(join(sessions, sha256(session.bb_thread_id) + ".turn.json"), canonical(intent));
    const operations = join(this.root, "operations");
    privateDirectory(operations, true);
    const directory = join(operations, packet.operation_id);
    privateDirectory(directory, true);
    const attempts = join(this.root, "attempts");
    privateDirectory(attempts, true);
    exclusive(join(attempts, sha256(canonical([packet.caller, packet.attempt_id])) + ".json"), canonical(intent));
    exclusive(join(directory, "intent.json"), canonical(intent));
    return intent;
  }

  intent(operationId: string, inputHash: string): Intent | null {
    operationSchema.parse(operationId); checksumSchema.parse(inputHash);
    privateDirectory(this.root, false);
    const directory = join(this.root, "operations", operationId);
    try { privateDirectory(directory, false); }
    catch (error) { if (missing(error)) return null; throw error; }
    const value = intentSchema.parse(JSON.parse(read(join(directory, "intent.json"), 16384)));
    if (value.operation_id !== operationId || value.input_hash !== inputHash) throw new Error("operation_binding_conflict");
    return value;
  }

  receipt(intent: Intent): PacketReceipt | null {
    const path = join(this.root, "operations", intent.operation_id, "receipt.json");
    let raw: string;
    try { raw = read(path, 16384); } catch (error) { if (missing(error)) return null; throw error; }
    const receipt = receiptSchema.parse(JSON.parse(raw));
    const { receipt_hash, ...body } = receipt;
    if (sha256(canonical(body)) !== receipt_hash || receipt.host_id !== intent.host_id || receipt.operation_id !== intent.operation_id || receipt.input_hash !== intent.input_hash || receipt.bb_thread_id !== intent.bb_thread_id || receipt.provider_thread_id !== intent.provider_thread_id || receipt.provider_turn_id !== intent.provider_turn_id || receipt.client_request_id !== intent.client_request_id || receipt.attempt_id !== intent.attempt_id || receipt.profile_hash !== intent.profile_hash || receipt.requested_model !== intent.requested_model) throw new Error("receipt_binding_conflict");
    if (receipt.state === "completed") this.result(intent, receipt);
    return receipt;
  }

  result(intent: Intent, receipt: PacketReceipt): string {
    if (receipt.state !== "completed" || receipt.remote_completion !== "confirmed" || receipt.response_id === null) throw new Error("result_unconfirmed");
    const raw = read(join(this.root, "operations", intent.operation_id, "result.json"), 256 * 1024);
    if (sha256(raw) !== receipt.result_sha256 || Buffer.byteLength(raw) !== receipt.result_bytes) throw new Error("result_binding_conflict");
    return raw;
  }

  finish(intent: Intent, outcome: { text: string; responseId: string; model: string | null } | { errorCode: string; requestStarted: boolean; transportDiagnostics?: ReceiptTransportDiagnostics }): PacketReceipt {
    const directory = join(this.root, "operations", intent.operation_id);
    privateDirectory(directory, false);
    const completed = "text" in outcome;
    if (completed) exclusive(join(directory, "result.json"), outcome.text);
    const body = { schema_version: 1 as const, host_id: intent.host_id, operation_id: intent.operation_id, input_hash: intent.input_hash,
      attempt_id: intent.attempt_id, bb_thread_id: intent.bb_thread_id, provider_thread_id: intent.provider_thread_id,
      provider_turn_id: intent.provider_turn_id, client_request_id: intent.client_request_id, profile_hash: intent.profile_hash,
      state: completed ? "completed" as const : "held" as const, response_id: completed ? outcome.responseId : null,
      actual_model: completed ? outcome.model : null, requested_model: intent.requested_model,
      result_sha256: completed ? sha256(outcome.text) : null, result_bytes: completed ? Buffer.byteLength(outcome.text) : null,
      local_request_quiesced: true as const, remote_completion: completed ? "confirmed" as const : outcome.requestStarted ? "unknown" as const : "not_sent" as const,
      error_code: completed ? null : outcome.errorCode, finished_at: new Date().toISOString(),
      ...(!completed && outcome.transportDiagnostics ? { transport_diagnostics: outcome.transportDiagnostics } : {}),
      native_stop_proven: false as const, resource_release_available: false as const };
    const receipt = receiptSchema.parse({ ...body, receipt_hash: sha256(canonical(body)) });
    exclusive(join(directory, "receipt.json"), canonical(receipt));
    return receipt;
  }

  stopRequested(intent: Intent): boolean {
    const path = join(this.root, "operations", intent.operation_id, "stop.json");
    if (!existsSync(path)) return false;
    const value = z.object({ operation_id: operationSchema, input_hash: checksumSchema }).strict().parse(JSON.parse(read(path, 16384)));
    if (value.operation_id !== intent.operation_id || value.input_hash !== intent.input_hash) throw new Error("stop_binding_conflict");
    return true;
  }

  requestStop(intent: Intent): void {
    if (this.receipt(intent) !== null || this.stopRequested(intent)) return;
    exclusive(join(this.root, "operations", intent.operation_id, "stop.json"), canonical({ operation_id: intent.operation_id, input_hash: intent.input_hash }));
  }
}
