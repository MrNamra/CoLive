import { CommentOp, CommentThreadData, Permission, Role } from '@colive/protocol';

export interface ParticipantContext {
  id: string;
  role: Role;
  displayName: string;
  permission: Permission;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates a comment operation received from a participant against authorization,
 * permission settings, length constraints, and state transitions.
 */
export function validateCommentOp(
  op: CommentOp,
  sender: ParticipantContext,
  allowReadOnlyComments: boolean,
  existingThread?: CommentThreadData,
): ValidationResult {
  // Permission checks
  if (sender.permission === 'readOnly' && !allowReadOnlyComments && sender.role !== 'host') {
    return { valid: false, error: 'Read-only participants are not permitted to comment' };
  }

  // Size limit check
  if (op.body && op.body.length > 4000) {
    return { valid: false, error: 'Comment body exceeds maximum allowed size (4000 characters)' };
  }

  switch (op.op) {
    case 'create': {
      if (!op.path || op.path.trim().length === 0) {
        return { valid: false, error: 'Thread path is required' };
      }
      if (!op.range) {
        return { valid: false, error: 'Thread anchor range is required' };
      }
      if (!op.body || op.body.trim().length === 0) {
        return { valid: false, error: 'Comment body cannot be empty' };
      }
      return { valid: true };
    }

    case 'reply': {
      if (!existingThread) {
        return { valid: false, error: 'Thread not found' };
      }
      if (!op.body || op.body.trim().length === 0) {
        return { valid: false, error: 'Reply body cannot be empty' };
      }
      return { valid: true };
    }

    case 'edit': {
      if (!existingThread) {
        return { valid: false, error: 'Thread not found' };
      }
      if (!op.commentId) {
        return { valid: false, error: 'commentId is required for edit' };
      }
      if (!op.body || op.body.trim().length === 0) {
        return { valid: false, error: 'Edited body cannot be empty' };
      }
      const comment = existingThread.comments.find((c) => c.id === op.commentId);
      if (!comment) {
        return { valid: false, error: 'Target comment not found' };
      }
      // Only comment author or host can edit
      if (comment.authorId !== sender.id && sender.role !== 'host') {
        return { valid: false, error: 'You can only edit your own comments' };
      }
      return { valid: true };
    }

    case 'delete': {
      if (!existingThread) {
        return { valid: false, error: 'Thread not found' };
      }
      if (!op.commentId) {
        return { valid: false, error: 'commentId is required for delete' };
      }
      const comment = existingThread.comments.find((c) => c.id === op.commentId);
      if (!comment) {
        return { valid: false, error: 'Target comment not found' };
      }
      // Author or host can delete
      if (comment.authorId !== sender.id && sender.role !== 'host') {
        return { valid: false, error: 'You can only delete your own comments' };
      }
      return { valid: true };
    }

    case 'resolve':
    case 'unresolve': {
      if (!existingThread) {
        return { valid: false, error: 'Thread not found' };
      }
      return { valid: true };
    }

    default:
      return { valid: false, error: `Unknown comment operation: ${(op as any).op}` };
  }
}

/**
 * Parses @mentions in comment body and matches against active participant names.
 */
export function parseMentions(body: string, participantNames: string[]): string[] {
  const matches = body.match(/@([a-zA-Z0-9_\-.]+)/g);
  if (!matches) return [];

  const mentions = new Set<string>();
  const normalizedNames = new Map(participantNames.map((name) => [name.toLowerCase(), name]));

  for (const match of matches) {
    const rawName = match.slice(1).toLowerCase();
    const realName = normalizedNames.get(rawName);
    if (realName) {
      mentions.add(realName);
    }
  }

  return Array.from(mentions);
}

/**
 * Generates an SVG Data URI avatar with the user's initials over their participant color.
 */
export function generateInitialsAvatarSvg(name: string, color: string): string {
  const parts = name.trim().split(/\s+/);
  let initials = parts[0]?.charAt(0).toUpperCase() || 'U';
  if (parts.length > 1 && parts[1]?.charAt(0)) {
    initials += parts[1].charAt(0).toUpperCase();
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <circle cx="16" cy="16" r="15" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>
  <text x="16" y="21" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="13" font-weight="bold" fill="#ffffff" text-anchor="middle">${initials}</text>
</svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * Sanitizes Markdown body for VS Code Comments: strips command: URIs and dangerous script tags.
 */
export function sanitizeCommentMarkdown(raw: string): string {
  return raw
    .replace(/\[([^\]]+)\]\(command:[^)]+\)/gi, '$1')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .trim();
}
