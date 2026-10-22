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
  version: z.number().int().positive(),
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

const timestampSchema = z.string().datetime({ offset: true });
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const noteIdSchema = z.string().regex(/^note_[a-f0-9]{32}$/);
export const resultIdSchema = z.string().regex(/^input_result_[a-f0-9]{32}$/);
export const taskIdSchema = z.string().regex(/^task_[a-f0-9]{32}$/);
const desktopIdSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const nullableFlag = z.boolean().nullable();
const boundedText = (limit: number) => z.string().max(limit * 2).refine(value => [...value].length <= limit && !value.includes("\0"));

export const listInputsInputSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("personal") }).strict(),
  z.object({ scope: z.literal("mission"), missionId: missionIdSchema }).strict(),
]);
export const getInputInputSchema = z.object({ noteId: noteIdSchema }).strict();
export const inputArtifactInputSchema = getInputInputSchema.extend({ resultId: resultIdSchema }).strict();
export const taskChatInputSchema = z.object({ taskId: taskIdSchema }).strict();
export const openTaskChatInputSchema = taskChatInputSchema.extend({ expectedLinkVersion: z.number().int().positive() }).strict();

const planSchema = z.object({
  summary: boundedText(4000), required_outcomes: z.array(boundedText(4000)).max(30),
  findings: z.array(z.object({ description: boundedText(4000), severity: z.enum(["low", "medium", "high"]) })).max(30),
  next_actions: z.array(z.object({ title: boundedText(4000), reason: boundedText(4000) })).max(30),
  questions: z.array(boundedText(4000)).max(30),
});
const triageSchema = z.object({
  state: z.enum(["available", "empty", "unavailable", "error"]), run_id: z.string().max(200).nullable(), run_state: z.string().max(100).nullable(),
  summary: boundedText(4000).nullable(), plan: planSchema.nullable(), note_current: nullableFlag, mission_version_current: nullableFlag,
  execution_performed: z.literal(false), created_at: timestampSchema.nullable(), finished_at: timestampSchema.nullable(), error_code: z.string().max(200).nullable(),
});
const reviewSchema = z.object({
  state: z.enum(["available", "empty", "unavailable", "error"]), id: z.string().max(200).nullable(),
  outcome: z.enum(["no_blocking_findings", "changes_required", "inconclusive"]).nullable(), applicable: z.boolean(),
  applicable_at_recording: z.boolean().optional(), created_at: timestampSchema.optional(),
  finding_ids: z.array(z.string().max(200)).max(100).optional(), correction_state: z.string().max(100).nullable().optional(), independence_basis: z.string().max(200).optional(),
});
const publicArtifactSchema = z.object({ name: z.literal("research.json"), sha256: hashSchema, size: z.number().int().positive().max(512 * 1024) });
export const sourceArtifactSchema = publicArtifactSchema.extend({
  receipt_id: z.string().max(200), did: z.string().regex(/^delegation_[a-f0-9]{32}$/), aid: z.string().regex(/^attempt_[a-f0-9]{32}$/),
  revision: z.number().int().positive(), candidate_hash: hashSchema,
});
export const partialResultSchema = z.object({
  id: resultIdSchema, note_id: noteIdSchema, summary: boundedText(4000), next_action: boundedText(4000).nullable(),
  scope: z.literal("partial_result"), binding_basis: z.literal("operator_attached"), note_current: nullableFlag,
  note_context_state: z.enum(["available", "unavailable", "error"]), candidate_current: nullableFlag,
  candidate_id: z.string().max(200), note_version_at_attachment: z.number().int().positive(),
  result_availability: z.literal("not_rechecked"), review: reviewSchema, created_at: timestampSchema, artifact: publicArtifactSchema,
});
const resultsSchema = z.object({
  state: z.enum(["available", "unavailable", "error"]), items: z.array(partialResultSchema).max(5), total_count: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(), error_code: z.string().max(200).nullable(),
});
const sourceResultsSchema = resultsSchema.extend({ items: z.array(partialResultSchema.extend({ artifact: sourceArtifactSchema })).max(5) });
export const inputItemSchema = z.object({
  id: noteIdSchema, project_id: z.string().max(100).nullable(), text: boundedText(20000), input_kind: z.enum(["text", "voice"]),
  state: z.enum(["new", "reviewing", "planned", "done"]), version: z.number().int().positive(), mission_id: missionIdSchema.nullable(),
  mission_link_state: z.enum(["linked", "unlinked"]), created_at: timestampSchema, updated_at: timestampSchema, triage: triageSchema, results: resultsSchema,
});
export const inputDetailSchema = inputItemSchema.extend({ response: boundedText(20000) });
export const sourceInputDetailSchema = inputDetailSchema.extend({ results: sourceResultsSchema });
const inputListSchema = z.object({
  schema_version: z.literal(1), scope: z.enum(["personal", "mission"]), mission_id: missionIdSchema.nullable(), items: z.array(inputItemSchema).max(20),
  total_count: z.number().int().nonnegative(), truncated: z.boolean(), read_at: timestampSchema,
});
export const sourceInputListSchema = inputListSchema.extend({ items: z.array(inputItemSchema.extend({ results: sourceResultsSchema })).max(20) });
const inputDetailResponseSchema = z.object({ schema_version: z.literal(1), item: inputDetailSchema, read_at: timestampSchema });
export const sourceInputDetailResponseSchema = inputDetailResponseSchema.extend({ item: sourceInputDetailSchema });
export const researchContentSchema = z.object({
  summary: boundedText(12000), findings: z.array(z.object({ claim: boundedText(10000), source_ids: z.array(boundedText(200)).min(1).max(30) })).min(1).max(100),
  recommendations: z.array(boundedText(10000)).max(100), limitations: z.array(boundedText(10000)).min(1).max(100),
});
export const inputArtifactSchema = z.object({
  noteId: noteIdSchema, resultId: resultIdSchema, candidateId: z.string().max(200), artifact: publicArtifactSchema,
  content: researchContentSchema, review: reviewSchema, noteCurrent: nullableFlag, candidateCurrent: nullableFlag, integrity: z.literal("sha256_verified"),
});

