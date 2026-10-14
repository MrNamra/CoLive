import { z } from 'zod';
import { MAX_CHAT_TEXT_LENGTH, PROTOCOL_VERSION } from './constants.js';
import { RpcErrorCodeSchema } from './errors.js';
import {
  DiagnosticItemSchema,
  ParticipantInfoSchema,
  PermissionSchema,
  RangeSchema,
  RoleSchema,
} from './types.js';

// Base message schema
export const BaseMessageSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.string(),
  id: z.string().optional(),
});

// 1. Handshake & Ping/Pong
export const HelloMessageSchema = BaseMessageSchema.extend({
  type: z.literal('hello'),
  clientVersion: z.string(),
  role: RoleSchema,
  token: z.string().optional(),
  inviteSecret: z.string().optional(),
});
export type HelloMessage = z.infer<typeof HelloMessageSchema>;

export const HelloAckMessageSchema = BaseMessageSchema.extend({
  type: z.literal('helloAck'),
  clientId: z.string(),
  serverVersion: z.string(),
});
export type HelloAckMessage = z.infer<typeof HelloAckMessageSchema>;

export const ErrorMessageSchema = BaseMessageSchema.extend({
  type: z.literal('error'),
  code: RpcErrorCodeSchema,
  message: z.string(),
});
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

export const PingMessageSchema = BaseMessageSchema.extend({
  type: z.literal('ping'),
  timestamp: z.number(),
});
export type PingMessage = z.infer<typeof PingMessageSchema>;

export const PongMessageSchema = BaseMessageSchema.extend({
  type: z.literal('pong'),
  timestamp: z.number(),
  serverTimestamp: z.number(),
});
export type PongMessage = z.infer<typeof PongMessageSchema>;

// 2. Session Lifecycle
export const HostCreateSessionSchema = BaseMessageSchema.extend({
  type: z.literal('host.createSession'),
  displayName: z.string(),
  inviteSecret: z.string().optional(),
});
export type HostCreateSession = z.infer<typeof HostCreateSessionSchema>;

export const ServerSessionCreatedSchema = BaseMessageSchema.extend({
  type: z.literal('server.sessionCreated'),
  sessionId: z.string(),
  hostToken: z.string(),
  inviteSecret: z.string(),
  expiresAt: z.number(),
});
export type ServerSessionCreated = z.infer<typeof ServerSessionCreatedSchema>;

export const GuestJoinSchema = BaseMessageSchema.extend({
  type: z.literal('guest.join'),
  sessionId: z.string(),
  inviteSecret: z.string().optional(),
  guestToken: z.string().optional(),
  displayName: z.string(),
});
export type GuestJoin = z.infer<typeof GuestJoinSchema>;

export const ServerJoinRequestSchema = BaseMessageSchema.extend({
  type: z.literal('server.joinRequest'),
  requestId: z.string(),
  guestTempId: z.string(),
  displayName: z.string(),
});
export type ServerJoinRequest = z.infer<typeof ServerJoinRequestSchema>;

export const HostJoinDecisionSchema = BaseMessageSchema.extend({
  type: z.literal('host.joinDecision'),
  requestId: z.string(),
  accept: z.boolean(),
  permission: PermissionSchema,
  reason: z.string().optional(),
});
export type HostJoinDecision = z.infer<typeof HostJoinDecisionSchema>;

export const ServerJoinAcceptedSchema = BaseMessageSchema.extend({
  type: z.literal('server.joinAccepted'),
  guestId: z.string(),
  guestToken: z.string(),
  permission: PermissionSchema,
  hostInfo: ParticipantInfoSchema,
  participants: z.array(ParticipantInfoSchema),
});
export type ServerJoinAccepted = z.infer<typeof ServerJoinAcceptedSchema>;

export const ServerJoinRejectedSchema = BaseMessageSchema.extend({
  type: z.literal('server.joinRejected'),
  reason: z.string(),
});
export type ServerJoinRejected = z.infer<typeof ServerJoinRejectedSchema>;

export const ServerParticipantJoinedSchema = BaseMessageSchema.extend({
  type: z.literal('server.participantJoined'),
  participant: ParticipantInfoSchema,
});
export type ServerParticipantJoined = z.infer<typeof ServerParticipantJoinedSchema>;

