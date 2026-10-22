import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import { codexDesktopContract, freshnessSchema, threadIdSchema, type ListThreadsResult, type ObservedThread, type OpenThreadResult, type Unavailable } from "./contract.js";

const BASE_URL = "http://127.0.0.1:7317";
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 5000;
const MAX_PUBLIC_THREADS = 500;
const runFile = promisify(execFile);
const timestampSchema = z.iso.datetime({ offset: true });

const monitorItemSchema = z.object({
  source_id: z.string().max(200),
  entity_kind: z.string().max(100),
  entity_id: z.string().max(500),
  host_id: z.string().max(200).nullable(),
  title: z.string().max(2000).nullable(),
  observed_at: timestampSchema,
  freshness: freshnessSchema,
  in_current_scope: z.boolean(),
  details: z.object({
    thread_kind: z.string().max(100).optional(),
    thread_id: z.string().max(200).optional(),
  }),
});

const monitorSchema = z.object({
  sources: z.array(z.object({
    source_id: z.string().max(200),
    captured_at: timestampSchema.nullable(),
    freshness: freshnessSchema,
    health: z.enum(["available", "unavailable", "unknown"]),
  })).max(20),
  items: z.array(monitorItemSchema).max(5000),
});

type Monitor = z.infer<typeof monitorSchema>;
type MonitorItem = z.infer<typeof monitorItemSchema>;
type MonitorRead = { state: "available"; observedAt: string; data: Monitor } | Unavailable;

function unavailable(reason: Unavailable["reason"]): Unavailable {
  return { state: "unavailable", observedAt: new Date().toISOString(), reason };
}

async function readMonitor(signal: AbortSignal): Promise<MonitorRead> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, TIMEOUT_MS);
  let received = false;
  try {
    const response = await fetch(BASE_URL + "/api/monitor", {
      method: "GET", redirect: "error", headers: { Accept: "application/json" }, signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return unavailable("service_unavailable");
    }
    received = true;
    const contentType = response.headers.get("content-type")?.split(";")[0].trim();
    const length = response.headers.get("content-length");
    if (contentType !== "application/json" || (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))) {
      await response.body?.cancel();
      return unavailable("invalid_response");
    }
    if (!response.body) return unavailable("invalid_response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) return unavailable("invalid_response");
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
    const data = monitorSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const sources = data.sources.filter(source => source.source_id === "codex_app");
    if (sources.length !== 1) return unavailable("invalid_response");
    if (sources[0].captured_at === null) return unavailable("snapshot_unavailable");
    return { state: "available", observedAt: new Date().toISOString(), data };
  } catch {
    return unavailable(received && !controller.signal.aborted ? "invalid_response" : "service_unavailable");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function localIdentity(item: MonitorItem): string | null {
  if (item.source_id !== "codex_app" || item.entity_kind !== "thread" || item.host_id !== "local" || item.details.thread_kind !== "codex") return null;
  const id = threadIdSchema.safeParse(item.details.thread_id);
  if (!id.success || item.entity_id !== "codex:" + item.details.thread_id) return null;
  return id.data;
}

function publicTitle(title: string | null, id: string): string {
  const text = title?.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!text || /(?:[\\/]|(?:^|\s)~|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|bearer\s|sk-[a-z0-9])/i.test(text)) return "Чат Codex · " + id.slice(0, 8);
  return text.length > 200 ? text.slice(0, 197) + "…" : text;
}

function publicThreads(data: Monitor): ObservedThread[] | null {
  const known = new Map<string, ObservedThread>();
  for (const item of data.items) {
    const id = localIdentity(item);
    if (id === null) continue;
    if (known.has(id)) return null;
    known.set(id, {
      threadId: id, kind: "codex", desktopHost: "local", title: publicTitle(item.title, id),
      observedAt: item.observed_at, freshness: item.freshness, inCurrentScope: item.in_current_scope,
    });
  }
  return [...known.values()].sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.threadId.localeCompare(b.threadId));
}

async function listThreads(signal: AbortSignal): Promise<ListThreadsResult> {
  if (process.platform !== "darwin") return unavailable("unsupported_platform");
  const result = await readMonitor(signal);
  if (result.state !== "available") return result;
  const threads = publicThreads(result.data);
  if (threads === null) return unavailable("invalid_response");
  const source = result.data.sources.find(item => item.source_id === "codex_app");
  if (!source || source.captured_at === null) return unavailable("snapshot_unavailable");
  const totalObserved = result.data.items.filter(item => item.source_id === "codex_app" && item.entity_kind === "thread").length;
  return {
    state: "available", observedAt: result.observedAt,
    data: {
      threads: threads.slice(0, MAX_PUBLIC_THREADS), sourceObservedAt: source.captured_at,
      sourceFreshness: source.freshness, sourceHealth: source.health,
      omittedCount: totalObserved - Math.min(threads.length, MAX_PUBLIC_THREADS), truncated: threads.length > MAX_PUBLIC_THREADS,
    },
  };
}

async function openThread(threadId: string, signal: AbortSignal): Promise<OpenThreadResult> {
  if (process.platform !== "darwin") return unavailable("unsupported_platform");
  const result = await readMonitor(signal);
  if (result.state !== "available") return result;
  const matches = result.data.items.filter(item => {
    if (item.source_id !== "codex_app" || item.entity_kind !== "thread") return false;
    const parsed = threadIdSchema.safeParse(item.details.thread_id);
    return parsed.success && parsed.data === threadId;
  });
  const local = matches.filter(item => localIdentity(item) === threadId);
  if (local.length > 1) return unavailable("invalid_response");
  if (local.length !== 1) {
    if (matches.some(item => item.details.thread_kind !== "codex")) return unavailable("unsupported_thread");
    if (matches.some(item => item.host_id === null)) return unavailable("unknown_desktop_host");
    if (matches.some(item => item.host_id !== "local")) return unavailable("nonlocal_thread");
    return unavailable("unknown_thread");
  }
  if (signal.aborted) return unavailable("open_failed");
  try {
    await runFile("/usr/bin/open", ["--", "codex://threads/" + threadId], {
      timeout: TIMEOUT_MS, maxBuffer: 8192, encoding: "utf8", signal,
    });
  } catch (error) {
    return unavailable(error instanceof Error && (error.name === "AbortError" || ("killed" in error && error.killed === true)) ? "open_outcome_unknown" : "open_failed");
  }
  return {
    state: "open_requested", threadId, requestedAt: new Date().toISOString(),
    sourceObservedAt: local[0].observed_at, sourceFreshness: local[0].freshness,
    navigationConfirmed: false,
  };
}

export default experimental_defineHostEntry({
  contract: codexDesktopContract,
  handlers: {
    listThreads(_input, context) { return listThreads(context.signal); },
    openThread(input, context) { return openThread(input.threadId, context.signal); },
  },
});
