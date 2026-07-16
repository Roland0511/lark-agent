import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";
import type { ApprovalState, AuthorizationGrant, DraftState, TaskState } from "../shared/contracts.js";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json = ColumnType<unknown, string, string>;
type GeneratedJson = ColumnType<unknown, string | undefined, string>;

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
  chat_context_id: ColumnType<string, string | undefined, string>;
  bot_config_revision: number;
  role_instructions_snapshot: string;
  attention_model_snapshot: string | null;
  attention_reasoning_effort_snapshot: string | null;
  execution_model_snapshot: string | null;
  execution_reasoning_effort_snapshot: string | null;
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

export interface ChatContextsTable {
  id: Generated<string>;
  bot_id: string;
  chat_id: string;
  chat_type: "p2p" | "group";
  peer_open_id: Generated<string | null>;
  peer_display_name: Generated<string | null>;
  peer_identity_checked_at: NullableTimestamp;
  codex_thread_id: string | null;
  executor_id: string | null;
  executor_home_ref: string | null;
  executor_profile: string | null;
  executor_config_fingerprint: string | null;
  executor_workspace_mapping_fingerprint: Generated<string | null>;
  codex_version: string | null;
  workspace_root_alias: string | null;
  state: Generated<"uninitialized" | "ready" | "blocked">;
  blocked_reason: string | null;
  last_activity_at: Timestamp;
  last_compacted_at: NullableTimestamp;
  auto_compaction_count: Generated<number>;
  desired_skill_set_fingerprint: string | null;
  applied_skill_set_fingerprint: string | null;
  skills_synced_at: NullableTimestamp;
  skills_sync_error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ChatContextCompactionsTable {
  id: Generated<string>;
  chat_context_id: string;
  task_id: string;
  codex_thread_id: string;
  codex_turn_id: string;
  codex_item_id: string | null;
  notification_type: string;
  occurred_at: Timestamp;
  created_at: Timestamp;
}

export interface ChatContextRecoveryAttemptsTable {
  id: Generated<string>;
  chat_context_id: string;
  actor_open_id: string;
  state_before: "uninitialized" | "ready" | "blocked";
  state_after: "uninitialized" | "ready" | "blocked";
  result: "recovered" | "already_ready" | "check_failed" | "uninitialized";
  failed_check_keys: Json;
  checked_at: Timestamp;
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
  executor_workspace_mapping_fingerprint: Generated<string | null>;
  codex_version: string | null;
  lease_token_hash: string | null;
  lease_expires_at: NullableTimestamp;
  attempt: Generated<number>;
  revision: Generated<number>;
  summary: string | null;
  skill_set_snapshot: GeneratedJson;
  skill_set_fingerprint: string | null;
  runtime_config_snapshot: GeneratedJson;
  runtime_config_fingerprint: string | null;
  user_skills_snapshot: GeneratedJson;
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
  sender_type: Generated<"user" | "bot">;
  sender_bot_id: string | null;
  sender_display_name: string | null;
  ingress_source: Generated<"lark" | "internal" | "history">;
  origin_message_id: string;
  bot_dialogue_depth: Generated<number>;
  message_type: string;
  content: string;
  preview: string;
  attachments: GeneratedJson;
  priority: Generated<number>;
  decision: Generated<string>;
  decision_rationale: string | null;
  created_at: Timestamp;
  decided_at: NullableTimestamp;
}

export interface BotDialogueSettingsTable {
  id: Generated<number>;
  max_consecutive_depth: Generated<number>;
  updated_at: Timestamp;
}

export interface BotDialogueGuardsTable {
  chat_id: string;
  origin_message_id: string;
  source_task_id: string;
  reached_depth: number;
  notification_outbox_id: string | null;
  created_at: Timestamp;
}

export interface WorkersTable {
  executor_id: string;
  display_name: string;
  display_alias: Generated<string | null>;
  home_ref: string;
  codex_profile: string;
  config_fingerprint: string;
  workspace_mapping_fingerprint: Generated<string | null>;
  codex_version: string;
  capacity: number;
  workspace_aliases: Json;
  capabilities: Json;
  model_catalog: ColumnType<unknown, string | undefined, string>;
  model_catalog_updated_at: NullableTimestamp;
  runner_version: string | null;
  architecture: string | null;
  registration_source: Generated<"unregistered" | "quick_install">;
  status: Generated<string>;
  operational_mode: Generated<"enabled" | "maintenance" | "disabled">;
  deleted_at: NullableTimestamp;
  user_skills: GeneratedJson;
  user_skills_fingerprint: string | null;
  user_skills_scan_status: Generated<"unknown" | "ready" | "stale" | "error">;
  user_skills_truncated: Generated<boolean>;
  user_skills_scanned_at: NullableTimestamp;
  user_skills_scan_error: string | null;
  upgrade_drain_token_hash: Generated<string | null>;
  upgrade_drain_previous_mode: Generated<"enabled" | "maintenance" | "disabled" | null>;
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
  attention_model: string | null;
  attention_reasoning_effort: string | null;
  execution_model: string | null;
  execution_reasoning_effort: string | null;
  owner_open_id: string | null;
  default_executor_id: string | null;
  default_workspace_alias: string | null;
  enabled: Generated<boolean>;
  is_system: Generated<boolean>;
  config_revision: Generated<number>;
  credential_state: Generated<"pending" | "verified" | "error">;
  credential_error: string | null;
  permission_state: Generated<"unchecked" | "valid" | "missing" | "error">;
  permission_check: Json | null;
  permission_checked_at: NullableTimestamp;
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

export interface SkillhubPackagesTable {
  id: Generated<string>;
  registry_url: string;
  namespace: string;
  slug: string;
  version: string;
  registry_fingerprint: string;
  archive_sha256: string;
  archive_path: string;
  archive_size: number;
  skill_name: string;
  description: string;
  dependencies: GeneratedJson;
  created_at: Timestamp;
}

export interface BotSkillBindingsTable {
  id: Generated<string>;
  bot_id: string;
  chat_context_id: string | null;
  package_id: string;
  namespace: string;
  slug: string;
  created_by: string;
  deleted_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SkillRuntimeEnvironmentRevisionsTable {
  id: string;
  binding_id: string;
  chat_context_id: string | null;
  name: string;
  desired_state: "present" | "absent";
  key_id: string | null;
  nonce: string | null;
  ciphertext: string | null;
  auth_tag: string | null;
  value_size: number;
  revision: number;
  superseded_at: NullableTimestamp;
  created_by: string;
  created_at: Timestamp;
}

export interface SkillRuntimeFileRevisionsTable {
  id: string;
  binding_id: string;
  chat_context_id: string | null;
  target_path: string;
  target_path_key: string;
  desired_state: "present" | "absent";
  key_id: string | null;
  nonce: string | null;
  ciphertext: string | null;
  auth_tag: string | null;
  content_sha256: string | null;
  content_size: number;
  revision: number;
  superseded_at: NullableTimestamp;
  created_by: string;
  created_at: Timestamp;
}

export interface SkillRuntimeFileStatesTable {
  chat_context_id: string;
  binding_id: string;
  target_path: string;
  desired_file_revision_id: string;
  desired_revision: number;
  applied_revision: number | null;
  actual_sha256: string | null;
  status: "pending" | "pending_force" | "applied" | "pending_delete" | "deleted" | "drift" | "conflict" | "error";
  last_error: string | null;
  checked_at: NullableTimestamp;
  updated_at: Timestamp;
}

export interface SkillAdminAuditEventsTable {
  id: Generated<string>;
  actor_open_id: string;
  action: string;
  bot_id: string;
  binding_id: string | null;
  chat_context_id: string | null;
  target_name: string | null;
  revision: number | null;
  result: string;
  created_at: Timestamp;
}

export interface SkillFileSyncJobsTable {
  id: Generated<string>;
  chat_context_id: string;
  executor_id: string;
  desired_fingerprint: string;
  leased_fingerprint: string | null;
  payload: Json;
  leased_payload: Json | null;
  state: Generated<"queued" | "running" | "completed" | "failed">;
  lease_token_hash: string | null;
  lease_expires_at: NullableTimestamp;
  attempt: Generated<number>;
  last_error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  completed_at: NullableTimestamp;
}

export interface Database {
  bots: BotsTable;
  bot_chat_bindings: BotChatBindingsTable;
  bot_owner_binding_tokens: BotOwnerBindingTokensTable;
  skillhub_packages: SkillhubPackagesTable;
  bot_skill_bindings: BotSkillBindingsTable;
  skill_runtime_environment_revisions: SkillRuntimeEnvironmentRevisionsTable;
  skill_runtime_file_revisions: SkillRuntimeFileRevisionsTable;
  skill_runtime_file_states: SkillRuntimeFileStatesTable;
  skill_admin_audit_events: SkillAdminAuditEventsTable;
  skill_file_sync_jobs: SkillFileSyncJobsTable;
  chat_contexts: ChatContextsTable;
  chat_context_compactions: ChatContextCompactionsTable;
  chat_context_recovery_attempts: ChatContextRecoveryAttemptsTable;
  processed_events: ProcessedEventsTable;
  conversations: ConversationsTable;
  tasks: TasksTable;
  signals: SignalsTable;
  bot_dialogue_settings: BotDialogueSettingsTable;
  bot_dialogue_guards: BotDialogueGuardsTable;
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
export type ChatContext = Selectable<ChatContextsTable>;
export type SignalRow = Selectable<SignalsTable>;
export type WorkerRow = Selectable<WorkersTable>;

export function parseAuthorization(value: unknown): AuthorizationGrant {
  return value as AuthorizationGrant;
}
