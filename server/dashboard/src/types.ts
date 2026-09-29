export type ApiEnvelope<T> = {
  ok: boolean
  trace_id: string
  data: T
}

export type HealthData = Record<string, unknown>

export type MemoryHubStats = {
  sqlite_path?: string
  schema_version?: number
  rag_write_mode?: string
  allows_raw_dialog_embed?: boolean
  chat_log?: number
  people?: number
  person_facts?: number
  diary_notes?: number
  journal_entries?: number
  working_memory_snapshots?: number
  semantic_outbox?: number
  chroma_records?: number
  rag_enabled?: boolean
}

export type MemoryStats = {
  short_memory_size: number
  long_memory_records: number
  people_records: number
  hub?: MemoryHubStats
}

export type MemoryPolicies = {
  rag_enabled: boolean
  rag_write_mode?: string
  sqlite_path?: string
  stm_max_messages?: number
  chat_log_retention_days?: number
  max_records_target?: number
  ltm_archive_dir?: string
  ltm_summarize_max_tokens?: number
  embedding_model?: string
  chroma_db_path?: string
  ltm_auto_prune?: Record<string, unknown>
  ltm_auto_summarize?: Record<string, unknown>
  ltm_cluster_merge?: Record<string, unknown>
  working_memory?: Record<string, unknown>
  emotional_layer?: Record<string, unknown>
}

export type PluginRow = {
  id: string
  name: string
  description: string
  version: string
  enabled: boolean
  lifecycle: string
  cli_modes: string[]
  main_script: string
  plugin_dir: string
}

export type BalanceData = {
  provider: string
  hint?: string
  limit?: number | null
  limit_remaining?: number | null
  usage?: number
  usage_daily?: number
  usage_weekly?: number
  usage_monthly?: number
  label?: string
}

export type WebhookRoute = {
  route_id: string
  event_type: string
  target_url: string
  enabled: boolean
  max_retries: number
  created_at: string
  updated_at: string
  secret_masked?: string
}

export type WebhookDelivery = {
  delivery_id: string
  route_id: string
  event_type: string
  status: string
  attempts: number
  status_code?: number
  error?: string
  created_at: string
  updated_at: string
}