export const ServerParticipantLeftSchema = BaseMessageSchema.extend({
  type: z.literal('server.participantLeft'),
  participantId: z.string(),
  reason: z.string().optional(),
});
export type ServerParticipantLeft = z.infer<typeof ServerParticipantLeftSchema>;

export const ServerParticipantUpdatedSchema = BaseMessageSchema.extend({
  type: z.literal('server.participantUpdated'),
  participant: ParticipantInfoSchema,
});
export type ServerParticipantUpdated = z.infer<typeof ServerParticipantUpdatedSchema>;

export const HostSetPermissionSchema = BaseMessageSchema.extend({
  type: z.literal('host.setPermission'),
  guestId: z.string(),
  permission: PermissionSchema,
});
export type HostSetPermission = z.infer<typeof HostSetPermissionSchema>;

export const HostKickSchema = BaseMessageSchema.extend({
  type: z.literal('host.kick'),
  guestId: z.string(),
  reason: z.string().optional(),
});
export type HostKick = z.infer<typeof HostKickSchema>;

export const HostEndSessionSchema = BaseMessageSchema.extend({
  type: z.literal('host.endSession'),
});
export type HostEndSession = z.infer<typeof HostEndSessionSchema>;

export const ServerSessionEndedSchema = BaseMessageSchema.extend({
  type: z.literal('server.sessionEnded'),
  reason: z.string(),
});
export type ServerSessionEnded = z.infer<typeof ServerSessionEndedSchema>;

// 3. Workspace RPC
export const FsEntrySchema = z.object({
  name: z.string(),
  type: z.enum(['file', 'dir', 'symlink']),
  size: z.number().int().nonnegative(),
  mtime: z.number().int().nonnegative(),
});
export type FsEntry = z.infer<typeof FsEntrySchema>;

export const FsListReqSchema = BaseMessageSchema.extend({
  type: z.literal('fs.list.req'),
  id: z.string(),
  path: z.string(),
});
export type FsListReq = z.infer<typeof FsListReqSchema>;

export const FsListResSchema = BaseMessageSchema.extend({
  type: z.literal('fs.list.res'),
  id: z.string(),
  entries: z.array(FsEntrySchema),
});
export type FsListRes = z.infer<typeof FsListResSchema>;

export const FsStatReqSchema = BaseMessageSchema.extend({
  type: z.literal('fs.stat.req'),
  id: z.string(),
  path: z.string(),
});
export type FsStatReq = z.infer<typeof FsStatReqSchema>;

export const FsStatResSchema = BaseMessageSchema.extend({
  type: z.literal('fs.stat.res'),
  id: z.string(),
  fileType: z.enum(['file', 'dir', 'symlink']),
  size: z.number().int().nonnegative(),
  mtime: z.number().int().nonnegative(),
  ctime: z.number().int().nonnegative(),
});
export type FsStatRes = z.infer<typeof FsStatResSchema>;

export const FsReadReqSchema = BaseMessageSchema.extend({
  type: z.literal('fs.read.req'),
  id: z.string(),
  path: z.string(),
});
export type FsReadReq = z.infer<typeof FsReadReqSchema>;

export const FsReadResSchema = BaseMessageSchema.extend({
  type: z.literal('fs.read.res'),
  id: z.string(),
  contentBase64: z.string(),
  mtime: z.number().int().nonnegative(),
  isBinary: z.boolean(),
});
export type FsReadRes = z.infer<typeof FsReadResSchema>;

export const FsWriteReqSchema = BaseMessageSchema.extend({
  type: z.literal('fs.write.req'),
  id: z.string(),
  path: z.string(),
  contentBase64: z.string(),
});
export type FsWriteReq = z.infer<typeof FsWriteReqSchema>;

export const FsWriteResSchema = BaseMessageSchema.extend({
  type: z.literal('fs.write.res'),
  id: z.string(),
  mtime: z.number().int().nonnegative(),
});
export type FsWriteRes = z.infer<typeof FsWriteResSchema>;

export const FsCreateReqSchema = BaseMessageSchema.extend({
  type: z.literal('fs.create.req'),
  id: z.string(),
  path: z.string(),
  itemType: z.enum(['file', 'dir']),
});
export type FsCreateReq = z.infer<typeof FsCreateReqSchema>;

