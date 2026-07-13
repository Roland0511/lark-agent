import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";
import type { ApprovalState, AuthorizationGrant, DraftState, TaskState } from "../shared/contracts.js";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json = ColumnType<unknown, string, string>;

export interface ProcessedEventsTable {
  bot_id: string;
  event_id: string;
  event_type: string;
  status: string;
  received_at: Timestamp;
  processed_at: NullableTimestamp;
}

export interface ConversationsTable {
  id: Generated<string>;
  bot_id: string;
  bot_config_revision: number;
  role_instructions_snapshot: string;
  chat_id: string;
  chat_type: string;
  root_message_id: string;
  thread_id: string | null;
  room_seq: Generated<number>;
  active: Generated<boolean>;
  response_message_id: string | null;
  followup_expires_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TasksTable {
  id: Generated<string>;
  bot_id: string;
  conversation_id: string;
  state: TaskState;
  turn_index: Generated<number>;
  trigger_message_id: string;
  conversation_disposition: "complete" | "awaiting_followup" | null;
  disposition_reason: string | null;
  requester_id: string;
  requester_role: "owner" | "member";
  authorization_grant: Json;
  requested_workspace_alias: string | null;
  resolved_workspace_alias: ColumnType<string | null, string | null | undefined, string | null>;
  preferred_executor_id: string | null;
  executor_id: string | null;
  codex_thread_id: string | null;
  executor_home_ref: string | null;
  executor_profile: string | null;
  executor_config_fingerprint: string | null;
  codex_version: string | null;
  lease_token_hash: string | null;
  lease_expires_at: NullableTimestamp;
  attempt: Generated<number>;
  revision: Generated<number>;
  summary: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  completed_at: NullableTimestamp;
}

export interface SignalsTable {
  id: Generated<string>;
  bot_id: string;
  conversation_id: string;
  task_id: string;
  event_id: string;
  seq: number;
  message_id: string;
  sender_id: string;
  sender_role: "owner" | "member";
  message_type: string;
  content: string;
  preview: string;
  priority: Generated<number>;
  decision: Generated<string>;
  decision_rationale: string | null;
  created_at: Timestamp;
  decided_at: NullableTimestamp;
}

export interface WorkersTable {
  executor_id: string;
  display_name: string;
  home_ref: string;
  codex_profile: string;
  config_fingerprint: string;
  codex_version: string;
  capacity: number;
  workspace_aliases: Json;
  capabilities: Json;
  runner_version: string | null;
  architecture: string | null;
  registration_source: Generated<"unregistered" | "quick_install">;
  status: Generated<string>;
  operational_mode: Generated<"enabled" | "maintenance" | "disabled">;
  deleted_at: NullableTimestamp;
  last_seen_at: Timestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface WorkerEnrollmentTokensTable {
  id: Generated<string>;
  token_hash: string;
  expires_at: Timestamp;
  used_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  executor_id: string | null;
  created_at: Timestamp;
}

export interface WorkerDeviceCredentialsTable {
  id: Generated<string>;
  executor_id: string;
  credential_hash: string;
  last_used_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface AdminLoginTokensTable {
  token_hash: string;
  open_id: string;
  role: "owner";
  expires_at: Timestamp;
  consumed_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface AdminSessionsTable {
  token_hash: string;
  open_id: string;
  display_name: string | null;
  role: "owner";
  csrf_token: string;
  last_seen_at: Timestamp;
  expires_at: Timestamp;
  created_at: Timestamp;
}

export interface IncidentsTable {
  id: Generated<string>;
  fingerprint: string;
  kind: string;
  severity: "warning" | "critical";
  title: string;
  summary: string;
  state: "open" | "acknowledged" | "resolved";
  related_type: string | null;
  related_id: string | null;
  occurrence_count: Generated<number>;
  first_seen_at: Timestamp;
  last_seen_at: Timestamp;
  acknowledged_by: string | null;
  acknowledged_at: NullableTimestamp;
  resolved_at: NullableTimestamp;
  notification_message_id: string | null;
  last_notified_at: NullableTimestamp;
  last_notification_error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TaskEventsTable {
  id: Generated<string>;
  task_id: string;
  event_type: string;
  summary: string;
  payload: Json;
  created_at: Timestamp;
}

export interface DraftsTable {
  id: Generated<string>;
  task_id: string;
  conversation_id: string;
  base_room_seq: number;
  observed_room_seq: number;
  content: string;
  state: DraftState;
  hold_count: Generated<number>;
  force_requested: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
  sent_at: NullableTimestamp;
}

export interface ApprovalsTable {
  id: Generated<string>;
  task_id: string;
  request_id: string;
  method: string;
  summary: string;
  payload: Json;
  state: ApprovalState;
  decided_by: string | null;
  decided_at: NullableTimestamp;
  expires_at: Timestamp;
  created_at: Timestamp;
}

export interface OutboxMessagesTable {
  id: Generated<string>;
  task_id: string;
  draft_id: string | null;
  target_message_id: string;
  content: string;
  idempotency_key: string;
  operation_kind: Generated<string>;
  state: Generated<string>;
  platform_message_id: string | null;
  attempt: Generated<number>;
  last_error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  sent_at: NullableTimestamp;
}

export interface TaskOutputsTable {
  task_id: string;
  conversation_id: string;
  transport: Generated<"cardkit" | "markdown_fallback">;
  card_id: string | null;
  message_id: string | null;
  element_id: Generated<string>;
  sequence: Generated<number>;
  state: Generated<"pending" | "streaming" | "held" | "completed" | "failed" | "unknown">;
  visible_phase: "commentary" | "final" | "error" | null;
  current_content: string | null;
  current_content_hash: string | null;
  last_ordinal: Generated<number>;
  last_item_id: string | null;
  last_error: string | null;
  opened_at: NullableTimestamp;
  closed_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TaskOutputUpdatesTable {
  id: Generated<string>;
  task_id: string;
  operation: "create_card" | "send_card" | "update_content" | "close_stream";
  sequence: number | null;
  request_uuid: string;
  content: string | null;
  content_hash: string | null;
  state: Generated<"pending" | "sent" | "unknown" | "failed">;
  attempt: Generated<number>;
  last_error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  sent_at: NullableTimestamp;
}

export interface ActionReceiptsTable {
  id: Generated<string>;
  task_id: string;
  action_key: string;
  action_type: string;
  request_digest: string;
  result: Json;
  created_at: Timestamp;
}

export interface ChatPoliciesTable {
  chat_id: string;
  enabled: Generated<boolean>;
  preferred_executor_id: string | null;
  workspace_alias: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BotsTable {
  id: Generated<string>;
  app_id: string;
  profile_name: string | null;
  bot_open_id: string | null;
  display_name: string;
  role_instructions: string;
  owner_open_id: string | null;
  default_executor_id: string | null;
  default_workspace_alias: string | null;
  enabled: Generated<boolean>;
  is_system: Generated<boolean>;
  config_revision: Generated<number>;
  credential_state: Generated<"pending" | "verified" | "error">;
  credential_error: string | null;
  deleted_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BotChatBindingsTable {
  bot_id: string;
  chat_id: string;
  chat_name: string | null;
  enabled: Generated<boolean>;
  preferred_executor_id: string | null;
  workspace_alias: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface BotOwnerBindingTokensTable {
  token_hash: string;
  bot_id: string;
  expires_at: Timestamp;
  consumed_at: NullableTimestamp;
  created_at: Timestamp;
}

export interface Database {
  bots: BotsTable;
  bot_chat_bindings: BotChatBindingsTable;
  bot_owner_binding_tokens: BotOwnerBindingTokensTable;
  processed_events: ProcessedEventsTable;
  conversations: ConversationsTable;
  tasks: TasksTable;
  signals: SignalsTable;
  workers: WorkersTable;
  worker_enrollment_tokens: WorkerEnrollmentTokensTable;
  worker_device_credentials: WorkerDeviceCredentialsTable;
  task_events: TaskEventsTable;
  drafts: DraftsTable;
  approvals: ApprovalsTable;
  outbox_messages: OutboxMessagesTable;
  task_outputs: TaskOutputsTable;
  task_output_updates: TaskOutputUpdatesTable;
  action_receipts: ActionReceiptsTable;
  chat_policies: ChatPoliciesTable;
  admin_login_tokens: AdminLoginTokensTable;
  admin_sessions: AdminSessionsTable;
  incidents: IncidentsTable;
}

export type Task = Selectable<TasksTable>;
export type NewTask = Insertable<TasksTable>;
export type TaskUpdate = Updateable<TasksTable>;
export type Conversation = Selectable<ConversationsTable>;
export type SignalRow = Selectable<SignalsTable>;
export type WorkerRow = Selectable<WorkersTable>;

export function parseAuthorization(value: unknown): AuthorizationGrant {
  return value as AuthorizationGrant;
}