export const qualityProfileInputSchema = z.object({ missionId: missionIdSchema, profileId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), version: z.number().int().min(1).max(999999999), profileHash: hashSchema }).strict();
const profileStateSchema = z.object({ id: qualityProfileInputSchema.shape.profileId, description: boundedText(1000) });
const profileCriterionSchema = z.object({ id: qualityProfileInputSchema.shape.profileId, description: boundedText(2000), state_ids: z.array(qualityProfileInputSchema.shape.profileId).max(12), evidence_required: boundedText(2000) });
const publicProfileSampleSchema = z.object({ id: qualityProfileInputSchema.shape.profileId, description: boundedText(2000), reference_state: z.literal("reported") });
const sourceProfileSampleSchema = publicProfileSampleSchema.omit({ reference_state: true }).transform(value => ({ ...value, reference_state: "reported" as const }));
const publicProfileDimensionSchema = z.object({ id: z.enum(["accuracy", "ux", "visual", "resilience", "delivery"]), applicable: z.boolean(), applicability_reason: boundedText(2000),
  criteria: z.array(profileCriterionSchema).max(20), states: z.array(profileStateSchema).max(12), examples: z.array(publicProfileSampleSchema).max(8), counterexamples: z.array(publicProfileSampleSchema).max(8) });
const publicQualityProfileSchema = z.object({ profile_id: qualityProfileInputSchema.shape.profileId, version: qualityProfileInputSchema.shape.version, mission_id: missionIdSchema, profile_hash: hashSchema,
  title: boundedText(200), minimum_score: z.literal(9), dimensions: z.array(publicProfileDimensionSchema).length(5), calibration: z.literal("unconfirmed"), references_verification: z.literal("reported"), owner_confirmed: z.literal(false) });
const qualityProfileResponseFields = { scope: z.literal("proposed_personal_os_quality_profile"), state: z.enum(["available", "not_registered", "unavailable", "error"]),
  context_current: nullableFlag, profile_current: nullableFlag, error_code: z.string().max(200).nullable(), completion_available: z.literal(false), native_gate_available: z.literal(false) };