export const FsCreateResSchema = BaseMessageSchema.extend({
  type: z.literal('fs.create.res'),
  id: z.string(),
});
export type FsCreateRes = z.infer<typeof FsCreateResSchema>;

export const FsDeleteReqSchema = BaseMessageSchema.extend({
  type: z.literal('fs.delete.req'),
  id: z.string(),
  path: z.string(),
  recursive: z.boolean().default(false),
});
export type FsDeleteReq = z.infer<typeof FsDeleteReqSchema>;

export const FsDeleteResSchema = BaseMessageSchema.extend({
  type: z.literal('fs.delete.res'),
  id: z.string(),
});
export type FsDeleteRes = z.infer<typeof FsDeleteResSchema>;

export const FsRenameReqSchema = BaseMessageSchema.extend({
  type: z.literal('fs.rename.req'),
  id: z.string(),
  oldPath: z.string(),
  newPath: z.string(),
  overwrite: z.boolean().default(false),
});
export type FsRenameReq = z.infer<typeof FsRenameReqSchema>;

export const FsRenameResSchema = BaseMessageSchema.extend({
  type: z.literal('fs.rename.res'),
  id: z.string(),
});
export type FsRenameRes = z.infer<typeof FsRenameResSchema>;

export const FsWatchChangeSchema = z.object({
  type: z.enum(['created', 'changed', 'deleted']),
  path: z.string(),
});
export type FsWatchChange = z.infer<typeof FsWatchChangeSchema>;

export const FsWatchEventSchema = BaseMessageSchema.extend({
  type: z.literal('fs.watchEvent'),
  changes: z.array(FsWatchChangeSchema),
});
export type FsWatchEvent = z.infer<typeof FsWatchEventSchema>;

export const WorkspaceInfoReqSchema = BaseMessageSchema.extend({
  type: z.literal('workspace.info.req'),
  id: z.string(),
});
export type WorkspaceInfoReq = z.infer<typeof WorkspaceInfoReqSchema>;

export const WorkspaceInfoResSchema = BaseMessageSchema.extend({
  type: z.literal('workspace.info.res'),
  id: z.string(),
  name: z.string(),
  rootLabel: z.string(),
  excludePatterns: z.array(z.string()),
});
export type WorkspaceInfoRes = z.infer<typeof WorkspaceInfoResSchema>;

// 4. Document Sync Lifecycle
export const DocOpenReqSchema = BaseMessageSchema.extend({
  type: z.literal('doc.open.req'),
  id: z.string(),
  path: z.string(),
});
export type DocOpenReq = z.infer<typeof DocOpenReqSchema>;

export const DocOpenResSchema = BaseMessageSchema.extend({
  type: z.literal('doc.open.res'),
  id: z.string(),
  docId: z.string(),
  initialStateVectorRequired: z.boolean().default(true),
});
export type DocOpenRes = z.infer<typeof DocOpenResSchema>;

export const DocCloseSchema = BaseMessageSchema.extend({
  type: z.literal('doc.close'),
  docId: z.string(),
});
export type DocClose = z.infer<typeof DocCloseSchema>;

export const DocSavedSchema = BaseMessageSchema.extend({
  type: z.literal('doc.saved'),
  docId: z.string(),
  path: z.string(),
});
export type DocSaved = z.infer<typeof DocSavedSchema>;

// 5. Comments
export const CommentOpSchema = BaseMessageSchema.extend({
  type: z.literal('comment.op'),
  op: z.enum(['create', 'reply', 'edit', 'delete', 'resolve', 'unresolve']),
  threadId: z.string(),
  commentId: z.string().optional(),
  path: z.string().optional(),
  range: RangeSchema.optional(),
  anchorStartRelPos: z.string().optional(),
  anchorEndRelPos: z.string().optional(),
  body: z.string().max(4000).optional(),
  resolved: z.boolean().optional(),
});
export type CommentOp = z.infer<typeof CommentOpSchema>;

