export interface Profile { id: string; name: string; url: string; session_id: string }
export interface Permissions { enabled: boolean; apps: string[]; allow_web: boolean; web_domains: string[]; system: boolean; shell: boolean; files: boolean; fs_roots: string[]; screen: boolean; screen_auto: boolean; input: boolean }
export interface VoiceSettings { mode: 'ptt' | 'wake' | 'always'; vad_sensitivity: number; end_silence_ms: number; wake_threshold: number; barge_in: 'off' | 'headphones' }
export interface Settings { schema_version: number; device_id: string; device_name: string; profiles: Profile[]; permissions: Permissions; theme: string; graphics_mode: string; audit_days: number; character_enabled?: boolean; voice?: VoiceSettings }
export interface Recovery { file: string; reason: string; quarantined: string | null; restored: string }
export interface Device { device_id: string; name: string; tools: string[] }
export interface Entry { role: 'user' | 'assistant'; content: string }
export interface HostCall { call_id: string; tool: string; arguments: Record<string, unknown>; deadline_ms: number; preview?: string }
export const toolTitles: Record<string, string> = {
  'client.shell_exec': 'Выполнить команду',
  'client.fs_write': 'Записать файл',
  'client.fs_mkdir': 'Создать папку',
  'client.fs_move': 'Переместить',
  'client.screenshot': 'Сделать снимок экрана',
  'client.input': 'Управлять мышью и клавиатурой',
  'client.open_url': 'Открыть ссылку',
  'client.open_app': 'Запустить программу',
  'client.close_window': 'Закрыть окно',
};
export function absolutePath(value: string): boolean { return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value); }
export interface AuditRow { time: number; tool: string; status: string; confirmed: boolean }
export interface Plugin { id: string; name?: string; enabled: boolean; lifecycle?: string }
export interface WakeStatus { ready: boolean; dir: string; message?: string; model?: string; license?: string }
export interface VoiceStatus { wake: WakeStatus; live: boolean; dropped_frames: number }
export interface ServerEvent { type: string; available?: boolean; source?: string; text?: string; code?: string; messages?: Entry[]; devices?: Device[]; model_trace?: unknown; state?: string; status?: string; db?: number; mode?: string; reason?: string }
export type LiveState = 'off' | 'idle' | 'armed' | 'listening' | 'thinking' | 'speaking';
export const tabs = ['Чат', 'Голос', 'Команды', 'Статус', 'Модули', 'Доступ к ПК', 'Настройки', 'Сервер'] as const;
export const defaultVoice: VoiceSettings = { mode: 'ptt', vad_sensitivity: 0.5, end_silence_ms: 700, wake_threshold: 0.5, barge_in: 'off' };
export function newProfile(): Profile { return { id: crypto.randomUUID(), name: 'Новый сервер', url: 'http://127.0.0.1:8787', session_id: crypto.randomUUID() }; }
export function formatError(error: unknown): string { return typeof error === 'string' ? error : 'Действие не выполнено. Повторите попытку.'; }
export function validServerUrl(value: string): boolean { try { const u = new URL(value); return (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; } }
/** Mic level in dBFS to a 0..1 meter value: -60 dB is silence, -10 dB is loud. */
export function meterLevel(db: number): number { return Math.min(1, Math.max(0, (db + 60) / 50)); }
const liveLabels: Record<LiveState, string> = { off: 'Микрофон выключен', idle: 'Слушаю', armed: 'Слушаю команду', listening: 'Слышу вас', thinking: 'Думаю', speaking: 'Говорю' };
export function liveLabel(state: LiveState, mode: VoiceSettings['mode']): string { return state === 'idle' && mode === 'wake' ? 'Жду слово «Нейра»' : liveLabels[state]; }
export function conversionNotice(status?: string, code?: string): string {
  if (status === 'passthrough') return `Голос не преобразован (${code ?? 'ошибка'}): звучит исходный голос TTS.`;
  if (status === 'stopped') return `Преобразование голоса не удалось (${code ?? 'ошибка'}): озвучка остановлена, текст ответа в чате.`;
  return '';
}
