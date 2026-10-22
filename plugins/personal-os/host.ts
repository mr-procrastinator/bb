import { createHash } from "node:crypto";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import { missionSchema, personalOsHostContract, taskListSourceSchema, sourceInputListSchema, sourceInputDetailResponseSchema, researchContentSchema, taskChatSchema, sourceTaskActivitySchema, type SubmitInput, type SubmissionResult, type InputArtifactResult, type TaskResult } from "./contract.js";

const BASE_URL = "http://127.0.0.1:7317";
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 5000;

type ReadResult<T> =
  | { state: "available"; observedAt: string; data: T }
  | { state: "unavailable"; observedAt: string; reason: "service_unavailable" | "invalid_response" };

async function responseBytes(response: Response, maxBytes: number) {
  const contentType = response.headers.get("content-type")?.split(";")[0].trim();
  const length = response.headers.get("content-length");
  if (contentType !== "application/json" || (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes))) {
    await response.body?.cancel();
    throw new Error("invalid_response");
  }
  if (!response.body) throw new Error("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error("invalid_response");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function responseJson(response: Response, maxBytes: number) {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await responseBytes(response, maxBytes)));
  return value;
}

async function read<S extends z.ZodType>(path: string, schema: S, signal: AbortSignal, maxBytes = MAX_BYTES): Promise<ReadResult<z.output<S>>> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, TIMEOUT_MS);
  let responseReceived = false;
  try {
    const response = await fetch(BASE_URL + path, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { state: "unavailable", observedAt: new Date().toISOString(), reason: "service_unavailable" };
    }
    responseReceived = true;
    const data = schema.parse(await responseJson(response, maxBytes));
    return { state: "available", observedAt: new Date().toISOString(), data };
  } catch {
    return { state: "unavailable", observedAt: new Date().toISOString(), reason: responseReceived && !controller.signal.aborted ? "invalid_response" : "service_unavailable" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function readInput(noteId: string, signal: AbortSignal) {
  return read("/api/inbox/" + encodeURIComponent(noteId), sourceInputDetailResponseSchema.refine(value => value.item.id === noteId && value.item.results.items.every(result => result.note_id === noteId)), signal, 512 * 1024);
}

async function readVerifiedResearch(path: string, artifact: { aid: string; size: number; sha256: string }, signal: AbortSignal): Promise<ReadResult<z.infer<typeof researchContentSchema>>> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, TIMEOUT_MS);
  let received = false;
  try {
    const response = await fetch(BASE_URL + path, { method: "GET", redirect: "error", headers: { Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      return { state: "unavailable", observedAt: new Date().toISOString(), reason: "service_unavailable" };
    }
    received = true;
    const bytes = await responseBytes(response, 512 * 1024);
    if (bytes.byteLength !== artifact.size || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("invalid_response");
    const report = z.object({ schema_version: z.literal(1), attempt_id: z.literal(artifact.aid), result: researchContentSchema, error_code: z.null(), acceptance: z.literal("verification_pending") })
      .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    return { state: "available", observedAt: new Date().toISOString(), data: report.result };
  } catch {
    return { state: "unavailable", observedAt: new Date().toISOString(), reason: received && !controller.signal.aborted ? "invalid_response" : "service_unavailable" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function readInputArtifact(noteId: string, resultId: string, signal: AbortSignal): Promise<InputArtifactResult> {
  const detail = await readInput(noteId, signal);
  if (detail.state !== "available") return detail;
  if (detail.data.item.results.state !== "available") return { state: "unavailable", observedAt: new Date().toISOString(), reason: "invalid_response" };
  const matches = detail.data.item.results.items.filter(result => result.id === resultId && result.note_id === noteId);
  if (matches.length !== 1) return { state: "unavailable", observedAt: new Date().toISOString(), reason: "invalid_response" };
  const result = matches[0];
  const path = "/api/inbox/" + encodeURIComponent(noteId) + "/results/" + encodeURIComponent(resultId) + "/artifact";
  const content = await readVerifiedResearch(path, result.artifact, signal);
  if (content.state !== "available") return content;
  return { state: "available", observedAt: content.observedAt, data: {
    noteId, resultId, candidateId: result.candidate_id,
    artifact: { name: result.artifact.name, sha256: result.artifact.sha256, size: result.artifact.size }, content: content.data,
    review: result.review, noteCurrent: result.note_current, candidateCurrent: result.candidate_current, integrity: "sha256_verified",
  } };
}

async function readTaskActivity(taskId: string, signal: AbortSignal) {
  return read("/api/task-execution?task_id=" + encodeURIComponent(taskId), sourceTaskActivitySchema.refine(value => value.scope === "task" && value.task_id === taskId && value.items.length <= 1 && value.items.every(item => item.task.id === taskId && item.task.mission_id === value.mission_id && item.dispatchers.items.every(dispatcher => dispatcher.task_id === taskId))), signal, 1024 * 1024);
}

async function readTaskResult(taskId: string, bindingId: string, signal: AbortSignal): Promise<TaskResult> {
  const activity = await readTaskActivity(taskId, signal);
  if (activity.state !== "available") return activity;
  const task = activity.data.items[0];
  if (activity.data.state !== "available" || !task) return { state: "unavailable", observedAt: new Date().toISOString(), reason: "service_unavailable" };
  const matches = task.bindings.state === "available" ? task.bindings.items.filter(binding => binding.id === bindingId) : [];
  if (matches.length > 1) return { state: "unavailable", observedAt: new Date().toISOString(), reason: "invalid_response" };
  const binding = matches[0];
  const grounds = task.completion.state === "recorded" ? task.completion.items.filter(item => item.state === "resolved" && item.artifact?.binding_id === bindingId) : [];
  const recordedArtifacts = grounds.map(item => item.artifact!);
  if (new Set(recordedArtifacts.map(artifact => JSON.stringify(artifact))).size > 1) return { state: "unavailable", observedAt: new Date().toISOString(), reason: "invalid_response" };
  const completionArtifact = recordedArtifacts[0];
  const artifact = binding?.artifact.state === "received" ? binding.artifact.receipt : completionArtifact;
  if (artifact == null || !binding && !completionArtifact) return { state: "unavailable", observedAt: new Date().toISOString(), reason: "service_unavailable" };
  if (binding && (artifact.did !== binding.continuation.delegation_id || artifact.aid !== binding.continuation.attempt_id || artifact.revision !== binding.continuation.revision)) return { state: "unavailable", observedAt: new Date().toISOString(), reason: "invalid_response" };
  if (completionArtifact && (artifact.sha256 !== completionArtifact.sha256 || artifact.size !== completionArtifact.size || artifact.did !== completionArtifact.did || artifact.aid !== completionArtifact.aid || artifact.revision !== completionArtifact.revision)) return { state: "unavailable", observedAt: new Date().toISOString(), reason: "invalid_response" };
  const path = "/api/task-execution/" + encodeURIComponent(bindingId) + "/artifact?task_id=" + encodeURIComponent(taskId);
  const content = await readVerifiedResearch(path, artifact, signal);
  if (content.state !== "available") return content;
  return { state: "available", observedAt: content.observedAt, data: {
    taskId, missionId: task.task.mission_id, bindingId, boundTaskVersion: binding?.bound_task_version ?? completionArtifact!.bound_task_version,
    currentness: binding?.currentness ?? completionArtifact!.currentness,
    taskVersionCurrent: binding ? binding.task_version_current : completionArtifact!.task_version_current, taskContextCurrent: binding ? binding.task_context_current : completionArtifact!.task_context_current,
    artifact: { name: artifact.name, sha256: artifact.sha256, size: artifact.size }, content: content.data,
    review: binding?.review ?? { state: "unavailable", run_id: null, run_phase: null, outcome: null, review_id: null, candidate_id: null, candidate_current: null, applicable: null, error_code: null, readiness: null },
    completionEvidence: grounds.length ? { taskVersion: task.completion.task_version, contextCurrent: task.completion.context_current, items: grounds } : null,
    activityReadAt: activity.data.read_at, integrity: "sha256_verified",
  } };
}

async function submit(input: SubmitInput, signal: AbortSignal): Promise<SubmissionResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, TIMEOUT_MS);
  const identity = () => ({ requestId: input.requestId, observedAt: new Date().toISOString() });
  let responseReceived = false;
  try {
    const target = input.target;
    const path = target.scope === "personal" ? "/api/inbox" : "/api/missions/" + encodeURIComponent(target.missionId) + "/input";
    const payload = target.scope === "personal"
      ? { project_id: null, text: input.text, input_kind: "text" }
      : { text: input.text, input_kind: "text", expected_version: target.expectedMissionVersion };
    const response = await fetch(BASE_URL + path, {
      method: "POST",
      redirect: "error",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Personal-OS": "1", "Idempotency-Key": "bb-personal-os:" + input.requestId },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    responseReceived = true;
    const raw = await responseJson(response, 16384);
    if (response.status === 201) {
      if (target.scope === "personal") {
        const receipt = z.object({ id: z.string().regex(/^note_[a-f0-9]{32}$/), version: z.literal(1), state: z.literal("new"), created_at: z.string().datetime({ offset: true }) }).parse(raw);
        return { ...identity(), state: "saved", noteId: receipt.id, noteVersion: receipt.version, receiptState: receipt.state, missionId: null, missionVersion: null };
      }
      const receipt = z.object({ mission_id: z.literal(target.missionId), version: z.literal(target.expectedMissionVersion + 1), note_id: z.string().regex(/^note_[a-f0-9]{32}$/), note_version: z.literal(1), state: z.literal("new") }).parse(raw);
      return { ...identity(), state: "saved", noteId: receipt.note_id, noteVersion: receipt.note_version, receiptState: receipt.state, missionId: receipt.mission_id, missionVersion: receipt.version };
    }
    if (response.status >= 400 && response.status < 500) {
      const error = z.object({ code: z.string().max(100) }).safeParse(raw);
      if (error.success && ["version_conflict", "idempotency_conflict", "mission_not_registered", "invalid_transition"].includes(error.data.code)) {
        const reason = error.data.code === "version_conflict" ? "version_conflict" : error.data.code === "idempotency_conflict" ? "idempotency_conflict" : "source_rejected";
        return { ...identity(), state: "rejected", reason };
      }
    }
    return { ...identity(), state: "outcome_unknown", reason: "service_unavailable" };
  } catch {
    return { ...identity(), state: "outcome_unknown", reason: responseReceived && !controller.signal.aborted ? "invalid_response" : "service_unavailable" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export default experimental_defineHostEntry({
  contract: personalOsHostContract,
  handlers: {
    listMissions(_input, context) {
      return read("/api/missions", z.object({ missions: z.array(missionSchema).max(100) }), context.signal);
    },
    getMission(input, context) {
      return read("/api/missions/" + encodeURIComponent(input.missionId), missionSchema.refine(mission => mission.id === input.missionId), context.signal);
    },
    listTasks(input, context) {
      return read("/api/tasks?mission_id=" + encodeURIComponent(input.missionId), taskListSourceSchema.refine(tasks => tasks.mission_id === input.missionId && tasks.items.every(task => task.mission_id === input.missionId)), context.signal);
    },
    listInputs(input, context) {
      const missionId = input.scope === "mission" ? input.missionId : null;
      const path = "/api/inbox?scope=" + input.scope + (missionId ? "&mission_id=" + encodeURIComponent(missionId) : "") + "&limit=20";
      return read(path, sourceInputListSchema.refine(value => value.scope === input.scope && value.mission_id === missionId && value.items.every(item => item.mission_id === missionId && (input.scope !== "personal" || (item.project_id === null && item.mission_link_state === "unlinked")) && item.results.items.every(result => result.note_id === item.id))), context.signal, 1024 * 1024);
    },
    getInput(input, context) { return readInput(input.noteId, context.signal); },
    getInputArtifact(input, context) { return readInputArtifact(input.noteId, input.resultId, context.signal); },
    getTaskChat(input, context) {
      return read("/api/task-chat-links?task_id=" + encodeURIComponent(input.taskId), taskChatSchema.refine(value => value.task_id === input.taskId), context.signal, 65536);
    },
    getTaskActivity(input, context) { return readTaskActivity(input.taskId, context.signal); },
    getMissionActivity(input, context) {
      return read("/api/task-execution?mission_id=" + encodeURIComponent(input.missionId) + "&limit=50", sourceTaskActivitySchema.refine(value => value.scope === "mission" && value.mission_id === input.missionId && value.task_id === null && value.items.every(item => item.task.mission_id === input.missionId && item.dispatchers.items.every(dispatcher => dispatcher.task_id === item.task.id))), context.signal, 1024 * 1024);
    },
    getTaskResult(input, context) { return readTaskResult(input.taskId, input.bindingId, context.signal); },
    submitInput(input, context) {
      return submit(input, context.signal);
    },
  },
});
