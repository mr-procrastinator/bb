import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { checksumSchema, operationSchema } from "./src/packet.js";

export const operationInputSchema = z.object({ hostId: z.string().min(1).max(200), operationId: operationSchema, inputHash: checksumSchema }).strict();
const transportDiagnosticsSchema = z.object({ http_status: z.number().int().min(100).max(599), content_type: z.string().max(127).regex(/^[a-z0-9][a-z0-9.+_-]*\/[a-z0-9][a-z0-9.+_-]*$/).nullable() }).strict();
export type ReceiptTransportDiagnostics = z.infer<typeof transportDiagnosticsSchema>;
export const receiptSchema = z.object({
  schema_version: z.literal(1), operation_id: operationSchema, input_hash: checksumSchema,
  host_id: z.string().min(1).max(200),
  attempt_id: z.string().regex(/^attempt_[a-f0-9]{32}$/),
  bb_thread_id: z.string().min(1).max(200), provider_thread_id: z.string().min(1).max(200),
  provider_turn_id: z.string().min(1).max(200), client_request_id: z.string().min(1).max(200),
  profile_hash: checksumSchema, state: z.enum(["completed", "held"]),
  response_id: z.string().max(200).nullable(), actual_model: z.string().max(200).nullable(),
  requested_model: z.string().min(1).max(100),
  result_sha256: checksumSchema.nullable(), result_bytes: z.number().int().nonnegative().nullable(),
  local_request_quiesced: z.literal(true), remote_completion: z.enum(["confirmed", "unknown", "not_sent"]),
  error_code: z.string().max(100).nullable(), finished_at: z.string().datetime(), receipt_hash: checksumSchema,
  transport_diagnostics: transportDiagnosticsSchema.nullable().optional(),
  native_stop_proven: z.literal(false), resource_release_available: z.literal(false),
}).strict();
export type PacketReceipt = z.infer<typeof receiptSchema>;

export const statusResultSchema = z.object({
  state: z.enum(["not_found", "prepared", "held", "completed", "unavailable"]),
  operation_id: operationSchema, input_hash: checksumSchema, stop_requested: z.boolean(),
  receipt: receiptSchema.nullable(), error_code: z.string().max(100).nullable(),
  native_stop_proven: z.literal(false), resource_release_available: z.literal(false),
}).strict();
export const resultSchema = z.object({ receipt: receiptSchema, text: z.string().max(256 * 1024) }).strict();
export const packetHostContract = defineRpcContract({
  status: { input: operationInputSchema, output: statusResultSchema },
  result: { input: operationInputSchema, output: resultSchema },
  requestStop: { input: operationInputSchema, output: statusResultSchema },
});