export const qualityProfileResponseSchema = z.object({ ...qualityProfileResponseFields, profile: publicQualityProfileSchema.nullable() });
export const sourceQualityProfileResponseSchema = z.object({ ...qualityProfileResponseFields, profile: publicQualityProfileSchema.extend({ dimensions: z.array(publicProfileDimensionSchema.extend({
  examples: z.array(sourceProfileSampleSchema).max(8), counterexamples: z.array(sourceProfileSampleSchema).max(8) })).length(5) }).nullable() });

export const taskChatSchema = z.object({
  state: z.enum(["available", "unlinked", "unavailable"]), task_id: taskIdSchema, mission_id: missionIdSchema.nullable(),
  task_version: z.number().int().positive().nullable(), current_context_hash: hashSchema.nullable(), task_current: nullableFlag, context_current: nullableFlag, can_open: z.boolean(),
  link: z.object({ id: z.string().regex(/^task_chat_link_[a-f0-9]{32}$/), version: z.number().int().positive(), task_version: z.number().int().positive(),
    context_hash: hashSchema, desktop_thread_id: desktopIdSchema, desktop_host: z.literal("local"), created_at: timestampSchema }).nullable(),
  target: z.object({ state: z.enum(["available", "unavailable"]), observed_at: timestampSchema.nullable(), freshness: z.enum(["fresh", "stale", "unknown"]), in_current_scope: nullableFlag, error_code: z.string().max(200).nullable() }),
  error_code: z.string().max(200).nullable(),
}).refine(value => !value.can_open || (value.state === "available" && value.link !== null && value.task_current === true && value.context_current === true && value.target.state === "available" && value.task_version === value.link.task_version && value.current_context_hash === value.link.context_hash));

export const desktopOpenResultSchema = z.union([
  z.object({ state: z.literal("open_requested"), threadId: desktopIdSchema, requestedAt: timestampSchema, sourceObservedAt: timestampSchema, sourceFreshness: z.enum(["fresh", "stale", "unknown"]), navigationConfirmed: z.literal(false) }).strict(),
  z.object({ state: z.literal("unavailable"), observedAt: timestampSchema, reason: z.enum(["host_not_configured", "host_changed", "host_unavailable", "service_unavailable", "invalid_response", "snapshot_unavailable", "unsupported_platform", "unknown_thread", "unsupported_thread", "nonlocal_thread", "unknown_desktop_host", "open_failed", "open_outcome_unknown"]) }).strict(),
]);
export const openTaskChatResultSchema = z.union([
  desktopOpenResultSchema,
  z.object({ state: z.literal("unavailable"), observedAt: timestampSchema, reason: z.enum(["link_unavailable", "link_changed", "task_not_current", "context_not_current", "target_unavailable"]) }).strict(),
]);

