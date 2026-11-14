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

// Вложение, которое браузер получил от BFF после загрузки. Никаких path/url.
export const AttachmentSchema = z.object({ upload_id: z.string().min(1).max(120) }).strict();
export const BrowserAttachmentSchema = AttachmentSchema;
export type BrowserAttachment = z.infer<typeof AttachmentSchema>;

// Вложение в кадре BFF → ядро. path/url допустимы только здесь и только внутри uploads/.
const uploadPath = z.string().min(1).max(500)
  .regex(/^uploads\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, 'path must be inside uploads/')
  .refine((value) => value.split('/').every((part) => part && part !== '.' && part !== '..'), 'path traversal is forbidden');
const uploadUrl = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    const pathname = decodeURIComponent(url.pathname);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (pathname === '/uploads' || pathname.startsWith('/uploads/'))
      && !pathname.split('/').includes('..');
  } catch {
    return false;
  }
}, 'url must point inside uploads/');

export const KernelAttachmentSchema = z.object({
  kind: z.enum(['image', 'file', 'audio', 'text']),
  path: uploadPath.optional(),
  url: uploadUrl.optional(),
  mime: z.string().min(1),
  text: z.string().optional(),
}).strict().refine((value) => Boolean(value.path || value.url || value.text), 'Attachment requires a source');
export type KernelAttachment = z.infer<typeof KernelAttachmentSchema>;

// Браузер → BFF. chat_id не является личностью: BFF всё равно привязывает его к user.id.
export const ChatRequestSchema = z.object({
  text: z.string().min(1).max(6000),
  chat_id: z.string().uuid().optional(),
  model: z.string().min(1).optional(),
  attachments: z.array(AttachmentSchema).max(4).optional(),
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
  attachments: z.array(AttachmentSchema).max(4).optional(),
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
  ...kernelIdentity,
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
export const MemoryAddRequestSchema = z.object({ text: z.string().min(1).max(24000), metadata: z.record(z.unknown()).default({}) }).strict();
export type MemorySearchRequest = z.infer<typeof MemorySearchRequestSchema>;
export type MemoryRecallRequest = z.infer<typeof MemoryRecallRequestSchema>;
export type KernelMemorySearchRequest = z.infer<typeof KernelMemorySearchRequestSchema>;
export type KernelMemoryRecallRequest = z.infer<typeof KernelMemoryRecallRequestSchema>;
export type KernelMemoryWriteRequest = z.infer<typeof KernelMemoryWriteRequestSchema>;

export const WsChatEventSchema = z.discriminatedUnion('type', [
 z.object({ type: z.literal('hello'), trace_id: z.string(), protocol: z.literal('neyra.ws.chat.v1'), role: z.string(), ping_interval_seconds: z.number(), idle_timeout_seconds: z.number(), reconnect: z.literal('open_new_socket') }),
 z.object({ type: z.literal('pong'), ts: z.string(), trace_id: z.string() }),
 z.object({ type: z.literal('token'), text: z.string(), trace_id: z.string() }),
 z.object({ type: z.literal('done'), text: z.string(), sounds: z.array(z.unknown()).optional(), model_trace: z.unknown().optional(), trace_id: z.string() }),
 z.object({ type: z.literal('error'), code: z.string(), message: z.string().optional(), trace_id: z.string(), model_trace: z.unknown().optional() })
]);
export type WsChatEvent = z.infer<typeof WsChatEventSchema>;
export const DesktopToolSchema = z.enum(['client.list_apps', 'client.open_url', 'client.open_app', 'client.search_web', 'client.list_windows', 'client.focus_window', 'client.close_window', 'client.media', 'client.volume', 'client.shell_exec', 'client.fs_list', 'client.fs_read', 'client.fs_search', 'client.fs_write', 'client.fs_mkdir', 'client.fs_move', 'client.screenshot', 'client.input', 'client.computer_snapshot', 'client.computer_click', 'client.computer_type', 'client.computer_press']);
export const DesktopManifestSchema = z.object({ protocol: z.literal('neyra.desktop.v1').default('neyra.desktop.v1'), device_id: z.string().uuid(), session_id: z.string().uuid(), name: z.string().min(1).max(90), platform: z.enum(['windows', 'macos', 'linux-wayland', 'linux-x11']), tools: z.array(DesktopToolSchema).max(24).default([]), commands: z.array(z.object({ name: z.string().min(1).max(60), triggers: z.array(z.object({ kind: z.enum(['phrase', 'regex', 'hotkey']), value: z.string().min(1).max(120) }).strict()).max(8).default([]), actions: z.array(z.string()).max(10).default([]) }).strict()).max(32).default([]), features: z.array(z.literal('command_drafts')).max(2).default([]) }).strict();
export type DesktopManifest = z.infer<typeof DesktopManifestSchema>;
export const CaptureEventSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('recording'), seq: z.number().int().nonnegative().optional() }), z.object({ type: z.literal('capture.failed'), code: z.string(), stage: z.enum(['start', 'stop']), seq: z.number().int().nonnegative().optional() }), z.object({ type: z.literal('voice.clip'), request_id: z.string().uuid(), audio: z.string(), duration_ms: z.number().nonnegative(), seq: z.number().int().nonnegative().optional() })]);
export type CaptureEvent = z.infer<typeof CaptureEventSchema>;
