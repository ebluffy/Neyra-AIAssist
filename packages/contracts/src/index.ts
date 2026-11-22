import { z } from 'zod';

// Два контракта вместо одного:
// - browser → BFF: только пользовательские данные, .strict(), никакой личности;
// - BFF → ядро: личность и путь к вложению заполняет сервер, браузер их не присылает.

const kernelIdentity = {
  username: z.string().max(120).optional(),
  platform_user_id: z.string().max(120).optional(),
  channel_id: z.string().max(120).optional(),
  author_display_name: z.string().max(120).optional(),
  platform: z.string().max(40).optional(),
};
// WS-кадр ядра не принимает platform (extra=forbid в WsChatMessage): он есть только в REST.
const kernelWsIdentity = {
  username: kernelIdentity.username,
  platform_user_id: kernelIdentity.platform_user_id,
  channel_id: kernelIdentity.channel_id,
  author_display_name: kernelIdentity.author_display_name,
};

// Вложение, которое браузер получил от BFF после загрузки. Никаких path/url.
export const AttachmentSchema = z.object({ upload_id: z.string().min(1).max(120) }).strict();
export const BrowserAttachmentSchema = AttachmentSchema;
export type BrowserAttachment = z.infer<typeof AttachmentSchema>;

// Метаданные уже сохранённого вложения (#73): BFF отдаёт их после загрузки,
// браузер возвращает их в чат. path/url сюда не входят, ядро проверяет owner/id.
export const ATTACHMENT_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/markdown'] as const;
export const StoredAttachmentSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/, 'Attachment id must be 32 lowercase hex characters'),
  kind: z.enum(['image', 'file']),
  mime: z.enum(ATTACHMENT_MIMES),
  name: z.string().min(1).max(200),
  size: z.number().int().positive().max(8 * 1024 * 1024),
}).strict();
export type StoredAttachment = z.infer<typeof StoredAttachmentSchema>;

// Лейны и лимиты контекста в формате ядра #73.
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

export const TurnLaneStatsSchema = z.object({
  calls: z.number().int().nonnegative().max(1000),
  duration_ms: z.number().nonnegative().max(86_400_000),
  model: z.string().min(1).max(200).optional(),
  input_tokens: z.number().int().nonnegative().max(100_000_000).optional(),
  output_tokens: z.number().int().nonnegative().max(100_000_000).optional(),
}).strict();

export const TurnStatsSchema = z.object({
  duration_ms: z.number().nonnegative().max(86_400_000),
  llm_ms: z.number().nonnegative().max(86_400_000),
  output_tokens: z.number().int().nonnegative().max(1_000_000_000).optional(),
  tokens_per_second: z.number().nonnegative().max(1_000_000).optional(),
  lanes: z.object({
    talk: TurnLaneStatsSchema.optional(),
    brain: TurnLaneStatsSchema.optional(),
    memory: TurnLaneStatsSchema.optional(),
    vision: TurnLaneStatsSchema.optional(),
  }).strict(),
}).strict();
export type TurnLaneStats = z.infer<typeof TurnLaneStatsSchema>;
export type TurnStats = z.infer<typeof TurnStatsSchema>;

// SSE-кадры BFF → браузер: без model_trace, usage только из ядра.
export const SseChatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('token'), text: z.string() }).strict(),
  z.object({ type: z.literal('thinking'), text: z.string().optional() }).strict(),
  z.object({ type: z.literal('phase'), phase: z.string().min(1).max(40), label: z.string().min(1).max(120).optional() }).strict(),
  z.object({ type: z.literal('done'), text: z.string(), usage: ContextUsageSchema.optional(), turn_stats: TurnStatsSchema.optional() }).strict(),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }).strict(),
]);
export type SseChatEvent = z.infer<typeof SseChatEventSchema>;

// Вложение в кадре BFF → ядро. Только относительный путь внутри uploads/:
// URL с чужим хостом превратил бы схему в SSRF-канал, поэтому url здесь нет,
// а ведущий слэш запрещён — путь не должен выглядеть абсолютным.
const uploadPath = z.string().min(1).max(500)
  .regex(/^uploads\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, 'path must be relative to uploads/')
  .refine((value) => value.split('/').every((part) => part && part !== '.' && part !== '..'), 'path traversal is forbidden');

export const KernelAttachmentSchema = z.object({
  kind: z.enum(['image', 'file', 'audio', 'text']),
  path: uploadPath.optional(),
  mime: z.string().min(1),
  text: z.string().optional(),
}).strict().refine((value) => Boolean(value.path || value.text), 'Attachment requires a source');
export type KernelAttachment = z.infer<typeof KernelAttachmentSchema>;

