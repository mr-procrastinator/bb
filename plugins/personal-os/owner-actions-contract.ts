import { z } from "zod";

const missionId = z.string().regex(/^mission_[a-f0-9]{32}$/);
const decisionId = z.string().regex(/^decision_[a-f0-9]{32}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = (limit: number) => z.string().max(limit * 2).refine(value => [...value].length <= limit && !value.includes("\0"));
const option = z.object({ id: text(100), label: text(200), description: text(2000) }).strict();
const question = z.object({
  id: decisionId, version: z.number().int().min(1).max(2), status: z.enum(["open", "resolved"]),
  context_hash: hash, context_current: z.boolean(), question: text(4000), reason: text(4000),
  options: z.array(option).min(2).max(5), recommended_option_id: text(100).nullable(),
  affected_work: z.array(text(500)).max(20), required_authority: z.array(text(500)).max(20),
  answer_available: z.boolean(), answer_unavailable_reason: z.enum(["already_resolved", "mission_cancelled", "mission_completed", "context_changed"]).nullable(),
  resolution: z.object({ option_id: text(100).nullable(), comment: text(4000), answered_at: text(100) }).strict().nullable(),
  created_at: text(100), updated_at: text(100),
}).strict().refine(value => new Set(value.options.map(item => item.id)).size === value.options.length
  && (value.recommended_option_id === null || value.options.some(item => item.id === value.recommended_option_id))
  && (value.resolution === null || value.resolution.option_id === null || value.options.some(item => item.id === value.resolution?.option_id))
  && (value.answer_available ? value.status === "open" && value.version === 1 && value.context_current && value.answer_unavailable_reason === null && value.resolution === null : value.answer_unavailable_reason !== null)
  && (value.status === "resolved" ? value.version === 2 && value.resolution !== null : value.version === 1 && value.resolution === null));
const collection = { loaded_count: z.number().int().nonnegative().nullable(), truncated: z.boolean() };
export const ownerActionsInputSchema = z.object({ mission_id: missionId }).strict();
export const ownerActionsSchema = z.object({
  schema_version: z.literal(1), scope: z.literal("local_owner_questions"), state: z.enum(["available", "unavailable", "error"]),
  mission_id: missionId, mission_version: z.number().int().positive().nullable(),
  questions: z.object({ ...collection, items: z.array(question).max(5) }).strict(),
  history: z.object({ ...collection, items: z.array(question).max(10) }).strict(),
  legacy: z.object({ ...collection, state: z.enum(["unavailable", "historical_unbound", "empty", "error"]), total_count: z.number().int().nonnegative().nullable(),
    items: z.array(z.object({ id: text(100), question: text(4000), status: text(100), answer: text(4000).nullable(), created_at: text(100), resolved_at: text(100).nullable() }).strict()).max(5) }).strict(),
  source_total_count: z.number().int().nonnegative().nullable(), source_truncated: z.boolean(), error_code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/).nullable(),
  other_blockers: z.literal("not_assessed"), native_questions: z.literal("not_included"), quality_acceptance: z.literal("not_assessed"),
  action_execution: z.literal("not_started"), external_action_performed: z.literal(false),
}).strict().refine(value => (value.state !== "available" || value.mission_version !== null && value.source_total_count !== null && value.error_code === null && value.questions.loaded_count !== null && value.history.loaded_count !== null)
  && (value.state === "available" || value.questions.items.length === 0 && value.history.items.length === 0)
  && value.questions.items.every(item => item.answer_available)
  && value.history.items.every(item => !item.answer_available)
  && new Set([...value.questions.items, ...value.history.items].map(item => item.id)).size === value.questions.items.length + value.history.items.length
  && [value.questions, value.history, value.legacy].every(group => group.loaded_count === null ? group.items.length === 0 : group.loaded_count >= group.items.length));

export const ownerActionsHostResultSchema = z.union([
  z.object({ state: z.literal("available"), observedAt: z.string().datetime(), data: ownerActionsSchema }).strict(),
  z.object({ state: z.literal("unavailable"), observedAt: z.string().datetime(), reason: z.enum(["host_not_configured", "host_unavailable", "service_unavailable", "invalid_response"]) }).strict(),
]);
export const ownerActionsResultSchema = z.union([
  z.object({ state: z.literal("available"), observedAt: z.string().datetime(), host_binding: hash, data: ownerActionsSchema }).strict(),
  z.object({ state: z.literal("unavailable"), observedAt: z.string().datetime(), reason: z.enum(["host_not_configured", "host_unavailable", "service_unavailable", "invalid_response"]) }).strict(),
]);
export const ownerDecisionSelectionSchema = z.object({ mission_id: missionId, mission_version: z.number().int().positive(),
  decision_id: decisionId, decision_version: z.number().int().positive(), context_hash: hash }).strict();
export const ownerAnswerResponseSchema = z.object({ option_id: text(100).nullable(), comment: text(4000) }).strict()
  .refine(value => value.option_id !== null || value.comment.trim().length > 0);
export const ownerAnswerRequestSchema = z.object({ request_id: z.string().uuid(), host_binding: hash, selection: ownerDecisionSelectionSchema, response: ownerAnswerResponseSchema }).strict();
export const ownerAnswerResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("saved"), request_id: z.string().uuid(), mission_id: missionId, decision_id: decisionId, decision_version: z.number().int().positive() }).strict(),
  z.object({ state: z.literal("rejected"), request_id: z.string().uuid(), mission_id: missionId, decision_id: decisionId, reason: z.enum(["version_conflict", "context_changed", "already_resolved", "request_mismatch"]) }).strict(),
  z.object({ state: z.literal("outcome_unknown"), request_id: z.string().uuid(), mission_id: missionId, decision_id: decisionId }).strict(),
]);

export type OwnerActionsData = z.infer<typeof ownerActionsSchema>;
export type OwnerActionsResult = z.infer<typeof ownerActionsResultSchema>;
export type OwnerQuestion = z.infer<typeof question>;
export type OwnerAnswerRequest = z.infer<typeof ownerAnswerRequestSchema>;
export type OwnerAnswerResult = z.infer<typeof ownerAnswerResultSchema>;