export const taskExecutionIdSchema = z.string().regex(/^task_execution_[a-f0-9]{32}$/);
export const taskResultInputSchema = taskChatInputSchema.extend({ bindingId: taskExecutionIdSchema }).strict();
const nativeDeliveryIdSchema = z.string().min(1).max(200).refine(value => value.trim().length > 0 && ![".", ".."].includes(value) && !/[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value));
const nativeDeliveryArtifactSchema = z.object({ name: z.enum(["research.json", "code.json", "proposal.patch", "proposal.bundle"]), sha256: hashSchema, size: z.number().int().nonnegative().max(8 * 1024 * 1024) });
export const domainDeliverySchema = z.object({
  scope: z.literal("native_domain_delivery"), state: z.enum(["available", "not_assessed", "unavailable", "error"]),
  item: z.object({ delivery_id: nativeDeliveryIdSchema, delivery_hash: hashSchema, review_run_id: nativeDeliveryIdSchema, delegation_id: nativeDeliveryIdSchema,
    revision: z.number().int().positive(), attempt_id: nativeDeliveryIdSchema, input_hash: hashSchema, context_hash: hashSchema.nullable(), request_hash: hashSchema,
    profile: z.object({ id: nativeDeliveryIdSchema, version: z.number().int().positive(), hash: hashSchema }), artifact_refs: z.array(nativeDeliveryArtifactSchema).min(1).max(20), artifact_set_hash: hashSchema,
    scope: z.literal("bounded_packet_research"), state: z.enum(["passed", "blocked", "failed"]), outcome: z.enum(["pass", "fail", "unknown", "not_run"]),
    acceptance: z.enum(["pending", "accepted", "historical"]), current: z.boolean(), created_at: timestampSchema,
    gate_blockers: z.array(z.enum(["calibration_not_pinned", "review_not_passed", "binding_changed", "evidence_changed", "review_failed", "gate_conditions_unconfirmed"])).max(6).nullable().optional() }).nullable(),
  currentness: z.enum(["current", "historical", "unknown"]), snapshot_current: nullableFlag, context_current: nullableFlag, total_count: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(), error_code: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/).nullable(), files: z.literal("not_rechecked"), mission_acceptance: z.literal("not_assessed"), completion_available: z.literal(false),
}).refine(value => (value.state === "available") === (value.item !== null) && (value.currentness !== "current" || value.snapshot_current === true && value.context_current === true && value.item?.current === true));
const taskResearchReceiptSchema = publicArtifactSchema.extend({ acceptance: z.literal("verification_pending"), availability: z.literal("not_rechecked") });
const sourceTaskResearchReceiptSchema = taskResearchReceiptSchema.extend({
  receipt_id: z.string().min(1).max(200), did: z.string().regex(/^delegation_[a-f0-9]{32}$/), aid: z.string().regex(/^attempt_[a-f0-9]{32}$/), revision: z.number().int().positive(), input_hash: hashSchema.nullable().optional(),
});
const readinessIdentitySchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const readinessCountSchema = z.number().int().nonnegative();
const readinessCoverageFields = { total: readinessCountSchema, reported_checked: readinessCountSchema, reported_passed: readinessCountSchema, missing: readinessCountSchema };
export const candidateReadinessSchema = z.object({
  scope: z.literal("consumer_readiness_inspection"), state: z.enum(["unavailable", "not_assessed", "available", "error"]),
  candidate_id: z.string().regex(/^consumer_candidate_[a-f0-9]{32}$/), review_id: z.string().regex(/^consumer_review_[a-f0-9]{32}$/),
  assessment_id: readinessIdentitySchema.nullable(), assessment_hash: hashSchema.nullable(), readiness: z.enum(["blocked", "stale", "unavailable"]).nullable(),
  profile: z.object({ profile_id: readinessIdentitySchema, version: z.number().int().positive(), profile_hash: hashSchema }).nullable(),
  context_current: nullableFlag, profile_current: nullableFlag, profile_binding: z.literal("proposed_only").nullable(),
  dimension_scores: z.array(z.object({ dimension_id: z.enum(["accuracy", "ux", "visual", "resilience", "delivery"]), applicable: z.boolean(), score: z.number().min(0).max(10).nullable(), minimum_score: z.literal(9), basis: z.literal("reported"), score_origin: z.literal("assessment_request") })).max(5),
  coverage: z.object({ basis: z.literal("reported_review_evidence"), requirements: z.object({ ...readinessCoverageFields, review_evidence_covered: readinessCountSchema }),
    criterion_states: z.object(readinessCoverageFields), dimensions: z.object({ total: z.literal(5), reported_scored: readinessCountSchema, reported_at_threshold: readinessCountSchema }) }).nullable(),
  blockers: z.array(z.object({ code: z.string().regex(/^[a-z0-9_]{1,100}$/), target_type: z.enum(["profile", "candidate", "review", "criterion_state", "requirement", "dimension", "finding", "decision", "files", "mission"]), target_id: readinessIdentitySchema })).max(50),
  blocker_count: readinessCountSchema.nullable(), truncated: z.boolean(), files: z.literal("not_rechecked"), calibration: z.literal("unconfirmed"), independence: z.literal("unverified"),
  domain_acceptance: z.literal("not_assessed"), completion_available: z.literal(false), error_code: readinessIdentitySchema.nullable().optional(),
});
const taskReviewSchema = z.object({
  state: z.enum(["available", "not_registered", "enabled", "unavailable", "error"]), run_id: z.string().max(200).nullable(), run_phase: z.string().max(100).nullable(),
  outcome: z.enum(["no_blocking_findings", "changes_required", "inconclusive"]).nullable(), review_id: z.string().max(200).nullable(), candidate_id: z.string().max(200).nullable(),
  candidate_current: nullableFlag, applicable: nullableFlag, error_code: z.string().max(200).nullable(), readiness: candidateReadinessSchema.nullable(),
});
const taskInputResultSchema = z.object({
  state: z.enum(["prepared", "pending", "attached", "blocked", "error", "not_registered", "unavailable"]), note_id: noteIdSchema.nullable(),
  attachment_id: resultIdSchema.nullable(), retryable: z.boolean(), error_code: z.string().max(200).nullable(),
});
export const taskExecutionBindingSchema = z.object({
  id: taskExecutionIdSchema, created_at: timestampSchema, bound_task_version: z.number().int().positive(), task_version_current: nullableFlag, task_context_current: nullableFlag,
  currentness: z.enum(["current", "historical", "unknown"]), binding_state: z.enum(["enabled", "fenced"]), binding_error_code: z.string().max(200).nullable(),
  continuation: z.object({ id: z.string().regex(/^continuation_[a-f0-9]{32}$/), delegation_id: z.string().regex(/^delegation_[a-f0-9]{32}$/), attempt_id: z.string().regex(/^attempt_[a-f0-9]{32}$/).nullable(),
    revision: z.number().int().positive(), phase: z.string().min(1).max(100), launch_count: z.union([z.literal(0), z.literal(1)]), error_code: z.string().max(200).nullable(), created_at: timestampSchema, updated_at: timestampSchema }),
  artifact: z.object({ state: z.enum(["received", "not_received", "unavailable", "error"]), error_code: z.string().max(200).nullable(), receipt: taskResearchReceiptSchema.nullable() }),
  review: taskReviewSchema, domainDelivery: domainDeliverySchema, input_result: taskInputResultSchema, live_process_verified: z.literal(false), domain_acceptance: z.literal("not_assessed"), completion_available: z.literal(false),
});
const sourceTaskExecutionBindingSchema = taskExecutionBindingSchema.extend({
  artifact: taskExecutionBindingSchema.shape.artifact.extend({ receipt: sourceTaskResearchReceiptSchema.nullable() }),
});
const dispatcherSchema = z.object({
  policy_id: z.string().min(1).max(200), task_id: taskIdSchema, bound_task_version: z.number().int().positive(), task_version_current: z.boolean(),
  setup_state: z.enum(["pending", "ready"]), phase: z.string().min(1).max(100), delegation_id: z.string().max(200), continuation_id: z.string().max(200).nullable(), binding_id: taskExecutionIdSchema.nullable(),
  current_error_code: z.string().max(200).nullable(), last_error: z.object({ code: z.string().max(200), occurred_at: timestampSchema, seq: z.number().int().nonnegative() }).nullable(), live_process_verified: z.literal(false),
});
const executionCollectionFields = { state: z.enum(["available", "not_registered", "unavailable", "error"]), total_count: z.number().int().nonnegative().nullable(), truncated: z.boolean(), error_code: z.string().max(200).nullable() };
const completionArtifactSchema = taskResearchReceiptSchema.extend({
  binding_id: taskExecutionIdSchema, bound_task_version: z.number().int().positive(), task_version_current: nullableFlag, task_context_current: nullableFlag,
  currentness: z.enum(["current", "historical", "unknown"]), domainDelivery: domainDeliverySchema,
});
const sourceCompletionArtifactSchema = completionArtifactSchema.extend({
  input_hash: hashSchema.nullable().optional(), receipt_id: z.string().regex(/^artifact_receipt_[a-f0-9]{32}$/), did: z.string().regex(/^delegation_[a-f0-9]{32}$/), aid: z.string().regex(/^attempt_[a-f0-9]{32}$/), revision: z.number().int().positive(),
});
const completionReviewSchema = z.object({
  id: z.string().regex(/^consumer_review_[a-f0-9]{32}$/), candidate_id: z.string().max(200), outcome: z.enum(["no_blocking_findings", "changes_required", "inconclusive"]),
  candidate_current: nullableFlag, applicable: nullableFlag, applicable_at_recording: z.boolean(), readiness: candidateReadinessSchema.nullable(),
});
const completionEvidenceSchema = z.object({
  index: z.number().int().min(0).max(29), kind: z.enum(["artifact", "consumer_review", "recorded_source"]), state: z.enum(["resolved", "recorded_only", "unavailable", "error"]),
  artifact: completionArtifactSchema.nullable(), review: completionReviewSchema.nullable(), error_code: z.string().max(200).nullable(),
});
const completionSchema = z.object({
  state: z.enum(["not_done", "recorded", "unavailable", "error"]), task_version: z.number().int().positive(), context_current: nullableFlag,
  evidence_basis: z.literal("recorded_sources"), items: z.array(completionEvidenceSchema).max(30), error_code: z.string().max(200).nullable(),
});
const sourceCompletionSchema = completionSchema.extend({ items: z.array(completionEvidenceSchema.extend({ artifact: sourceCompletionArtifactSchema.nullable() })).max(30) });
export const taskActivityItemSchema = z.object({
  task: z.object({ id: taskIdSchema, mission_id: missionIdSchema, version: z.number().int().positive(), state: z.enum(taskStates), context_hash: hashSchema, current_context_hash: hashSchema.nullable(), context_current: nullableFlag }),
  completion: completionSchema,
  bindings: z.object({ ...executionCollectionFields, items: z.array(taskExecutionBindingSchema).max(5) }),
  dispatchers: z.object({ ...executionCollectionFields, items: z.array(dispatcherSchema).max(5) }), domain_acceptance: z.literal("not_assessed"), completion_available: z.literal(false),
});
const sourceTaskActivityItemSchema = taskActivityItemSchema.extend({
  completion: sourceCompletionSchema,
  bindings: taskActivityItemSchema.shape.bindings.extend({ items: z.array(sourceTaskExecutionBindingSchema).max(5) }),
});
const taskActivitySchema = z.object({
  schema_version: z.literal(1), state: z.enum(["available", "unavailable", "error"]), scope: z.enum(["task", "mission"]), mission_id: missionIdSchema.nullable(), task_id: taskIdSchema.nullable(),
  items: z.array(taskActivityItemSchema).max(50), total_count: z.number().int().nonnegative().nullable(), truncated: z.boolean(), error_code: z.string().max(200).nullable(),
  read_at: timestampSchema, live_process_verified: z.literal(false), completion_available: z.literal(false),
});
function deliveryMatchesReceipt(delivery: z.infer<typeof domainDeliverySchema>, receipt: { did: string; aid: string; revision: number; input_hash?: string | null; name: string; sha256: string; size: number } | null) {
  const item = delivery.item;
  return item === null || receipt !== null && item.delegation_id === receipt.did && item.attempt_id === receipt.aid && item.revision === receipt.revision && item.input_hash === receipt.input_hash && item.artifact_refs.length === 1 && item.artifact_refs[0].name === receipt.name && item.artifact_refs[0].sha256 === receipt.sha256 && item.artifact_refs[0].size === receipt.size;
}
export const sourceTaskActivitySchema = taskActivitySchema.extend({ items: z.array(sourceTaskActivityItemSchema).max(50) })
  .refine(value => value.items.every(item => item.completion.task_version === item.task.version && item.completion.context_current === item.task.context_current && item.bindings.items.every(binding => deliveryMatchesReceipt(binding.domainDelivery, binding.artifact.receipt)) && item.completion.items.every(ground => ground.artifact === null || deliveryMatchesReceipt(ground.artifact.domainDelivery, ground.artifact)) && item.bindings.items.every(binding => binding.review.readiness === null || binding.review.readiness.candidate_id === binding.review.candidate_id && binding.review.readiness.review_id === binding.review.review_id) && item.completion.items.every(ground => ground.review === null || ground.review.readiness === null || ground.review.readiness.candidate_id === ground.review.candidate_id && ground.review.readiness.review_id === ground.review.id) && (item.completion.state !== "recorded" || item.task.state === "done") && item.bindings.items.every(binding => binding.currentness !== "current" || (binding.task_version_current === true && binding.task_context_current === true && binding.bound_task_version === item.task.version && item.task.context_current === true)) && item.dispatchers.items.every(dispatcher => !dispatcher.task_version_current || dispatcher.bound_task_version === item.task.version)));
