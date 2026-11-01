import { z } from 'zod';

export const idSchema = z.string().uuid();
export const entityKindSchema = z.enum(['task', 'list', 'step', 'day_plan']);
export const mutationKindSchema = z.enum(['create', 'patch', 'delete', 'restore']);
export const platformSchema = z.enum(['windows', 'macos', 'linux', 'android', 'ios', 'web']);

export const mutationSchema = z.object({
  op_id: idSchema,
  client_seq: z.number().int().positive(),
  entity: entityKindSchema,
  entity_id: idSchema,
  kind: mutationKindSchema,
  patch: z.record(z.unknown()),
});

export const syncRequestSchema = z.object({
  device_id: idSchema,
  cursor: z.string(),
  ops: z.array(mutationSchema).max(100),
  limit: z.number().int().min(1).max(500).optional(),
});

export const ackSchema = z.object({
  op_id: idSchema,
  server_seq: z.number().int().nullable().optional(),
  status: z.enum(['applied', 'rejected', 'already_processed']),
  error_code: z.string().nullable().optional(),
});

export const changeSchema = z.object({
  server_seq: z.number().int().positive(),
  op_id: idSchema,
  entity: entityKindSchema,
  entity_id: idSchema,
  kind: mutationKindSchema,
  patch: z.record(z.unknown()),
});

export const syncResponseSchema = z.object({
  ack: z.array(ackSchema),
  changes: z.array(changeSchema),
  next_cursor: z.string(),
  has_more: z.boolean(),
  server_time: z.string().datetime(),
});

export const bootstrapEntitySchema = z.object({
  entity: entityKindSchema,
  entity_id: idSchema,
  data: z.record(z.unknown()),
});

export const bootstrapPageSchema = z.object({
  entities: z.array(bootstrapEntitySchema),
  snapshot_cursor: z.string(),
  next_page: z.string().nullable(),
  has_more: z.boolean(),
});

export const apiErrorSchema = z.object({
  code: z.enum([
    'CURSOR_EXPIRED',
    'SEQUENCE_MISMATCH',
    'ENTITY_NOT_FOUND',
    'VALIDATION_FAILED',
    'FORBIDDEN',
    'UNAUTHORIZED',
    'RATE_LIMITED',
    'PUSH_DISABLED',
    'REVISION_CONFLICT',
    'SHARED_LIST_NOT_FOUND',
    'SHARED_TASK_NOT_FOUND',
    'SHARED_MEMBER_NOT_FOUND',
    'SHARED_LIST_FORBIDDEN',
    'SHARED_LIST_ACCESS_REVOKED',
    'SHARED_MEMBER_EXISTS',
    'SHARED_TASK_EXISTS',
    'SHARED_INVITATION_NOT_FOUND',
    'SHARED_INVITATION_NOT_PENDING',
    'REVISION_REQUIRED',
    'OP_ID_CONFLICT',
    'MEMBER_NOT_FOUND',
    'INTERNAL',
  ]),
  message: z.string(),
});

// Shared lists are a separate collaboration surface from personal `/sync`.
// Timestamps are kept as strings: the API emits RFC 3339 UTC values.
export const sharedRoleSchema = z.enum(['owner', 'editor', 'viewer']);
export const sharedInviteRoleSchema = z.enum(['editor', 'viewer']);
export const sharedTaskStatusSchema = z.enum(['open', 'completed']);
export const sharedInvitationStatusSchema = z.enum(['pending', 'accepted', 'declined', 'revoked']);

export const sharedListSummarySchema = z.object({
  id: idSchema,
  owner_id: idSchema,
  name: z.string(),
  color: z.string().nullable(),
  icon: z.string().nullable(),
  rank: z.string(),
  revision: z.number().int().positive(),
  role: sharedRoleSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

export const sharedTaskSchema = z.object({
  id: idSchema,
  list_id: idSchema,
  title: z.string(),
  note: z.string(),
  status: sharedTaskStatusSchema,
  important: z.boolean(),
  due_on: z.string().nullable(),
  rank: z.string(),
  revision: z.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const sharedStepSchema = z.object({
  id: idSchema,
  task_id: idSchema,
  title: z.string(),
  is_completed: z.boolean(),
  rank: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const sharedMemberSchema = z.object({
  user_id: idSchema,
  email: z.string(),
  role: sharedRoleSchema,
  created_at: z.string(),
});

export const sharedInvitationSchema = z.object({
  id: idSchema,
  list_id: idSchema,
  list_name: z.string(),
  email: z.string(),
  role: sharedInviteRoleSchema,
  status: sharedInvitationStatusSchema,
  invited_by: idSchema,
  invited_by_email: z.string(),
  revision: z.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const sharedSnapshotSchema = z.object({
  list: sharedListSummarySchema,
  members: z.array(sharedMemberSchema),
  invitations: z.array(sharedInvitationSchema).default([]),
  tasks: z.array(sharedTaskSchema),
  steps: z.array(sharedStepSchema).default([]),
  revision: z.number().int().positive(),
});

export const tokenPairSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().int(),
  refresh_token: z.string().optional(),
});

export type EntityKind = z.infer<typeof entityKindSchema>;
export type MutationKind = z.infer<typeof mutationKindSchema>;
export type Mutation = z.infer<typeof mutationSchema>;
export type SyncRequest = z.infer<typeof syncRequestSchema>;
export type Ack = z.infer<typeof ackSchema>;
export type Change = z.infer<typeof changeSchema>;
export type SyncResponse = z.infer<typeof syncResponseSchema>;
export type BootstrapEntity = z.infer<typeof bootstrapEntitySchema>;
export type BootstrapPage = z.infer<typeof bootstrapPageSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type TokenPair = z.infer<typeof tokenPairSchema>;
export type Platform = z.infer<typeof platformSchema>;
export type SharedRole = z.infer<typeof sharedRoleSchema>;
export type SharedInviteRole = z.infer<typeof sharedInviteRoleSchema>;
export type SharedListSummary = z.infer<typeof sharedListSummarySchema>;
export type SharedTask = z.infer<typeof sharedTaskSchema>;
export type SharedStep = z.infer<typeof sharedStepSchema>;
export type SharedMember = z.infer<typeof sharedMemberSchema>;
export type SharedInvitation = z.infer<typeof sharedInvitationSchema>;
export type SharedSnapshot = z.infer<typeof sharedSnapshotSchema>;

export const DEFAULT_PAGE_LIMIT = 500;
export const MAX_SYNC_OPS = 100;
