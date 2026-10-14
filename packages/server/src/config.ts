import { z } from 'zod';
import { MAX_PARTICIPANTS, SESSION_TTL_HOURS } from '@colive/protocol';

export const ServerConfigSchema = z.object({
  PORT: z.coerce.number().int().nonnegative().default(8787),
  MAX_PARTICIPANTS: z.coerce.number().int().positive().default(MAX_PARTICIPANTS),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(SESSION_TTL_HOURS),
  PUBLIC_URL: z.string().url().default('http://localhost:8787'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export function loadConfig(env: Record<string, unknown> = process.env): ServerConfig {
  return ServerConfigSchema.parse(env);
}
