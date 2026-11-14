// Провайдеры LLM, зрения и речи для админки: транспорт к ядру и типы.
// Ключи никогда не возвращаются: сайт видит лишь «задан / не задан» и источник.

import { coreDelete, coreGet, corePost, corePut, type CoreResult } from './core-admin';

export type ProviderType = 'llm' | 'vision' | 'stt' | 'tts';

export interface ProviderProbe {
  state: 'open' | 'auth_required' | 'unreachable';
  models: number | null;
  message: string;
  checked_ago_seconds: number;
}

export interface ProviderFieldOption {
  value: string;
  label: string;
}

export interface ProviderField {
  key: string;
  label: string;
  kind: 'text' | 'select' | 'number' | 'url';
  required: boolean;
  placeholder: string;
  help: string;
  default: string | number;
  options: ProviderFieldOption[];
  max_length: number;
  min?: number;
  max?: number;
}

export type ProviderFieldValue = string | number | boolean;

export interface ProviderRow {
  name: string;
  label: string;
  base_url: string;
  kind: string;
  builtin: boolean;
  preset: string;
  provider_type: ProviderType;
  provider_type_label: string;
  fields: Record<string, ProviderFieldValue>;
  needs_key: boolean;
  has_key: boolean;
  key_source: 'vault' | 'yaml' | 'env' | 'none';
  lanes: string[];
  probe?: ProviderProbe | null;
}

export interface ProviderPreset {
  id: string;
  label: string;
  type: ProviderType;
  type_label: string;
  base_url: string;
  kind: string;
  needs_key: boolean;
  hint: string;
  docs_url: string;
  fields: ProviderField[];
}

export interface ProvidersPayload {
  providers: ProviderRow[];
  presets: ProviderPreset[];
  lanes: string[];
}

export interface ProviderWriteResult {
  provider: ProviderRow;
  persisted?: string[];
  backups?: string[];
  llm_rebound?: boolean;
}

export interface ProviderWriteBody {
  base_url: string;
  kind?: string;
  preset?: string;
  provider_type?: ProviderType;
  fields?: Record<string, ProviderFieldValue>;
}

export const PROVIDER_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const PROVIDER_TYPES: ProviderType[] = ['llm', 'vision', 'stt', 'tts'];

export function isValidProviderName(name: string): boolean {
  return PROVIDER_NAME_RE.test(name.trim().toLowerCase());
}

export function isValidBaseUrl(value: string): boolean {
  const raw = value.trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.host);
  } catch {
    return false;
  }
}

export function isProviderType(value: unknown): value is ProviderType {
  return typeof value === 'string' && (PROVIDER_TYPES as string[]).includes(value);
}

export function readProviders(): Promise<CoreResult<ProvidersPayload>> {
  return coreGet<ProvidersPayload>('/v1/providers', { timeoutMs: 8000 });
}

export function writeProvider(
  name: string,
  body: ProviderWriteBody,
): Promise<CoreResult<ProviderWriteResult>> {
  return corePut<ProviderWriteResult>(`/v1/providers/${encodeURIComponent(name)}`, body, { timeoutMs: 20000 });
}

export function deleteProvider(name: string): Promise<CoreResult<{ deleted: string; key_removed: boolean }>> {
  return coreDelete<{ deleted: string; key_removed: boolean }>(`/v1/providers/${encodeURIComponent(name)}`, {
    timeoutMs: 20000,
  });
}

export function writeProviderSecret(name: string, apiKey: string): Promise<CoreResult<ProviderWriteResult>> {
  return corePut<ProviderWriteResult>(
    `/v1/providers/${encodeURIComponent(name)}/secret`,
    { api_key: apiKey },
    { timeoutMs: 20000 },
  );
}

export function migrateProviderSecret(name: string): Promise<CoreResult<ProviderWriteResult>> {
  return corePost<ProviderWriteResult>(
    `/v1/providers/${encodeURIComponent(name)}/migrate-secret`,
    {},
    { timeoutMs: 20000 },
  );
}

export function deleteProviderSecret(name: string): Promise<CoreResult<{ provider: ProviderRow; removed: boolean }>> {
  return coreDelete<{ provider: ProviderRow; removed: boolean }>(
    `/v1/providers/${encodeURIComponent(name)}/secret`,
    { timeoutMs: 20000 },
  );
}
