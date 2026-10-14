import { z } from 'zod';
import { MAX_COMMENT_BODY_LENGTH } from './constants.js';

export const RoleSchema = z.enum(['host', 'guest']);
export type Role = z.infer<typeof RoleSchema>;

export const PermissionSchema = z.enum(['readOnly', 'readWrite']);
export type Permission = z.infer<typeof PermissionSchema>;

export const PositionSchema = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});
export type Position = z.infer<typeof PositionSchema>;

export const RangeSchema = z.object({
  startLine: z.number().int().nonnegative(),
  startChar: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  endChar: z.number().int().nonnegative(),
});
export type Range = z.infer<typeof RangeSchema>;

export const SelectionRangeSchema = z.object({
  anchor: PositionSchema,
  active: PositionSchema,
});
export type SelectionRange = z.infer<typeof SelectionRangeSchema>;

export const ViewportSchema = z.object({
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
});
export type Viewport = z.infer<typeof ViewportSchema>;

export const ParticipantStatusSchema = z.enum(['active', 'idle', 'reconnecting']);
export type ParticipantStatus = z.infer<typeof ParticipantStatusSchema>;

export const ParticipantInfoSchema = z.object({
  id: z.string(),
  role: RoleSchema,
  displayName: z.string(),
  color: z.string(),
  permission: PermissionSchema,
  activeFile: z.string().optional(),
  status: ParticipantStatusSchema.default('active'),
});
export type ParticipantInfo = z.infer<typeof ParticipantInfoSchema>;

export const AwarenessUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
});
export type AwarenessUser = z.infer<typeof AwarenessUserSchema>;

export const AwarenessStateSchema = z.object({
  user: AwarenessUserSchema,
  activeFile: z.string().optional(),
  cursor: PositionSchema.optional(),
  cursorRelPos: z.string().optional(), // base64 encoded Y.RelativePosition
  selections: z.array(SelectionRangeSchema).optional(),
  viewport: ViewportSchema.optional(),
  lastActive: z.number().optional(),
  typingUntil: z.number().optional(),
});
export type AwarenessState = z.infer<typeof AwarenessStateSchema>;

export const CommentDataSchema = z.object({
  id: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  body: z.string().max(MAX_COMMENT_BODY_LENGTH),
  createdAt: z.number(),
  editedAt: z.number().optional(),
});
export type CommentData = z.infer<typeof CommentDataSchema>;

export const CommentThreadDataSchema = z.object({
  id: z.string(),
  path: z.string(),
  range: RangeSchema,
  anchorStartRelPos: z.string().optional(),
  anchorEndRelPos: z.string().optional(),
  authorId: z.string(),
  createdAt: z.number(),
  resolved: z.boolean(),
  comments: z.array(CommentDataSchema),
});
export type CommentThreadData = z.infer<typeof CommentThreadDataSchema>;

export const DiagnosticItemSchema = z.object({
  range: RangeSchema,
  severity: z.number().int().min(0).max(3), // 0: Error, 1: Warning, 2: Info, 3: Hint
  message: z.string(),
  source: z.string().optional(),
  code: z.union([z.string(), z.number()]).optional(),
});
export type DiagnosticItem = z.infer<typeof DiagnosticItemSchema>;
