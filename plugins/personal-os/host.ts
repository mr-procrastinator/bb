import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import { missionSchema, personalOsContract, taskListSourceSchema } from "./contract.js";

const BASE_URL = "http://127.0.0.1:7317";
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 5000;

type ReadResult<T> =
  | { state: "available"; observedAt: string; data: T }
  | { state: "unavailable"; observedAt: string; reason: "service_unavailable" | "invalid_response" };

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
    const contentType = response.headers.get("content-type")?.split(";")[0].trim();
    const length = response.headers.get("content-length");
    if (contentType !== "application/json" || (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))) {
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
        if (size > MAX_BYTES) throw new Error("invalid_response");
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
    const data = schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    return { state: "available", observedAt: new Date().toISOString(), data };
  } catch {
    return { state: "unavailable", observedAt: new Date().toISOString(), reason: responseReceived && !controller.signal.aborted ? "invalid_response" : "service_unavailable" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export default experimental_defineHostEntry({
  contract: personalOsContract,
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
  },
});
