export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  kind: 'text' | 'voice';
  serverId?: string;
  turnId?: string;
  requestId?: string;
  audioUrl?: string;
  durationMs?: number;
  pending?: boolean;
}

export interface ChatThread {
  id: string;
  title: string;
  sessionId: string;
  updated: number;
  messages: ChatMessage[];
}

export function nextId(): string {
  return crypto.randomUUID();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(value: string | undefined): value is string {
  return !!value && UUID_RE.test(value);
}
/** A chat row needs a real session id. An empty one makes storage reject the whole file. */
export function sessionOrNew(profileSession: string | undefined, stored: { sessionId: string }[]): string {
  if (isUuid(profileSession)) return profileSession;
  return stored.find(item => isUuid(item.sessionId))?.sessionId ?? crypto.randomUUID();
}

export function ensureSessionId(value: string | undefined): string {
  return isUuid(value) ? value : crypto.randomUUID();
}

/** A profile with a broken session id must take the id the chat already uses. `null` means leave it. */
export function profileSessionRepair(profileSession: string | undefined, chosen: string): string | null {
  if (profileSession === undefined || isUuid(profileSession)) return null;
  return chosen;
}

/** A new server joins the open thread. Without one it keeps the id it was created with. */
export function firstServerSession(hasProfiles: boolean, createdSession: string, activeSession: string | undefined): string {
  if (isUuid(activeSession)) return activeSession;
  return hasProfiles ? createdSession : ensureSessionId(activeSession);
}

export function selectedProfile<T extends { id: string }>(profiles: T[], rememberedId: string | undefined): T | undefined {
  if (rememberedId) {
    const found = profiles.find(item => item.id === rememberedId);
    if (found) return found;
  }
  return profiles[0];
}

export function bindProfileSession<T extends { id: string; session_id: string }>(profiles: T[], profileId: string, threadSession: string): T[] {
  if (!isUuid(threadSession)) return profiles;
  return profiles.map(item => item.id === profileId && item.session_id !== threadSession ? { ...item, session_id: threadSession } : item);
}

export function composerSlot(text: string): 'send' | 'live' {
  return text.trim() ? 'send' : 'live';
}

export function threadTitle(messages: { role: string; content: string }[]): string {
  const first = messages.find(message => message.role === 'user' && message.content.trim());
  if (!first) return 'Новый чат';
  const clean = first.content.trim().replace(/\s+/g, ' ');
  return clean.length > 42 ? `${clean.slice(0, 42)}…` : clean;
}

export function historyGroups(threads: ChatThread[], now = Date.now()): { label: string; threads: ChatThread[] }[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const groups = [
    { label: 'Сегодня', threads: [] as ChatThread[] },
    { label: 'Вчера', threads: [] as ChatThread[] },
    { label: 'Ранее', threads: [] as ChatThread[] },
  ];
  for (const thread of [...threads].sort((a, b) => b.updated - a.updated)) {
    const index = thread.updated >= today.getTime() ? 0 : thread.updated >= yesterday.getTime() ? 1 : 2;
    groups[index].threads.push(thread);
  }
  return groups.filter(group => group.threads.length > 0);
}

export function daypart(hour: number): string {
  if (hour < 5 || hour >= 23) return 'Доброй ночи';
  if (hour < 12) return 'Доброе утро';
  if (hour < 18) return 'Добрый день';
  return 'Добрый вечер';
}

export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function stripAudio(message: ChatMessage): ChatMessage {
  const copy = { ...message };
  delete copy.audioUrl;
  return copy;
}

export function wavBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'audio/wav' });
}

export function switchThread(threads: ChatThread[], activeId: string, messages: ChatMessage[], nextId: string): { threads: ChatThread[]; activeId: string; messages: ChatMessage[] } | null {
  if (nextId === activeId) return null;
  const saved = threads.map(thread => thread.id === activeId ? { ...thread, messages: messages.map(stripAudio), title: threadTitle(messages), updated: Date.now() } : thread);
  const target = saved.find(thread => thread.id === nextId);
  if (!target) return null;
  return { threads: saved, activeId: nextId, messages: target.messages.map(message => ({ ...message })) };
}

export function storedThreads(threads: ChatThread[]) {
  return threads.slice(0, 30).map(thread => ({
    id: thread.id,
    title: thread.title.slice(0, 80),
    sessionId: thread.sessionId,
    updated: thread.updated,
    messages: thread.messages.slice(-100).map(message => ({
      id: message.id,
      role: message.role,
      content: message.content.slice(0, 8000),
      kind: message.kind,
      ...(message.serverId ? { serverId: message.serverId } : {}),
      ...(message.turnId ? { turnId: message.turnId } : {}),
      ...(message.requestId ? { requestId: message.requestId } : {}),
      ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
    })),
  }));
}

// Reconcile persisted identity only. Equal text is never evidence of equal rows.
// Older servers provide no identity: preserve local rows until a metadata-capable
// history arrives rather than guessing which repeated turn they represent.
export function mergeHistory(incoming: ChatMessage[], local: ChatMessage[]): ChatMessage[] {
  if (!incoming.some(row => row.serverId)) return local;
  const merged = [...local];
  for (const row of incoming) {
    const index = merged.findIndex(item =>
      (row.serverId && item.serverId === row.serverId) ||
      (row.requestId && item.requestId === row.requestId && item.role === row.role) ||
      (row.turnId && item.turnId === row.turnId && item.role === row.role));
    if (index < 0) merged.push(row);
    else merged[index] = { ...row, ...merged[index], serverId: row.serverId, turnId: row.turnId, requestId: row.requestId ?? merged[index].requestId };
  }
  // SQLite row IDs preserve insertion order; unresolved optimistic rows follow
  // persisted history, in their original local order. Keep local UI IDs for IPC rollback.
  return merged.sort((a, b) => {
    if (!a.serverId) return b.serverId ? 1 : 0;
    if (!b.serverId) return -1;
    const left = BigInt(a.serverId), right = BigInt(b.serverId);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