// Браузер → BFF. chat_id не является личностью: BFF всё равно привязывает его к user.id.
export const ChatRequestSchema = z.object({
  text: z.string().min(1).max(6000),
  chat_id: z.string().uuid().optional(),
  model: z.string().min(1).optional(),
  attachments: z.array(z.union([AttachmentSchema, StoredAttachmentSchema])).max(4).optional(),
}).strict();
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

// BFF → ядро: identity заполняет только BFF из проверенной сессии.
export const KernelChatRequestSchema = z.object({
  text: z.string().min(1).max(6000),
  ...kernelIdentity,
  model: z.string().min(1).optional(),
  attachments: z.array(KernelAttachmentSchema).max(4).optional(),
}).strict();
export type KernelChatRequest = z.infer<typeof KernelChatRequestSchema>;

export const ChatMessageSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  turn_id: z.string().optional(),
  request_id: z.string().uuid().optional(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  model: z.string().optional(),
  attachments: z.array(z.union([AttachmentSchema, StoredAttachmentSchema])).max(4).optional(),
}).strict();
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const KernelChatMessageSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  turn_id: z.string().optional(),
  request_id: z.string().uuid().optional(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  model: z.string().optional(),
  attachments: z.array(KernelAttachmentSchema).max(4).optional(),
}).strict();
export type KernelChatMessage = z.infer<typeof KernelChatMessageSchema>;

// Браузерный WS-кадр: ядро получает личность только после сборки кадра на BFF.
const browserWsChat = z.object({
  type: z.literal('chat'),
  text: z.string().min(1).max(6000),
  model: z.string().min(1).optional(),
  attachments: z.array(AttachmentSchema).max(4).optional(),
}).strict();
export const WsChatMessageSchema = z.discriminatedUnion('type', [
  browserWsChat,
  z.object({ type: z.literal('ping') }).strict(),
  z.object({ type: z.literal('stop') }).strict(),
]);

// BFF → ядро: та же форма, что WsChatMessage ядра, с подписанной личностью.
const kernelWsChat = z.object({
  type: z.literal('chat'),
  text: z.string().min(1).max(6000),
  ...kernelWsIdentity,
  display_name: z.string().max(120).optional(),
  model: z.string().min(1).optional(),
  attachments: z.array(KernelAttachmentSchema).max(4).optional(),
}).strict();
export const KernelWsChatMessageSchema = z.discriminatedUnion('type', [
  kernelWsChat,
  z.object({ type: z.literal('ping') }).strict(),
  z.object({ type: z.literal('stop') }).strict(),
]);
export type KernelWsChatMessage = z.infer<typeof KernelWsChatMessageSchema>;

export const MemorySearchRequestSchema = z.object({
  query: z.string().min(1).max(1200),
  top_k: z.number().int().min(1).max(20).default(3),
}).strict();
export const KernelMemorySearchRequestSchema = z.object({
  query: z.string().min(1).max(1200),
  top_k: z.number().int().min(1).max(20).default(3),
  user_id: z.string().max(120).optional(),
}).strict();
export const MemoryRecallRequestSchema = z.object({
  limit: z.number().int().min(1).max(200).default(20),
  offset: z.number().int().min(0).max(100000).default(0),
  newest_first: z.boolean().default(true),
}).strict();
export const KernelMemoryRecallRequestSchema = z.object({
  limit: z.number().int().min(1).max(200).default(20),
  offset: z.number().int().min(0).max(100000).default(0),
  user_id: z.string().max(120).optional(),
  channel_id: z.string().max(120).optional(),
  newest_first: z.boolean().default(true),
}).strict();
export const MemoryWriteRequestSchema = z.object({
  user_text: z.string().min(1).max(6000),
  assistant_text: z.string().min(1).max(6000),
}).strict();
export const KernelMemoryWriteRequestSchema = z.object({
  user_text: z.string().min(1).max(6000),
  assistant_text: z.string().min(1).max(6000),
  username: z.string().max(120).optional(),
  platform_user_id: z.string().max(120).optional(),
}).strict();
export const MemoryAddRequestSchema = z.object({ text: z.string().min(1).max(24000), metadata: z.record(z.string(), z.unknown()).default({}) }).strict();
export type MemorySearchRequest = z.infer<typeof MemorySearchRequestSchema>;
export type MemoryRecallRequest = z.infer<typeof MemoryRecallRequestSchema>;
export type KernelMemorySearchRequest = z.infer<typeof KernelMemorySearchRequestSchema>;
export type KernelMemoryRecallRequest = z.infer<typeof KernelMemoryRecallRequestSchema>;
export type KernelMemoryWriteRequest = z.infer<typeof KernelMemoryWriteRequestSchema>;

