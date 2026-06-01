import type { GatewayErrorCode } from "./contracts.js";

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;

  constructor(code: GatewayErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GatewayError";
    this.code = code;
  }
}

export function toGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) {
    return error;
  }
  if (error instanceof Error) {
    return new GatewayError("protocol_error", error.message, { cause: error });
  }
  return new GatewayError("internal_error", "Unknown gateway error");
}
