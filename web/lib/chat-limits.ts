// Лимиты чата на пользователя: скользящее окно запросов и число одновременных стримов.
// Состояние живёт в памяти процесса сайта: этого достаточно для одного инстанса,
// а при горизонтальном масштабировании счётчики нужно вынести в общее хранилище.
//
// Ключ — user.id из проверенной сессии, а не IP: за прокси все запросы приходят
// с одного адреса, поэтому IP-лимит здесь только мешал бы.

export const CHAT_RATE_WINDOW_MS = 60_000;
export const CHAT_REQUESTS_PER_WINDOW = 20;
export const CHAT_MAX_CONCURRENT_STREAMS = 3;

const requestHits = new Map<string, number[]>();
const activeStreams = new Map<string, number>();

export interface ChatLimitDecision {
  ok: boolean;
  retryAfterSeconds?: number;
}

function prune(map: Map<string, unknown>, limit = 10_000) {
  if (map.size <= limit) return;
  // Map сохраняет порядок вставки: первыми уходят самые старые ключи.
  for (const key of map.keys()) {
    map.delete(key);
    if (map.size <= limit) break;
  }
}

export function checkChatRateLimit(userId: string, now = Date.now()): ChatLimitDecision {
  if (!userId) return { ok: false, retryAfterSeconds: Math.ceil(CHAT_RATE_WINDOW_MS / 1000) };
  const cutoff = now - CHAT_RATE_WINDOW_MS;
  const fresh = (requestHits.get(userId) ?? []).filter((at) => at > cutoff);
  if (fresh.length >= CHAT_REQUESTS_PER_WINDOW) {
    const oldest = fresh[0] ?? now;
    requestHits.set(userId, fresh);
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + CHAT_RATE_WINDOW_MS - now) / 1000)),
    };
  }
  fresh.push(now);
  requestHits.set(userId, fresh);
  prune(requestHits);
  return { ok: true };
}

export function beginChatStream(userId: string): boolean {
  if (!userId) return false;
  const active = activeStreams.get(userId) ?? 0;
  if (active >= CHAT_MAX_CONCURRENT_STREAMS) return false;
  activeStreams.set(userId, active + 1);
  prune(activeStreams);
  return true;
}

export function endChatStream(userId: string): void {
  const active = activeStreams.get(userId) ?? 0;
  if (active <= 1) activeStreams.delete(userId);
  else activeStreams.set(userId, active - 1);
}

export function activeChatStreams(userId: string): number {
  return activeStreams.get(userId) ?? 0;
}

// Только для тестов: сбрасывает счётчики между прогонами.
export function resetChatLimitsForTests(): void {
  requestHits.clear();
  activeStreams.clear();
}
