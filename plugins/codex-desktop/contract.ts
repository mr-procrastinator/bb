import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const threadIdSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i).transform(value => value.toLowerCase());
export const openThreadInputSchema = z.object({ threadId: threadIdSchema }).strict();
export const freshnessSchema = z.enum(["fresh", "stale", "unknown"]);
const timestampSchema = z.iso.datetime({ offset: true });

export const observedThreadSchema = z.object({
  threadId: threadIdSchema,
  kind: z.literal("codex"),
  desktopHost: z.literal("local"),
  title: z.string().min(1).max(200),
  observedAt: timestampSchema,
  freshness: freshnessSchema,
  inCurrentScope: z.boolean(),
}).strict();

export const unavailableSchema = z.object({
  state: z.literal("unavailable"),
  observedAt: timestampSchema,
  reason: z.enum([
    "host_not_configured", "host_unavailable", "service_unavailable", "invalid_response",
    "snapshot_unavailable", "unsupported_platform", "unknown_thread", "unsupported_thread",
    "nonlocal_thread", "unknown_desktop_host", "open_failed", "open_outcome_unknown",
  ]),
}).strict();

export const codexDesktopContract = defineRpcContract({
  listThreads: {
    input: z.null(),
    output: z.union([
      z.object({
        state: z.literal("available"),
        observedAt: timestampSchema,
        data: z.object({
          threads: z.array(observedThreadSchema).max(500),
          sourceObservedAt: timestampSchema,
          sourceFreshness: freshnessSchema,
          sourceHealth: z.enum(["available", "unavailable", "unknown"]),
          omittedCount: z.number().int().nonnegative(),
          truncated: z.boolean(),
        }).strict(),
      }).strict(),
      unavailableSchema,
    ]),
  },
  openThread: {
    input: openThreadInputSchema,
    output: z.union([
      z.object({
        state: z.literal("open_requested"),
        threadId: threadIdSchema,
        requestedAt: timestampSchema,
        sourceObservedAt: timestampSchema,
        sourceFreshness: freshnessSchema,
        navigationConfirmed: z.literal(false),
      }).strict(),
      unavailableSchema,
    ]),
  },
});

export type CodexDesktopContract = typeof codexDesktopContract;
export type ObservedThread = z.infer<typeof observedThreadSchema>;
export type ListThreadsResult = z.infer<typeof codexDesktopContract.listThreads.output>;
export type OpenThreadResult = z.infer<typeof codexDesktopContract.openThread.output>;
export type Unavailable = z.infer<typeof unavailableSchema>;
