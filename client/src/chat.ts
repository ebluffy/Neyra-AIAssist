export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  kind: 'text' | 'voice';
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

export function composerSlot(text: string): 'send' | 'live' {
  return text.trim() ? 'send' : 'live';
}

export function threadTitle(messages: { role: string; content: string }[]): string {
  const first = messages.find(message => message.role === 'user' && message.content.trim());
  if (!first) return 'Новый чат';
  const clean = first.content.trim().replace(/\s+/g, ' ');
  return clean.length > 42 ? `${clean.slice(0, 42)}…` : clean;
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
      ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
    })),
  }));
}
