import { z } from 'zod';
const identity = { username: z.string().max(120).optional(), platform_user_id: z.string().max(120).optional(), channel_id: z.string().max(120).optional(), author_display_name: z.string().max(120).optional(), platform: z.string().max(40).optional() };
// Контракт ядра #73 (StoredAttachment): вложение сначала загружается в /v1/attachments,
// в чат уходят только метаданные уже сохранённого файла. Лимиты ядра: 4 файла, 8 МБ каждый.
export const ATTACHMENT_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/markdown'] as const;
export const AttachmentSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/, 'Attachment id must be 32 lowercase hex characters'),
  kind: z.enum(['image', 'file']),
  mime: z.enum(ATTACHMENT_MIMES),
  name: z.string().min(1).max(200),
  size: z.number().int().positive().max(8 * 1024 * 1024),
}).strict();
export type StoredAttachment = z.infer<typeof AttachmentSchema>;
// Лейны и лимиты контекста в формате ядра #73: неизвестные поля отсутствуют, а не равны нулю.
export const ContextLaneUsageSchema = z.object({
  used: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
}).strict();
export const ContextUsageSchema = z.object({
  total: ContextLaneUsageSchema.optional(),
  lanes: z.object({
    talk: ContextLaneUsageSchema.optional(),
    brain: ContextLaneUsageSchema.optional(),
    memory: ContextLaneUsageSchema.optional(),
    vision: ContextLaneUsageSchema.optional(),
  }).strict().optional(),
}).strict();
export type ContextUsage = z.infer<typeof ContextUsageSchema>;
// Личность пользователя подписывает BFF из сессии; клиент не может её прислать.
export const ChatRequestSchema = z.object({ text: z.string().min(1).max(6000), chat_id: z.string().uuid().optional(), model: z.string().min(1).optional(), attachments: z.array(AttachmentSchema).max(4).optional() }).strict();
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export const ChatMessageSchema = z.object({ id: z.union([z.string(), z.number()]).optional(), turn_id: z.string().optional(), request_id: z.string().uuid().optional(), role: z.enum(['user', 'assistant', 'system']), content: z.string(), model: z.string().optional(), attachments: z.array(AttachmentSchema).max(4).optional() }).strict();
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
// The kernel's WsChatMessage has no `platform` (REST only) and forbids unknown fields, so the
// WS variant is built from explicit fields. model/attachments are target v2 (§15).
const wsChat = z.object({ type: z.literal('chat'), text: z.string().min(1).max(6000), username: identity.username, platform_user_id: identity.platform_user_id, channel_id: identity.channel_id, author_display_name: identity.author_display_name, display_name: z.string().max(120).optional(), model: z.string().min(1).optional(), attachments: z.array(AttachmentSchema).max(4).optional() }).strict();
export const WsChatMessageSchema = z.discriminatedUnion('type', [wsChat, z.object({ type: z.literal('ping') }).strict(), z.object({ type: z.literal('stop') }).strict()]);
export const WsChatEventSchema = z.discriminatedUnion('type', [
 z.object({ type: z.literal('hello'), trace_id: z.string(), protocol: z.literal('neyra.ws.chat.v1'), role: z.string(), ping_interval_seconds: z.number(), idle_timeout_seconds: z.number(), reconnect: z.literal('open_new_socket') }),
 z.object({ type: z.literal('pong'), ts: z.string(), trace_id: z.string() }),
 z.object({ type: z.literal('token'), text: z.string(), trace_id: z.string() }),
 z.object({ type: z.literal('thinking'), text: z.string().optional(), trace_id: z.string().optional() }),
 z.object({ type: z.literal('done'), text: z.string(), sounds: z.array(z.unknown()).optional(), usage: ContextUsageSchema.optional(), model_trace: z.unknown().optional(), trace_id: z.string() }),
 z.object({ type: z.literal('error'), code: z.string(), message: z.string().optional(), trace_id: z.string(), model_trace: z.unknown().optional() })
]);
export type WsChatEvent = z.infer<typeof WsChatEventSchema>;
export const SseChatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('token'), text: z.string() }).strict(),
  z.object({ type: z.literal('thinking'), text: z.string().optional() }).strict(),
  // Ядро #73 сообщает фазу до первого токена; текст фазы — публичная подпись из ядра.
  z.object({ type: z.literal('phase'), phase: z.string().min(1).max(40), label: z.string().min(1).max(120).optional() }).strict(),
  // usage приходит из ядра на done; без данных поле отсутствует, и индикатор скрыт.
  z.object({ type: z.literal('done'), text: z.string(), usage: ContextUsageSchema.optional() }).strict(),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }).strict(),
]);
export type SseChatEvent = z.infer<typeof SseChatEventSchema>;

export const MemorySearchRequestSchema = z.object({ query: z.string().min(1).max(1200), top_k: z.number().int().min(1).max(20).default(3), user_id: z.string().max(120).optional() }).strict();
export const MemoryRecallRequestSchema = z.object({ limit: z.number().int().min(1).max(200).default(20), offset: z.number().int().min(0).max(100000).default(0), user_id: z.string().max(120).optional(), channel_id: z.string().max(120).optional(), newest_first: z.boolean().default(true) }).strict();
export const MemoryWriteRequestSchema = z.object({ user_text: z.string().min(1).max(6000), assistant_text: z.string().min(1).max(6000), username: z.string().max(120).optional(), platform_user_id: z.string().max(120).optional() }).strict();
export const MemoryAddRequestSchema = z.object({ text: z.string().min(1).max(24000), metadata: z.record(z.string(), z.unknown()).default({}) }).strict();
export type MemorySearchRequest = z.infer<typeof MemorySearchRequestSchema>;
export type MemoryRecallRequest = z.infer<typeof MemoryRecallRequestSchema>;
export const DesktopToolSchema = z.enum(['client.list_apps', 'client.open_url', 'client.open_app', 'client.search_web', 'client.list_windows', 'client.focus_window', 'client.close_window', 'client.media', 'client.volume', 'client.shell_exec', 'client.fs_list', 'client.fs_read', 'client.fs_search', 'client.fs_write', 'client.fs_mkdir', 'client.fs_move', 'client.screenshot', 'client.input', 'client.computer_snapshot', 'client.computer_click', 'client.computer_type', 'client.computer_press']);
export const DesktopManifestSchema = z.object({ protocol: z.literal('neyra.desktop.v1').default('neyra.desktop.v1'), device_id: z.string().uuid(), session_id: z.string().uuid(), name: z.string().min(1).max(90), platform: z.enum(['windows', 'macos', 'linux-wayland', 'linux-x11']), tools: z.array(DesktopToolSchema).max(24).default([]), commands: z.array(z.object({ name: z.string().min(1).max(60), triggers: z.array(z.object({ kind: z.enum(['phrase', 'regex', 'hotkey']), value: z.string().min(1).max(120) }).strict()).max(8).default([]), actions: z.array(z.string()).max(10).default([]) }).strict()).max(32).default([]), features: z.array(z.literal('command_drafts')).max(2).default([]) }).strict();
export type DesktopManifest = z.infer<typeof DesktopManifestSchema>;
export const CaptureEventSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('recording'), seq: z.number().int().nonnegative().optional() }), z.object({ type: z.literal('capture.failed'), code: z.string(), stage: z.enum(['start', 'stop']), seq: z.number().int().nonnegative().optional() }), z.object({ type: z.literal('voice.clip'), request_id: z.string().uuid(), audio: z.string(), duration_ms: z.number().nonnegative(), seq: z.number().int().nonnegative().optional() })]);
export type CaptureEvent = z.infer<typeof CaptureEventSchema>;
