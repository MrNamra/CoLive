import { MAX_DISPLAY_NAME_LENGTH } from './constants.js';

/**
 * Sanitizes a user display name:
 * - Strips ASCII control characters (0x00-0x1F, 0x7F)
 * - Strips Unicode directional overrides (LRE, RLE, LRO, RLO, PDF, LRI, RLI, FSI, PDI, LRM, RLM)
 * - Trims whitespace
 * - Enforces max length of 32 characters
 * - Fallbacks to 'Guest' if empty
 */
export function sanitizeDisplayName(name: string): string {
  if (typeof name !== 'string') {
    return 'Guest';
  }

  // Remove control characters and bidirectional overrides
  const cleaned = name
    // eslint-disable-next-line no-control-regex -- Explicitly stripping ASCII control characters to prevent UI injection
    .replace(/[\x00-\x1F\x7F]/g, '')
    // Unicode directional characters: U+200E, U+200F, U+202A-U+202E, U+2066-U+2069
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .trim();

  if (!cleaned) {
    return 'Guest';
  }

  return cleaned.slice(0, MAX_DISPLAY_NAME_LENGTH);
}

/**
 * Produces a stable, deterministic identifier for a normalized file path.
 * Uses a 32-bit FNV-1a algorithm with hex encoding for cross-environment portability.
 */
export function hashDocId(normalizedPath: string): string {
  if (!normalizedPath || normalizedPath === '') {
    return 'root';
  }

  let hash = 0x811c9dc5;
  for (let i = 0; i < normalizedPath.length; i++) {
    hash ^= normalizedPath.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  const unsigned = hash >>> 0;
  return `doc_${unsigned.toString(16).padStart(8, '0')}`;
}

/**
 * Generates an alphanumeric ID.
 */
export function generateRandomId(length = 12): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
