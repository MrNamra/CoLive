import { z } from 'zod';

export const RpcErrorCodeSchema = z.enum([
  'NOT_FOUND',
  'FORBIDDEN',
  'TOO_LARGE',
  'READ_ONLY',
  'INVALID_PATH',
  'INTERNAL',
  'VERSION_MISMATCH',
]);

export type RpcErrorCode = z.infer<typeof RpcErrorCodeSchema>;

export const RpcErrorSchema = z.object({
  code: RpcErrorCodeSchema,
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

export type RpcError = z.infer<typeof RpcErrorSchema>;

export class CoLiveError extends Error {
  public readonly code: RpcErrorCode;
  public readonly details?: Record<string, unknown>;

  constructor(code: RpcErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CoLiveError';
    this.code = code;
    this.details = details;
  }

  public toRpcError(): RpcError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}
