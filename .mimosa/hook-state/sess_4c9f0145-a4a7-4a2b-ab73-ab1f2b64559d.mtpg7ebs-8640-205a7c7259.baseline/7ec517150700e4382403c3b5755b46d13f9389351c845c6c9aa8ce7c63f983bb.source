import envelopeSchemaJson from "../schema/envelope.schema.json";
import type { EnvelopeType } from "./types";

interface EnvelopeSchemaJson {
  properties?: {
    type?: { enum?: string[] };
  };
}

const schema = envelopeSchemaJson as unknown as EnvelopeSchemaJson;

export const PROTOCOL_VERSION = 1;

/** 事件类型清单从 canonical schema 派生，单一来源。 */
export const EVENT_TYPES = (schema.properties?.type?.enum ?? []) as string[] as EnvelopeType[];

/** canonical envelope schema，测试与 ajv 校验共用。 */
export const ENVELOPE_SCHEMA = envelopeSchemaJson;
