export interface Profile { id: string; name: string; url: string; session_id: string }
export interface Permissions { enabled: boolean; apps: string[]; allow_web: boolean; web_domains: string[]; system: boolean; shell: boolean; files: boolean; fs_roots: string[]; screen: boolean; screen_auto: boolean; input: boolean }
export interface VoiceSettings { mode: 'ptt' | 'wake' | 'always'; vad_sensitivity: number; end_silence_ms: number; wake_threshold: number; barge_in: 'off' | 'headphones'; input_device?: string; output_device?: string }
export interface Settings { schema_version: number; device_id: string; device_name: string; profiles: Profile[]; permissions: Permissions; theme: string; graphics_mode: string; audit_days: number; character_enabled?: boolean; voice?: VoiceSettings; active_profile?: string }
export interface Recovery { file: string; reason: string; quarantined: string | null; restored: string }
export interface Device { device_id: string; name: string; tools: string[] }
export interface Entry { id?: string | number; turn_id?: string; request_id?: string; role: 'user' | 'assistant'; content: string }
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
export interface LogTailData { source: string; path: string; exists: boolean; text: string }
export interface LogSource { id: string; label: string; maintOnly?: boolean }
export interface WakeStatus { ready: boolean; dir: string; message?: string; model?: string; license?: string }

export interface VoiceStatus { wake: WakeStatus; live: boolean; dropped_frames: number }
export interface AudioDevices {
  input_devices: string[];
  output_devices: string[];
  default_input: string | null;
  default_output: string | null;
}
export const emptyAudioDevices: AudioDevices = {
  input_devices: [],
  output_devices: [],
  default_input: null,
  default_output: null,
};
// Native global-shortcut capture failure (ordinary player/server errors stay `error`).
export interface CaptureFailedEvent { type: 'capture.failed'; code: string; stage: 'start' | 'stop' }
export interface ServerEvent { type: string; request_id?: string; scope?: string; stage?: CaptureFailedEvent['stage']; available?: boolean; source?: string; text?: string; code?: string; messages?: Entry[]; devices?: Device[]; model_trace?: unknown; state?: string; status?: string; db?: number; mode?: string; reason?: string; audio?: string; duration_ms?: number; run?: number }
/** Server routes wrap the payload as `{ok, trace_id, data}`. Rust returns that JSON unchanged. */
export function unwrapApi<T>(body: unknown): T {
  if (body !== null && typeof body === 'object' && 'data' in body) {
    const record = body as { ok?: unknown; trace_id?: unknown; data: T };
    if (typeof record.ok === 'boolean' || typeof record.trace_id === 'string') return record.data;
  }
  return body as T;
}
/** A newer live run replaces events still in flight from the worker that just stopped. */
export function acceptLiveRun(current: number, event: { type: string; run?: number }): { current: number; accept: boolean } {
  if (typeof event.run !== 'number') return { current, accept: true };
  if (event.type === 'live.started') return { current: event.run, accept: true };
  return { current, accept: event.run === current };
}
export type LiveState = 'off' | 'idle' | 'armed' | 'listening' | 'thinking' | 'speaking';
export const defaultVoice: VoiceSettings = { mode: 'ptt', vad_sensitivity: 0.5, end_silence_ms: 700, wake_threshold: 0.5, barge_in: 'off', input_device: '', output_device: '' };
export function newProfile(): Profile { return { id: crypto.randomUUID(), name: 'Новый сервер', url: 'http://127.0.0.1:8787', session_id: crypto.randomUUID() }; }
export function formatError(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const record = error as { status?: unknown; code?: unknown; message?: unknown };
    let status = typeof record.status === 'number' ? record.status : undefined;
    const code = typeof record.code === 'string' ? record.code : undefined;
    const message = typeof record.message === 'string' ? record.message : undefined;
    if (status === undefined && code) {
      const match = /^http_(\d+)$/.exec(code);
      if (match) status = Number(match[1]);
    }
    if (status !== undefined) {
      if (status === 400) {
        if (code === 'bad_request' && message === 'unknown log source') return 'Неизвестный источник логов (HTTP 400).';
        return 'Неверный запрос (HTTP 400).';
      }
      if (status === 401) {
        return 'Ошибка авторизации (HTTP 401): неверный токен или сессия отозвана.';
      }
      if (status === 403) {
        return 'Доступ запрещён (HTTP 403): просмотр логов chat/audit требует прав maint+.';
      }
      if (status === 404) {
        return 'Источник логов не найден (HTTP 404).';
      }
      return `Сервер вернул HTTP ${status}.`;
    }
  }
  if (error === 'credential_store_unavailable') return 'Системное хранилище секретов недоступно. Запустите и разблокируйте Secret Service/keyring. Токен не сохранён в файл.';
  if (error === 'token_missing') return 'Сначала сохраните токен.';
  if (typeof error === 'string' && error.startsWith('export_contains_token:')) {
    const source = error.slice('export_contains_token:'.length);
    const location = source === 'settings' ? 'настройках или разрешениях' : /^command:\d+$/.test(source) ? `команде №${source.slice('command:'.length)}` : 'экспортируемых данных';
    return `Экспорт отменён: сохранённый токен найден в ${location}. Удалите токен из команды или настроек и повторите экспорт.`;
  }
  if (error === 'invalid_token') return 'Неверный токен.';
  if (typeof error === 'string') {
    const httpCodeMatch = /^http_(\d+)$/.exec(error);
    const httpStatus = httpCodeMatch ? Number(httpCodeMatch[1]) : undefined;
    if (error === 'Сервер вернул HTTP 400' || error === 'HTTP 400' || httpStatus === 400) {
      return 'Неверный запрос (HTTP 400).';
    }
    if (error === 'Сервер вернул HTTP 401' || error === 'HTTP 401' || httpStatus === 401) {
      return 'Ошибка авторизации (HTTP 401): неверный токен или сессия отозвана.';
    }
    if (error === 'Сервер вернул HTTP 403' || error === 'HTTP 403' || httpStatus === 403) {
      return 'Доступ запрещён (HTTP 403): просмотр логов chat/audit требует прав maint+.';
    }
    if (error === 'Сервер вернул HTTP 404' || error === 'HTTP 404' || httpStatus === 404) {
      return 'Источник логов не найден (HTTP 404).';
    }
    if (httpStatus !== undefined) {
      return `Сервер вернул HTTP ${httpStatus}.`;
    }
    return error;
  }
  return 'Действие не выполнено. Повторите попытку.';
}

