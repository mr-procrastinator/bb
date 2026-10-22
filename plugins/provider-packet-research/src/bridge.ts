import { createBridgeIo, experimental_defineProviderBridge, initializeParamsSchema, threadStartParamsSchema, threadStopParamsSchema, turnStartParamsSchema, runBridgeRequest, BRIDGE_JSON_RPC_ERRORS, PROVIDER_BRIDGE_PROTOCOL_VERSION, THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_NOTIFICATION_METHOD, type ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import type { PacketReceipt, ReceiptTransportDiagnostics } from "../contract.js";
import { PacketJournal, type Intent, type Session } from "./journal.js";
import { canonical, MODE, parsePacket, profileSchema, promptFor, sha256, validateReport, type Profile } from "./packet.js";
import { inferPacket, PacketInferenceError } from "./inference.js";

type Id = string | number;
type Active = { intent: Intent; controller: AbortController; finished: Promise<void> };
const sessions = new Map<string, { session: Session; profile: Profile }>();
const active = new Map<string, Active>();
const io = createBridgeIo<{ jsonrpc: "2.0" } & Record<string, unknown>>();
let journal: PacketJournal | null = null;

type RefusalCode = "packet_thread_start_invalid" | "packet_provider_options_invalid" | "packet_profile_unavailable" | "packet_profile_binding_invalid" | "packet_initial_input_not_supported";
class PacketBridgeRefusal extends Error {
  constructor(readonly code: RefusalCode) { super(code); }
}

function storage(): PacketJournal {
  if (journal === null) throw new Error("bridge_not_initialized");
  return journal;
}

function deltas(threadId: string, values: ThreadDelta[]): void {
  io.send({ jsonrpc: "2.0", method: THREAD_DELTA_NOTIFICATION_METHOD, params: { threadId, deltas: values } });
}

function options(value: z.infer<typeof threadStartParamsSchema>["options"]): Profile {
  const parsed = z.object({ schema_version: z.literal(1), mode: z.literal(MODE), profile: profileSchema, profile_hash: z.string().regex(/^[a-f0-9]{64}$/), additionalWorkspaceWriteRoots: z.array(z.string().min(1).max(32768)).max(256).optional() }).strict().safeParse(value.providerOptions);
  if (!parsed.success) throw new PacketBridgeRefusal("packet_provider_options_invalid");
  const pinned = parsed.data;
  let local: Profile;
  try { local = storage().profile(); }
  catch { throw new PacketBridgeRefusal("packet_profile_unavailable"); }
  if (pinned.profile_hash !== sha256(canonical(local)) || canonical(local) !== canonical(pinned.profile) || value.model !== local.model || value.reasoningLevel !== "high" || value.permissionScope !== "workspace" || value.promptMode !== undefined) throw new PacketBridgeRefusal("packet_profile_binding_invalid");
  return local;
}

type Failure = { errorCode: string; requestStarted: boolean; transportDiagnostics?: ReceiptTransportDiagnostics };

function safeFailure(error: unknown): Failure {
  return error instanceof PacketInferenceError
    ? { errorCode: error.code, requestStarted: error.requestStarted,
        ...(error.diagnostics === null ? {} : { transportDiagnostics: { http_status: error.diagnostics.httpStatus, content_type: error.diagnostics.normalizedContentType } }) }
    : { errorCode: "result_or_storage_unconfirmed", requestStarted: true };
}

function failureText(failure: Failure): string {
  const reasons = new Map([
    ["invalid_content_type", "Сервис вернул ответ в неподдерживаемом формате."],
    ["auth_unavailable", "Не удалось использовать текущий вход в ChatGPT."],
    ["auth_expired", "Срок текущего входа в ChatGPT истёк."],
    ["auth_rejected", "Сервис отклонил текущий вход в ChatGPT."],
    ["api_key_forbidden", "Для этой попытки нужен вход по подписке ChatGPT."],
    ["rate_limited", "Сервис сообщил об ограничении запросов."],
    ["timeout", "Время ожидания ответа истекло."],
    ["aborted", "Запрос остановлен локально."],
    ["incomplete_response", "Полный ответ сервиса не получен."],
  ]);
  const reason = reasons.get(failure.errorCode) ?? "Ответ не удалось проверить или сохранить.";
  const remote = failure.requestStarted ? "Исход запроса на стороне сервиса неизвестен." : "Запрос к модели не отправлен.";
  return `${reason} Результат не подтверждён.\n\nПопытка удержана. ${remote} Автоматического повтора не будет.`;
}

async function execute(intent: Intent, packetText: string, profile: Profile, controller: AbortController): Promise<void> {
  let delivery: { text: string; receipt: PacketReceipt } | null = null;
  const interval = setInterval(() => {
    try { if (storage().stopRequested(intent)) controller.abort(); }
    catch { controller.abort(); }
  }, 200);
  try {
    if (storage().stopRequested(intent)) controller.abort();
    const packet = parsePacket(packetText);
    const result = await inferPacket({ model: profile.model, prompt: promptFor(packet), timeoutMs: profile.timeout_ms, maxResponseBytes: profile.max_response_bytes }, controller.signal);
    validateReport(result.text, packet);
    const receipt = storage().finish(intent, { text: result.text, responseId: result.responseId, model: result.model });
    delivery = { text: result.text, receipt };
  } catch (error) {
    const failure = safeFailure(error);
    try { storage().finish(intent, failure); } catch {}
    const key = { providerItemId: "packet-failure-" + intent.operation_id };
    const providerTurnId = intent.provider_turn_id;
    deltas(intent.bb_thread_id, [
      { kind: "item.open", providerTurnId, key, item: { type: "agentMessage", text: "" }, presentation: { label: { pending: "Исследование", completed: "Попытка удержана" }, icon: { glyph: "BookOpen" } } },
      { kind: "item.textClose", providerTurnId, key, channel: "agentMessage", text: failureText(failure) },
      { kind: "turn.boundary", providerTurnId, status: "failed" },
    ]);
  } finally { clearInterval(interval); active.delete(intent.bb_thread_id); }
  if (delivery !== null) {
    const key = { providerItemId: "packet-result-" + intent.operation_id };
    const providerTurnId = intent.provider_turn_id;
    deltas(intent.bb_thread_id, [
      { kind: "item.open", providerTurnId, key, item: { type: "agentMessage", text: "" }, presentation: { label: { pending: "Исследование", completed: "Результат исследования" }, icon: { glyph: "BookOpen" } } },
      { kind: "item.textClose", providerTurnId, key, channel: "agentMessage", text: delivery.text },
      { kind: "turn.boundary", providerTurnId, status: delivery.receipt.state === "completed" ? "completed" : "failed" },
    ]);
  }
}

async function handle(id: Id, method: string, params: unknown): Promise<void> {
  if (method === "initialize") {
    initializeParamsSchema.parse(params);
    io.sendResult(id, { protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION, capabilities: {
      grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3], sessionRestore: false,
      threadArchive: false, threadRename: false, threadGoalClear: false, fork: "none",
      approvalEnforcedBy: "runtime", steerMode: "queue",
    } });
    return;
  }
  if (method === "model/list") {
    const profile = storage().profile();
    io.sendResult(id, { models: [{ id: profile.model, model: profile.model, displayName: profile.model,
      description: "Pinned operator-observed model; packet-only", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }], defaultReasoningEffort: "high", isDefault: true }], selectedOnlyModels: [] });
    return;
  }
  if (method === "provider/health") {
    let ready = false;
    try { storage().profile(); ready = true; } catch {}
    io.sendResult(id, { supported: true, health: { status: ready ? "ready" : "unknown", statusMessage: ready ? "Packet profile present; login and inference not verified" : "Trusted packet profile unavailable", accountEmail: null, planLabel: null, installedVersion: null, minimumSupportedVersion: null, canInstall: false, canUpdate: false, loginCommand: null } });
    return;
  }
  if (method === "thread/start") {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success) throw new PacketBridgeRefusal("packet_thread_start_invalid");
    const input = parsed.data;
    if (input.input?.length) throw new PacketBridgeRefusal("packet_initial_input_not_supported");
    const profile = options(input.options);
    const session = storage().session(input.threadId, profile);
    sessions.set(input.threadId, { session, profile });
    io.sendResult(id, { providerThreadId: session.provider_thread_id, sessionRestorable: false });
    deltas(input.threadId, [{ kind: "session.reset" }]);
    return;
  }
  if (method === "turn/start") {
    const input = turnStartParamsSchema.parse(params);
    const local = sessions.get(input.threadId);
    if (!local || local.session.provider_thread_id !== input.providerThreadId || active.has(input.threadId)) throw new Error("session_unavailable");
    const profile = options(input.options);
    if (canonical(profile) !== canonical(local.profile) || input.input.length !== 1 || input.input[0].type !== "text") throw new Error("packet_only_input_required");
    const raw = input.input[0].text;
    const packet = parsePacket(raw);
    const intent = storage().claim(local.session, packet, input.clientRequestId, profile);
    const controller = new AbortController();
    let resolveFinished: () => void = () => undefined;
    const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
    active.set(input.threadId, { intent, controller, finished });
    io.sendResult(id, {});
    deltas(input.threadId, [{ kind: "turn.open", providerTurnId: intent.provider_turn_id }, { kind: "input.accepted", providerTurnId: intent.provider_turn_id, clientRequestId: input.clientRequestId }]);
    void execute(intent, raw, profile, controller).finally(resolveFinished);
    return;
  }
  if (method === "thread/stop") {
    const input = threadStopParamsSchema.parse(params);
    const session = sessions.get(input.threadId);
    if (session && session.session.provider_thread_id !== input.providerThreadId) throw new Error("session_binding_invalid");
    const running = active.get(input.threadId);
    if (running) {
      storage().requestStop(running.intent);
      running.controller.abort();
      await running.finished;
    }
    sessions.delete(input.threadId);
    io.sendResult(id, {});
    return;
  }
  io.sendError(id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, "Unsupported in packet-only provider");
}

function handleLine(line: string): void {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return; }
  const envelope = z.object({ id: z.union([z.string(), z.number()]), method: z.string(), params: z.unknown().optional() }).safeParse(value);
  if (!envelope.success) return;
  const request = envelope.data;
  runBridgeRequest({ request: { id: request.id, method: request.method, params: request.params }, sendError: io.sendError, handleRequest: async () => {
    try { await handle(request.id, request.method, request.params); }
    catch (error) {
      const code = error instanceof PacketBridgeRefusal ? error.code : error instanceof z.ZodError ? "packet_protocol_params_invalid" : "packet_request_or_storage_unconfirmed";
      io.sendError(request.id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, code, { code });
    }
  } });
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start(context) { journal = new PacketJournal(context.dataDir, "bridge-data"); },
  onClose() { for (const running of active.values()) running.controller.abort(); },
  onSigterm() { for (const running of active.values()) running.controller.abort(); },
  onSigint() { for (const running of active.values()) running.controller.abort(); },
});
