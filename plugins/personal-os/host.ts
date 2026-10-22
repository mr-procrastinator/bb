import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import { missionSchema, personalOsHostContract, taskListSourceSchema, type SubmitInput, type SubmissionResult } from "./contract.js";

const BASE_URL = "http://127.0.0.1:7317";
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 5000;

type ReadResult<T> =
  | { state: "available"; observedAt: string; data: T }
  | { state: "unavailable"; observedAt: string; reason: "service_unavailable" | "invalid_response" };

async function responseJson(response: Response, maxBytes: number) {
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
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return value;
}

async function read<S extends z.ZodType>(path: string, schema: S, signal: AbortSignal): Promise<ReadResult<z.output<S>>> {
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
    const data = schema.parse(await responseJson(response, MAX_BYTES));
    return { state: "available", observedAt: new Date().toISOString(), data };
  } catch {
    return { state: "unavailable", observedAt: new Date().toISOString(), reason: responseReceived && !controller.signal.aborted ? "invalid_response" : "service_unavailable" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
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
    submitInput(input, context) {
      return submit(input, context.signal);
    },
  },
});
