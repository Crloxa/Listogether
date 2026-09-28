import Ajv, { type ErrorObject } from "ajv";
import envelopeSchemaJson from "../schema/envelope.schema.json";
import { PROTOCOL_VERSION } from "./schema-source";
import type { Envelope, EnvelopeType } from "./types";

const ajv = new Ajv({
  strict: false,
  allErrors: true,
  validateSchema: false,
});

const validateEnvelopeData = ajv.compile(envelopeSchemaJson);

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors) return [];
  return errors.map((e) => `${e.instancePath} ${e.message ?? "is invalid"}`);
}

/**
 * 校验整条信封（含 type 与 payload 的 if/then 绑定）。
 * 输入未知（非对象、JSON 解析前的任意值）时返回失败而不抛错。
 */
export function validateEnvelope(message: unknown): ValidationResult {
  const valid = validateEnvelopeData(message) as boolean;
  if (valid) return { ok: true, errors: [] };
  return { ok: false, errors: formatErrors(validateEnvelopeData.errors) };
}

/** 快速构造一条信封，测试与调试用；必填字段给默认值。 */
export function makeEnvelope<T>(
  overrides: Partial<Envelope<T>> & { type: EnvelopeType; payload: T },
): Envelope<T> {
  return {
    v: PROTOCOL_VERSION,
    eventId: "evt-test-0001",
    roomRevision: 0,
    senderId: "member-host",
    sentAtMs: 0,
    ...overrides,
  };
}
