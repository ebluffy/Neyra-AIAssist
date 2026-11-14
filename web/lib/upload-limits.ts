// Лимиты загрузки вложений на пользователя. Как и chat-limits, состояние живёт
// в памяти процесса сайта: один инстанс достаточен, при масштабировании — общий store.
//
// Квота — скользящее окно 24 часа: старые записи истекают (TTL), поэтому квота
// освобождается сама. Файлы в ядре живут по политике ядра; BFF ограничивает
// только новые загрузки и не даёт одному аккаунту забить диск за минуты.

export const UPLOAD_RATE_WINDOW_MS = 60_000;
export const UPLOAD_REQUESTS_PER_WINDOW = 10;
export const UPLOAD_MAX_CONCURRENT = 2;
export const UPLOAD_QUOTA_BYTES = 64 * 1024 * 1024;
export const UPLOAD_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

const requestHits = new Map<string, number[]>();
const activeByUser = new Map<string, number>();
interface UsageEntry { id?: string; at: number; bytes: number }

const usage = new Map<string, UsageEntry[]>();
let sequence = 0;

export interface UploadLimitDecision {
  ok: boolean;
  retryAfterSeconds?: number;
}

export interface UploadQuotaDecision extends UploadLimitDecision {
  usedBytes?: number;
  remainingBytes?: number;
}

export interface UploadReservation {
  id: string;
  bytes: number;
  at: number;
}

export interface UploadReservationDecision extends UploadQuotaDecision {
  reservation?: UploadReservation;
}

function prune(map: Map<string, unknown>, limit = 10_000) {
  if (map.size <= limit) return;
  for (const key of map.keys()) {
    map.delete(key);
    if (map.size <= limit) break;
  }
}

export function checkUploadRateLimit(userId: string, now = Date.now()): UploadLimitDecision {
  if (!userId) return { ok: false, retryAfterSeconds: Math.ceil(UPLOAD_RATE_WINDOW_MS / 1000) };
  const cutoff = now - UPLOAD_RATE_WINDOW_MS;
  const fresh = (requestHits.get(userId) ?? []).filter((at) => at > cutoff);
  if (fresh.length >= UPLOAD_REQUESTS_PER_WINDOW) {
    const oldest = fresh[0] ?? now;
    requestHits.set(userId, fresh);
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + UPLOAD_RATE_WINDOW_MS - now) / 1000)),
    };
  }
  fresh.push(now);
  requestHits.set(userId, fresh);
  prune(requestHits);
  return { ok: true };
}

export function beginUpload(userId: string): boolean {
  if (!userId) return false;
  const active = activeByUser.get(userId) ?? 0;
  if (active >= UPLOAD_MAX_CONCURRENT) return false;
  activeByUser.set(userId, active + 1);
  prune(activeByUser);
  return true;
}

export function endUpload(userId: string): void {
  const active = activeByUser.get(userId) ?? 0;
  if (active <= 1) activeByUser.delete(userId);
  else activeByUser.set(userId, active - 1);
}

export function activeUploads(userId: string): number {
  return activeByUser.get(userId) ?? 0;
}

function freshUsage(userId: string, now: number): UsageEntry[] {
  const cutoff = now - UPLOAD_QUOTA_WINDOW_MS;
  const entries = (usage.get(userId) ?? []).filter((entry) => entry.at > cutoff);
  if (entries.length) usage.set(userId, entries);
  else usage.delete(userId);
  return entries;
}

export function checkUploadQuota(userId: string, bytes: number, now = Date.now()): UploadQuotaDecision {
  if (!userId) return { ok: false, retryAfterSeconds: Math.ceil(UPLOAD_QUOTA_WINDOW_MS / 1000) };
  const entries = freshUsage(userId, now);
  const used = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const remaining = Math.max(0, UPLOAD_QUOTA_BYTES - used);
  if (bytes > remaining) {
    const oldest = entries[0]?.at ?? now;
    return {
      ok: false,
      usedBytes: used,
      remainingBytes: remaining,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + UPLOAD_QUOTA_WINDOW_MS - now) / 1000)),
    };
  }
  return { ok: true, usedBytes: used, remainingBytes: remaining };
}

// Атомарный резерв квоты: проверка и запись идут в одном синхронном тике.
// Параллельные запросы не могут оба увидеть свободное место и вместе превысить квоту.
export function reserveUpload(userId: string, bytes: number, now = Date.now()): UploadReservationDecision {
  if (!userId || !Number.isFinite(bytes) || bytes <= 0) {
    return { ok: false, retryAfterSeconds: Math.ceil(UPLOAD_QUOTA_WINDOW_MS / 1000) };
  }
  const decision = checkUploadQuota(userId, bytes, now);
  if (!decision.ok) return decision;
  const reservation: UploadReservation = { id: `reserve-${++sequence}`, bytes, at: now };
  const entries = freshUsage(userId, now);
  entries.push(reservation);
  usage.set(userId, entries);
  prune(usage);
  return { ...decision, reservation };
}

// Возврат резерва при ошибке ядра: место снова доступно другим загрузкам.
export function releaseUpload(userId: string, reservation: string | UploadReservation): boolean {
  if (!userId) return false;
  const id = typeof reservation === 'string' ? reservation : reservation.id;
  const entries = usage.get(userId);
  if (!entries) return false;
  const next = entries.filter((entry) => entry.id !== id);
  if (next.length === entries.length) return false;
  if (next.length) usage.set(userId, next);
  else usage.delete(userId);
  return true;
}

export function recordUpload(userId: string, bytes: number, now = Date.now()): void {
  if (!userId || bytes <= 0) return;
  const entries = freshUsage(userId, now);
  entries.push({ id: `manual-${++sequence}`, at: now, bytes });
  usage.set(userId, entries);
  prune(usage);
}

export function uploadQuotaUsed(userId: string, now = Date.now()): number {
  return freshUsage(userId, now).reduce((sum, entry) => sum + entry.bytes, 0);
}

export function resetUploadLimitsForTests(): void {
  requestHits.clear();
  activeByUser.clear();
  usage.clear();
  sequence = 0;
}
