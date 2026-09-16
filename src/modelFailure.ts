import type { ModelUsage } from "./ports";

/** Transport/configuration failure is not an agent decision (and never WAIT). */
export type ModelFailureCode =
  | "PROVIDER_UNAVAILABLE" | "AUTH_FAILED" | "RATE_LIMITED" | "TIMEOUT"
  | "SCHEMA_REJECTED" | "INVALID_OUTPUT" | "OUTPUT_LIMIT" | "CANCELLED";

export interface ModelFailure {
  code: ModelFailureCode;
  message: string;
  retryable: boolean;
  rawRef?: string;
  requestId?: string;
  occurredAt: string;
}

export class ModelGatewayError extends Error {
  readonly name = "ModelGatewayError";
  constructor(readonly failure: ModelFailure, readonly usage?: ModelUsage) {
    super(failure.message);
  }
}

export function modelFailure(
  code: ModelFailureCode, message: string, retryable: boolean,
  extra: Partial<Pick<ModelFailure, "rawRef" | "requestId">> = {},
): ModelFailure {
  return { code, message, retryable, occurredAt: new Date().toISOString(), ...extra };
}

/** Only classify external provider errors here. Runtime control never parses prose. */
export function classifyProviderFailure(message: string, providerCode?: string, status?: number): ModelFailure {
  if (status === 401 || status === 403 || /auth|unauthorized|not.logged.in|invalid.api.key/i.test(providerCode ?? message)) {
    return modelFailure("AUTH_FAILED", message, false);
  }
  if (status === 429 || /rate.limit|quota.exceeded/i.test(providerCode ?? message)) {
    return modelFailure("RATE_LIMITED", message, true);
  }
  if (/invalid_json_schema|invalid.schema|schema.rejected|schema.*(?:required|additionalProperties)/i.test(`${providerCode ?? ""} ${message}`)) {
    return modelFailure("SCHEMA_REJECTED", message, false);
  }
  return modelFailure("PROVIDER_UNAVAILABLE", message, status === undefined || status >= 500);
}
