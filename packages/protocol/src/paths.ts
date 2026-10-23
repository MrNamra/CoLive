import picomatch from 'picomatch';
import { CoLiveError } from './errors.js';

/**
 * Normalizes a workspace relative path.
 * Enforces strict sandboxing rules:
 * - Converts backslashes to forward slashes.
 * - Handles percent-encoded path traversal (%2e%2e, %2f, etc.).
 * - Rejects null bytes (%00, \0).
 * - Rejects absolute paths (leading / or \).
 * - Rejects Windows drive letters (e.g., C:, D:).
 * - Rejects directory traversal (..).
 * - Returns a clean POSIX relative path (e.g. "src/app.ts" or "" for root).
 */
export function normalizeWorkspacePath(rawPath: string): string {
  if (typeof rawPath !== 'string') {
    throw new CoLiveError('INVALID_PATH', 'Path must be a string');
  }

  let decoded = rawPath;
  // Decode percent-encoding repeatedly until clean or if it contains encoded characters
  if (decoded.includes('%')) {
    try {
      // Decode twice to prevent double-encoding attacks
      decoded = decodeURIComponent(decoded);
      if (decoded.includes('%')) {
        try {
          decoded = decodeURIComponent(decoded);
        } catch {
          // If second decode fails, keep first
        }
      }
    } catch {
      throw new CoLiveError('INVALID_PATH', `Malformed percent-encoded path: ${rawPath}`);
    }
  }

  // Reject null bytes
  if (decoded.includes('\0') || rawPath.includes('\0')) {
    throw new CoLiveError('INVALID_PATH', 'Null bytes are strictly prohibited in paths');
  }

  // Normalize backslashes to forward slashes
  const normalized = decoded.replace(/\\/g, '/');

  // Reject Windows drive letters (e.g. C:, c:/)
  if (/^[a-zA-Z]:/.test(normalized)) {
    throw new CoLiveError('INVALID_PATH', `Drive letters are forbidden: ${rawPath}`);
  }

  // Reject absolute paths
  if (normalized.startsWith('/')) {
    throw new CoLiveError('INVALID_PATH', `Absolute paths are forbidden: ${rawPath}`);
  }

  // Split into segments and validate
  const rawSegments = normalized.split('/');
  const cleanSegments: string[] = [];

  for (const segment of rawSegments) {
    const trimmed = segment.trim();

    if (trimmed === '' || trimmed === '.') {
      continue;
    }

    // A segment that is only dots with length >= 2 (.., ..., etc.) is traversal
    if (/^\.{2,}$/.test(trimmed)) {
      throw new CoLiveError('FORBIDDEN', `Path traversal detected: ${rawPath}`);
    }

    // Check for trailing dots or spaces which can bypass filters on Windows
    const sanitized = trimmed.replace(/[. ]+$/, '');
    if (!sanitized || sanitized === '.') {
      continue;
    }

    // Check if remaining segment contains ..
    if (sanitized === '..' || sanitized.includes('..')) {
      throw new CoLiveError('FORBIDDEN', `Path traversal detected: ${rawPath}`);
    }

    cleanSegments.push(sanitized);
  }

  return cleanSegments.join('/');
}

/**
 * Checks whether a relative path matches any exclude pattern.
 * Uses picomatch with case-insensitivity and dot-file matching enabled.
 */
export function isExcluded(relPath: string, patterns: string[]): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }

  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) {
    return false;
  }

  const isMatch = picomatch(patterns, {
    dot: true,
    nocase: true,
  });

  if (isMatch(normalized)) {
    return true;
  }

  // Check parent paths (e.g. "node_modules/foo/bar.js" when pattern is "node_modules/**" or "node_modules")
  const parts = normalized.split('/');
  let current = '';
  for (let i = 0; i < parts.length; i++) {
    current = current ? `${current}/${parts[i]}` : parts[i]!;
    if (isMatch(current)) {
      return true;
    }
  }

  return false;
}

/**
 * Common image extensions supported for binary previews.
 */
export const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.bmp',
  '.ico',
  '.avif',
]);

/**
 * Returns true if the file path has an image extension.
 */
export function isImageFile(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false;
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1) return false;
  const ext = filePath.slice(lastDot).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}
