import { ENVELOPE_SCHEMA } from "./schema-source";

interface ErrorSchema {
  $defs?: {
    errorPayload?: { properties?: { code?: { enum?: string[] } } };
  };
}

const errorEnum =
  (ENVELOPE_SCHEMA as unknown as ErrorSchema).$defs?.errorPayload?.properties?.code?.enum ?? [];

export const ERROR_CODES = errorEnum as ErrorCode[];

export type ErrorCode = (typeof errorEnum)[number] & string;