export function validServerUrl(value: string): boolean { try { const u = new URL(value); return (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; } }
/** Mic level in dBFS to a 0..1 meter value: -60 dB is silence, -10 dB is loud. */
export function meterLevel(db: number): number { return Math.min(1, Math.max(0, (db + 60) / 50)); }
const liveLabels: Record<LiveState, string> = { off: 'Микрофон выключен', idle: 'Слушаю', armed: 'Слушаю команду', listening: 'Слышу вас', thinking: 'Думаю', speaking: 'Говорю' };
export function liveLabel(state: LiveState, mode: VoiceSettings['mode']): string { return state === 'idle' && mode === 'wake' ? 'Жду слово «Нейра»' : liveLabels[state]; }
/** Returns whether a finished live_start still belongs to the open conversation. A false result already stopped the mic. */
export async function settleLiveStart(epochAtStart: number, epochNow: number, stop: () => Promise<void>): Promise<boolean> {
  if (epochAtStart === epochNow) return true;
  try { await stop(); } catch { /* End already stopped the mic. */ }
  return false;
}
export function conversionNotice(status?: string, code?: string): string {
  if (status === 'passthrough') return `Голос не преобразован (${code ?? 'ошибка'}): звучит исходный голос TTS.`;
  if (status === 'stopped') return `Преобразование голоса не удалось (${code ?? 'ошибка'}): озвучка остановлена, текст ответа в чате.`;
  return '';
}

const overlaySupport: Record<string, string> = { yes: 'да', not_guaranteed: 'не гарантировано', no: 'нет' };
export const capabilityLabel = (value: string): string => overlaySupport[value] ?? 'неизвестно';