const taskResultSchema = z.object({
  taskId: taskIdSchema, missionId: missionIdSchema, bindingId: taskExecutionIdSchema, boundTaskVersion: z.number().int().positive(), currentness: z.enum(["current", "historical", "unknown"]),
  taskVersionCurrent: nullableFlag, taskContextCurrent: nullableFlag, artifact: publicArtifactSchema, content: researchContentSchema, review: taskReviewSchema,
  completionEvidence: z.object({ taskVersion: z.number().int().positive(), contextCurrent: nullableFlag, items: z.array(completionEvidenceSchema).max(30) }).nullable(),
  domainDelivery: domainDeliverySchema, activityReadAt: timestampSchema, integrity: z.literal("sha256_verified"),
});

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
  listInputs: { input: listInputsInputSchema, output: readResultSchema(inputListSchema) },
  getInput: { input: getInputInputSchema, output: readResultSchema(inputDetailResponseSchema) },
  getInputArtifact: { input: inputArtifactInputSchema, output: readResultSchema(inputArtifactSchema) },
  getQualityProfile: { input: qualityProfileInputSchema, output: readResultSchema(qualityProfileResponseSchema) },
  getTaskChat: { input: taskChatInputSchema, output: readResultSchema(taskChatSchema) },
  getTaskActivity: { input: taskChatInputSchema, output: readResultSchema(taskActivitySchema) },
  getMissionActivity: { input: missionInputSchema, output: readResultSchema(taskActivitySchema) },
  getTaskResult: { input: taskResultInputSchema, output: readResultSchema(taskResultSchema) },
  submitInput: { input: submitInputSchema, output: submissionResultSchema },
});

