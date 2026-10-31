export interface Profile { id: string; name: string; url: string; session_id: string }
export interface Permissions {
  enabled: boolean; apps: string[]; allow_web: boolean; web_domains: string[]; system: boolean;
  shell?: boolean; files?: boolean; fs_roots?: string[];
  screen?: boolean; screen_auto?: boolean; input?: boolean;
}
export interface Settings { schema_version: number; device_id: string; device_name: string; profiles: Profile[]; permissions: Permissions; theme: string; graphics_mode: string; audit_days: number; character_enabled?: boolean }
export interface Recovery { file: string; reason: string; quarantined: string | null; restored: string }
export interface Device { device_id: string; name: string; tools: string[] }
export interface Entry { role: 'user' | 'assistant'; content: string }
export interface HostCall { call_id: string; tool: string; arguments: Record<string, unknown>; deadline_ms: number }
export interface AuditRow { time: number; tool: string; status: string; confirmed: boolean }
export interface Plugin { id: string; name?: string; enabled: boolean; lifecycle?: string }
export interface ServerEvent { type: string; available?: boolean; source?: string; text?: string; code?: string; messages?: Entry[]; devices?: Device[]; model_trace?: unknown }
export const tabs = ['Чат', 'Команды', 'Статус', 'Модули', 'Доступ к ПК', 'Настройки', 'Сервер'] as const;
export function newProfile(): Profile { return { id: crypto.randomUUID(), name: 'Новый сервер', url: 'http://127.0.0.1:8787', session_id: crypto.randomUUID() }; }
export function formatError(error: unknown): string { return typeof error === 'string' ? error : 'Действие не выполнено. Повторите попытку.'; }
export function validServerUrl(value: string): boolean { try { const u = new URL(value); return (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; } }
