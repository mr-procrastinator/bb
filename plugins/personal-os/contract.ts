import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const missionIdSchema = z.string().regex(/^mission_[a-f0-9]{32}$/);
export const missionInputSchema = z.object({ missionId: missionIdSchema }).strict();
export const taskStates = ["doing", "todo", "blocked", "done"] as const;

export const missionSchema = z.object({
  id: missionIdSchema,
  title: z.string().max(4000),
  objective: z.string().max(65536),
  state: z.string().max(100),
  version: z.number().int().positive(),
  next_action: z.object({ text: z.string().max(65536) }).nullable().optional(),
});

const taskFieldsSchema = z.object({
  id: z.string().regex(/^task_[a-f0-9]{32}$/),
  mission_id: missionIdSchema,
  title: z.string().max(4000),
  expected_result: z.string().max(4000).nullable(),
  next_action: z.string().max(4000).nullable(),
  state: z.enum(taskStates),
  blocker: z.string().max(2000).nullable(),
  owner_label: z.string().max(150).nullable(),
  context_current: z.boolean().nullable(),
  completion_current: z.boolean().nullable(),
  applied_skills: z.array(z.string().max(150)).max(30),
  recommended_skills: z.array(z.string().max(150)).max(30),
});

export const taskSchema = taskFieldsSchema.extend({ evidence_refs: z.array(z.unknown()).max(30) })
  .transform(({ evidence_refs, ...task }) => ({ ...task, evidenceCount: evidence_refs.length }));
export const publicTaskSchema = taskFieldsSchema.extend({ evidenceCount: z.number().int().min(0).max(30) });

export const taskListSourceSchema = z.object({
  state: z.enum(["available", "unavailable", "error"]),
  mission_id: missionIdSchema,
  items: z.array(taskSchema).max(500),
  counts: z.object({ todo: z.number().int().nonnegative(), doing: z.number().int().nonnegative(), blocked: z.number().int().nonnegative(), done: z.number().int().nonnegative() }).nullable(),
  current_done_count: z.number().int().nonnegative().nullable(),
  historical_done_count: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
});

export const taskListSchema = taskListSourceSchema.omit({ items: true }).extend({
  items: z.array(publicTaskSchema).max(500),
});

export const unavailableSchema = z.object({
  state: z.literal("unavailable"),
  reason: z.enum(["host_not_configured", "host_unavailable", "service_unavailable", "invalid_response"]),
  observedAt: z.string().datetime(),
}).strict();

export function readResultSchema<S extends z.ZodType>(schema: S) {
  return z.union([
    z.object({ state: z.literal("available"), observedAt: z.string().datetime(), data: schema }).strict(),
    unavailableSchema,
  ]);
}

export const lookupInputSchema = z.object({
  requestId: z.string().uuid().regex(/^[a-f0-9-]{36}$/),
}).strict();

export const submitInputSchema = lookupInputSchema.extend({
  text: z.string().min(1).max(20000).refine(value => value.trim().length > 0 && !value.includes("\0")),
  target: z.discriminatedUnion("scope", [
    z.object({ scope: z.literal("personal") }).strict(),
    z.object({ scope: z.literal("mission"), missionId: missionIdSchema, expectedMissionVersion: z.number().int().positive() }).strict(),
  ]),
}).strict();

const submissionIdentity = {
  requestId: lookupInputSchema.shape.requestId,
  observedAt: z.string().datetime(),
};

export const submissionResultSchema = z.discriminatedUnion("state", [
  z.object({
    ...submissionIdentity,
    state: z.literal("saved"),
    noteId: z.string().regex(/^note_[a-f0-9]{32}$/),
    noteVersion: z.literal(1),
    receiptState: z.literal("new"),
    missionId: missionIdSchema.nullable(),
    missionVersion: z.number().int().positive().nullable(),
  }).strict(),
  z.object({ ...submissionIdentity, state: z.literal("outcome_unknown"), reason: z.enum(["host_unavailable", "service_unavailable", "invalid_response", "storage_unavailable", "delivery_unconfirmed"]) }).strict(),
  z.object({ ...submissionIdentity, state: z.literal("blocked"), reason: z.enum(["host_changed", "request_mismatch", "host_not_configured"]) }).strict(),
  z.object({ ...submissionIdentity, state: z.literal("not_sent"), reason: z.literal("host_not_configured") }).strict(),
  z.object({ ...submissionIdentity, state: z.literal("rejected"), reason: z.enum(["version_conflict", "idempotency_conflict", "source_rejected"]) }).strict(),
]);

export const submissionLookupResultSchema = z.union([
  submissionResultSchema,
  z.object({ ...submissionIdentity, state: z.literal("not_found") }).strict(),
]);

export const personalOsHostContract = defineRpcContract({
  listMissions: {
    input: z.null(),
    output: readResultSchema(z.object({ missions: z.array(missionSchema).max(100) }).strict()),
  },
  getMission: { input: missionInputSchema, output: readResultSchema(missionSchema) },
  listTasks: { input: missionInputSchema, output: readResultSchema(taskListSchema) },
  submitInput: { input: submitInputSchema, output: submissionResultSchema },
});

export const personalOsContract = defineRpcContract({
  ...personalOsHostContract,
  getInputSubmission: { input: lookupInputSchema, output: submissionLookupResultSchema },
});

export type PersonalOsContract = typeof personalOsContract;
export type Mission = z.infer<typeof missionSchema>;
export type Task = z.infer<typeof publicTaskSchema>;
export type TaskList = z.infer<typeof taskListSchema>;
export type MissionsResult = z.infer<typeof personalOsContract.listMissions.output>;
export type MissionResult = z.infer<typeof personalOsContract.getMission.output>;
export type TasksResult = z.infer<typeof personalOsContract.listTasks.output>;
export type SubmitInput = z.infer<typeof submitInputSchema>;
export type SubmissionResult = z.infer<typeof submissionResultSchema>;
export type SubmissionLookupResult = z.infer<typeof submissionLookupResultSchema>;