// Браузер получает только безопасные поля: model_trace — внутренняя телеметрия ядра.
export const BrowserServerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), trace_id: z.string(), protocol: z.literal('neyra.ws.chat.v1'), role: z.string(), ping_interval_seconds: z.number(), idle_timeout_seconds: z.number(), reconnect: z.literal('open_new_socket') }).strict(),
  z.object({ type: z.literal('pong'), ts: z.string(), trace_id: z.string() }).strict(),
  z.object({ type: z.literal('token'), text: z.string(), trace_id: z.string() }).strict(),
  z.object({ type: z.literal('phase'), phase: z.string().min(1).max(40), label: z.string().min(1).max(120).optional() }).strict(),
  z.object({ type: z.literal('done'), text: z.string(), sounds: z.array(z.unknown()).optional(), usage: ContextUsageSchema.optional(), turn_stats: TurnStatsSchema.optional(), trace_id: z.string() }).strict(),
  z.object({ type: z.literal('stopped'), trace_id: z.string() }).strict(),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string().optional(), trace_id: z.string() }).strict(),
]);
export type BrowserServerEvent = z.infer<typeof BrowserServerEventSchema>;

// Кадры ядра BFF → парсер: здесь model_trace допустим и не уходит в браузер.
export const KernelServerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), trace_id: z.string(), protocol: z.literal('neyra.ws.chat.v1'), role: z.string(), ping_interval_seconds: z.number(), idle_timeout_seconds: z.number(), reconnect: z.literal('open_new_socket') }).strict(),
  z.object({ type: z.literal('pong'), ts: z.string(), trace_id: z.string() }).strict(),
  z.object({ type: z.literal('token'), text: z.string(), trace_id: z.string() }).strict(),
  z.object({ type: z.literal('phase'), phase: z.string().min(1).max(40), label: z.string().min(1).max(120).optional() }).strict(),
  z.object({ type: z.literal('done'), text: z.string(), sounds: z.array(z.unknown()).optional(), usage: ContextUsageSchema.optional(), turn_stats: TurnStatsSchema.optional(), model_trace: z.unknown().optional(), trace_id: z.string() }).strict(),
  z.object({ type: z.literal('stopped'), trace_id: z.string() }).strict(),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string().optional(), trace_id: z.string(), model_trace: z.unknown().optional() }).strict(),
]);
export type KernelServerEvent = z.infer<typeof KernelServerEventSchema>;

// Старое имя — публичный контракт браузера: model_trace в него не проходит.
// Кадры ядра валидирует KernelServerEventSchema.
export const WsChatEventSchema = BrowserServerEventSchema;
export type WsChatEvent = BrowserServerEvent;

export const DesktopToolSchema = z.enum(['client.list_apps', 'client.open_url', 'client.open_app', 'client.search_web', 'client.list_windows', 'client.focus_window', 'client.close_window', 'client.media', 'client.volume', 'client.shell_exec', 'client.fs_list', 'client.fs_read', 'client.fs_search', 'client.fs_write', 'client.fs_mkdir', 'client.fs_move', 'client.screenshot', 'client.input', 'client.computer_snapshot', 'client.computer_click', 'client.computer_type', 'client.computer_press']);
export const DesktopManifestSchema = z.object({ protocol: z.literal('neyra.desktop.v1').default('neyra.desktop.v1'), device_id: z.string().uuid(), session_id: z.string().uuid(), name: z.string().min(1).max(90), platform: z.enum(['windows', 'macos', 'linux-wayland', 'linux-x11']), tools: z.array(DesktopToolSchema).max(24).default([]), commands: z.array(z.object({ name: z.string().min(1).max(60), triggers: z.array(z.object({ kind: z.enum(['phrase', 'regex', 'hotkey']), value: z.string().min(1).max(120) }).strict()).max(8).default([]), actions: z.array(z.string()).max(10).default([]) }).strict()).max(32).default([]), features: z.array(z.literal('command_drafts')).max(2).default([]) }).strict();
export type DesktopManifest = z.infer<typeof DesktopManifestSchema>;
export const CaptureEventSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('recording'), seq: z.number().int().nonnegative().optional() }), z.object({ type: z.literal('capture.failed'), code: z.string(), stage: z.enum(['start', 'stop']), seq: z.number().int().nonnegative().optional() }), z.object({ type: z.literal('voice.clip'), request_id: z.string().uuid(), audio: z.string(), duration_ms: z.number().nonnegative(), seq: z.number().int().nonnegative().optional() })]);
export type CaptureEvent = z.infer<typeof CaptureEventSchema>;
