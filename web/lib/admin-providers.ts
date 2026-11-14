// Провайдеры LLM для админки: только транспорт к ядру и типы.
// Ключи никогда не возвращаются: сайт видит лишь «задан / не задан» и источник.

import { coreDelete, coreGet, corePut, type CoreResult } from './core-admin';

export interface ProviderRow {
  name: string;
  label: string;
  base_url: string;
  kind: string;
  builtin: boolean;
  has_key: boolean;
  key_source: 'vault' | 'yaml' | 'env' | 'none';
  lanes: string[];
}

export interface ProviderPreset {
  id: string;
  label: string;
  base_url: string;
  kind: string;
  needs_key: boolean;
  hint: string;
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

export const PROVIDER_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

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

export function readProviders(): Promise<CoreResult<ProvidersPayload>> {
  return coreGet<ProvidersPayload>('/v1/providers', { timeoutMs: 8000 });
}

export function writeProvider(
  name: string,
  body: { base_url: string; kind?: string },
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

export function deleteProviderSecret(name: string): Promise<CoreResult<{ provider: ProviderRow; removed: boolean }>> {
  return coreDelete<{ provider: ProviderRow; removed: boolean }>(
    `/v1/providers/${encodeURIComponent(name)}/secret`,
    { timeoutMs: 20000 },
  );
}