export const personalOsContract = defineRpcContract({
  ...personalOsHostContract,
  getInputSubmission: { input: lookupInputSchema, output: submissionLookupResultSchema },
  openTaskChat: { input: openTaskChatInputSchema, output: openTaskChatResultSchema },
});

export type PersonalOsContract = typeof personalOsContract;
export type CandidateReadiness = z.infer<typeof candidateReadinessSchema>;
export type DomainDeliveryRead = z.infer<typeof domainDeliverySchema>;
export type QualityProfileResult = z.infer<typeof personalOsContract.getQualityProfile.output>;
export type Mission = z.infer<typeof missionSchema>;
export type Task = z.infer<typeof publicTaskSchema>;
export type TaskList = z.infer<typeof taskListSchema>;
export type MissionsResult = z.infer<typeof personalOsContract.listMissions.output>;
export type MissionResult = z.infer<typeof personalOsContract.getMission.output>;
export type TasksResult = z.infer<typeof personalOsContract.listTasks.output>;
export type SubmitInput = z.infer<typeof submitInputSchema>;
export type SubmissionResult = z.infer<typeof submissionResultSchema>;
export type SubmissionLookupResult = z.infer<typeof submissionLookupResultSchema>;
export type ListInputsInput = z.infer<typeof listInputsInputSchema>;
export type InputItem = z.infer<typeof inputItemSchema>;
export type InputDetail = z.infer<typeof inputDetailSchema>;
export type PartialResult = z.infer<typeof partialResultSchema>;
export type InputsResult = z.infer<typeof personalOsContract.listInputs.output>;
export type InputDetailResult = z.infer<typeof personalOsContract.getInput.output>;
export type InputArtifactResult = z.infer<typeof personalOsContract.getInputArtifact.output>;
export type TaskChatResult = z.infer<typeof personalOsContract.getTaskChat.output>;
export type OpenTaskChatResult = z.infer<typeof openTaskChatResultSchema>;
export type TaskActivityItem = z.infer<typeof taskActivityItemSchema>;
export type TaskExecutionBinding = z.infer<typeof taskExecutionBindingSchema>;
export type TaskActivityResult = z.infer<typeof personalOsContract.getTaskActivity.output>;
export type MissionActivityResult = z.infer<typeof personalOsContract.getMissionActivity.output>;
export type TaskResult = z.infer<typeof personalOsContract.getTaskResult.output>;