// 6. Chat
export const ChatMessageSchema = BaseMessageSchema.extend({
  type: z.literal('chat.message'),
  fromId: z.string(),
  fromName: z.string(),
  text: z.string().max(MAX_CHAT_TEXT_LENGTH),
  ts: z.number(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// 7. Diagnostics
export const DiagnosticsUpdateSchema = BaseMessageSchema.extend({
  type: z.literal('diagnostics.update'),
  path: z.string(),
  items: z.array(DiagnosticItemSchema),
});
export type DiagnosticsUpdate = z.infer<typeof DiagnosticsUpdateSchema>;

// 8. Terminal
export const TerminalOpenReqSchema = BaseMessageSchema.extend({
  type: z.literal('terminal.open.req'),
  id: z.string(),
  name: z.string(),
});
export type TerminalOpenReq = z.infer<typeof TerminalOpenReqSchema>;

export const TerminalOpenResSchema = BaseMessageSchema.extend({
  type: z.literal('terminal.open.res'),
  id: z.string(),
  terminalId: z.string(),
});
export type TerminalOpenRes = z.infer<typeof TerminalOpenResSchema>;

export const TerminalDataSchema = BaseMessageSchema.extend({
  type: z.literal('terminal.data'),
  terminalId: z.string(),
  data: z.string(),
});
export type TerminalData = z.infer<typeof TerminalDataSchema>;

export const TerminalInputSchema = BaseMessageSchema.extend({
  type: z.literal('terminal.input'),
  terminalId: z.string(),
  data: z.string(),
});
export type TerminalInput = z.infer<typeof TerminalInputSchema>;

export const TerminalResizeSchema = BaseMessageSchema.extend({
  type: z.literal('terminal.resize'),
  terminalId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type TerminalResize = z.infer<typeof TerminalResizeSchema>;

export const TerminalCloseSchema = BaseMessageSchema.extend({
  type: z.literal('terminal.close'),
  terminalId: z.string(),
});
export type TerminalClose = z.infer<typeof TerminalCloseSchema>;

// Union schema of all messages
export const ColiveMessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  HelloAckMessageSchema,
  ErrorMessageSchema,
  PingMessageSchema,
  PongMessageSchema,
  HostCreateSessionSchema,
  ServerSessionCreatedSchema,
  GuestJoinSchema,
  ServerJoinRequestSchema,
  HostJoinDecisionSchema,
  ServerJoinAcceptedSchema,
  ServerJoinRejectedSchema,
  ServerParticipantJoinedSchema,
  ServerParticipantLeftSchema,
  ServerParticipantUpdatedSchema,
  HostSetPermissionSchema,
  HostKickSchema,
  HostEndSessionSchema,
  ServerSessionEndedSchema,
  FsListReqSchema,
  FsListResSchema,
  FsStatReqSchema,
  FsStatResSchema,
  FsReadReqSchema,
  FsReadResSchema,
  FsWriteReqSchema,
  FsWriteResSchema,
  FsCreateReqSchema,
  FsCreateResSchema,
  FsDeleteReqSchema,
  FsDeleteResSchema,
  FsRenameReqSchema,
  FsRenameResSchema,
  FsWatchEventSchema,
  WorkspaceInfoReqSchema,
  WorkspaceInfoResSchema,
  DocOpenReqSchema,
  DocOpenResSchema,
  DocCloseSchema,
  DocSavedSchema,
  CommentOpSchema,
  ChatMessageSchema,
  DiagnosticsUpdateSchema,
  TerminalOpenReqSchema,
  TerminalOpenResSchema,
  TerminalDataSchema,
  TerminalInputSchema,
  TerminalResizeSchema,
  TerminalCloseSchema,
]);

export type ColiveMessage = z.infer<typeof ColiveMessageSchema>;

/**
 * Validates and parses raw JSON string into a ColiveMessage.
 */
export function parseColiveMessage(raw: string): ColiveMessage {
  const json = JSON.parse(raw);
  return ColiveMessageSchema.parse(json);
}

/**
 * Safely parses raw JSON string into a ColiveMessage without throwing.
 */
export function safeParseColiveMessage(raw: string): { success: true; data: ColiveMessage } | { success: false; error: z.ZodError } {
  try {
    const json = JSON.parse(raw);
    const result = ColiveMessageSchema.safeParse(json);
    return result;
  } catch (err) {
    const customError = new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: [],
        message: err instanceof Error ? err.message : 'Invalid JSON',
      },
    ]);
    return { success: false, error: customError };
  }
}
