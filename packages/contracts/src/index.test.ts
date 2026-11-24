import { describe, expect, it } from 'vitest';
import {
  AttachmentSchema,
  ChatMessageSchema,
  ChatRequestSchema,
  DesktopManifestSchema,
  KernelAttachmentSchema,
  KernelChatMessageSchema,
  KernelChatRequestSchema,
  KernelMemoryRecallRequestSchema,
  KernelMemorySearchRequestSchema,
  KernelMemoryWriteRequestSchema,
  KernelWsChatMessageSchema,
  MemoryAddRequestSchema,
  MemoryRecallRequestSchema,
  MemorySearchRequestSchema,
  MemoryWriteRequestSchema,
  CaptureEventSchema,
  BrowserServerEventSchema,
  KernelServerEventSchema,
  SseChatEventSchema,
  TurnStatsSchema,
  WsChatEventSchema,
  WsChatMessageSchema,
} from './index';

const uuid = '11111111-1111-4111-8111-111111111111';
const uploadId = 'upload-1';
const kernelAttachment = { kind: 'image', path: 'uploads/cat.png', mime: 'image/png' };

describe('browser → BFF: chat request', () => {
  it('accepts only user content and strictly rejects unknown keys', () => {
    expect(ChatRequestSchema.safeParse({ text: 'hello' }).success).toBe(true);
    expect(ChatRequestSchema.safeParse({ text: 'hello', chat_id: uuid, model: 'gpt', attachments: [{ upload_id: uploadId }] }).success).toBe(true);
    expect(ChatRequestSchema.safeParse({ text: '' }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ text: 'hello', extra: true }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ text: 'hello', attachments: Array.from({ length: 5 }, () => ({ upload_id: uploadId })) }).success).toBe(false);
  });

  it('rejects every identity field: их заполняет только BFF', () => {
    for (const field of ['username', 'platform_user_id', 'channel_id', 'author_display_name', 'platform']) {
      expect(ChatRequestSchema.safeParse({ text: 'hello', [field]: 'spoof' }).success).toBe(false);
    }
  });
});

describe('browser → BFF: attachments', () => {
  it('accepts only a BFF-issued upload_id, never a client path/url', () => {
    expect(AttachmentSchema.safeParse({ upload_id: uploadId }).success).toBe(true);
    expect(AttachmentSchema.safeParse({ upload_id: uploadId, path: 'uploads/cat.png' }).success).toBe(false);
    expect(AttachmentSchema.safeParse({ upload_id: uploadId, url: 'https://core.test/uploads/cat.png' }).success).toBe(false);
    expect(AttachmentSchema.safeParse({ path: 'uploads/cat.png', mime: 'image/png' }).success).toBe(false);
    expect(AttachmentSchema.safeParse({ url: 'https://core.test/uploads/cat.png' }).success).toBe(false);
    expect(AttachmentSchema.safeParse({ kind: 'image', mime: 'image/png' }).success).toBe(false);
  });

  it('keeps only a relative uploads path in the kernel attachment schema', () => {
    expect(KernelAttachmentSchema.safeParse(kernelAttachment).success).toBe(true);
    expect(KernelAttachmentSchema.safeParse({ kind: 'image', path: 'uploads/file.png', mime: 'image/png' }).success).toBe(true);
    expect(KernelAttachmentSchema.safeParse({ kind: 'image', path: '/uploads/file.png', mime: 'image/png' }).success).toBe(false);
    // URL с любым хостом — SSRF-канал, такого поля в контракте больше нет.
    expect(KernelAttachmentSchema.safeParse({ kind: 'image', url: 'http://169.254.169.254/uploads/x', mime: 'image/png' }).success).toBe(false);
    expect(KernelAttachmentSchema.safeParse({ kind: 'image', path: 'uploads/../../etc/passwd', mime: 'text/plain' }).success).toBe(false);
    expect(KernelAttachmentSchema.safeParse({ kind: 'image', path: '../uploads/cat.png', mime: 'image/png' }).success).toBe(false);
    expect(KernelAttachmentSchema.safeParse({ kind: 'image', path: 'uploads/cat.png', mime: 'image/png', extra: 1 }).success).toBe(false);
  });
});

describe('browser → BFF: chat messages', () => {
  it('does not accept client path/url in message attachments', () => {
    expect(ChatMessageSchema.safeParse({ role: 'user', content: 'x', attachments: [{ upload_id: uploadId }] }).success).toBe(true);
    expect(ChatMessageSchema.safeParse({ role: 'user', content: 'x', attachments: [kernelAttachment] }).success).toBe(false);
    expect(KernelChatMessageSchema.safeParse({ role: 'user', content: 'x', attachments: [kernelAttachment] }).success).toBe(true);
  });
});

describe('browser → BFF: WebSocket frame', () => {
  it('accepts text/model/upload_id and rejects identity fields', () => {
    expect(WsChatMessageSchema.safeParse({ type: 'chat', text: 'x' }).success).toBe(true);
    expect(WsChatMessageSchema.safeParse({ type: 'chat', text: 'x', model: 'gpt', attachments: [{ upload_id: uploadId }] }).success).toBe(true);
    for (const field of ['username', 'platform_user_id', 'channel_id', 'author_display_name', 'platform', 'display_name']) {
      expect(WsChatMessageSchema.safeParse({ type: 'chat', text: 'x', [field]: 'spoof' }).success).toBe(false);
    }
    expect(WsChatMessageSchema.safeParse({ type: 'chat', text: 'x', attachments: [kernelAttachment] }).success).toBe(false);
    expect(WsChatMessageSchema.safeParse({ type: 'ping' }).success).toBe(true);
    expect(WsChatMessageSchema.safeParse({ type: 'stop' }).success).toBe(true);
  });

  it('keeps the kernel WS frame with signed identity and upload paths', () => {
    const frame = {
      type: 'chat',
      text: 'x',
      username: 'alice@example.test',
      platform_user_id: 'usr-1',
      channel_id: 'web:usr-1:thread',
      author_display_name: 'Алиса',
      attachments: [kernelAttachment],
    };
    expect(KernelWsChatMessageSchema.safeParse(frame).success).toBe(true);
    expect(KernelWsChatMessageSchema.safeParse({ ...frame, extra: true }).success).toBe(false);
    expect(KernelWsChatMessageSchema.safeParse({ ...frame, attachments: [{ upload_id: uploadId }] }).success).toBe(false);
    // Core WsChatMessage не принимает platform (extra=forbid) — этого поля нет и здесь.
    expect(KernelWsChatMessageSchema.safeParse({ ...frame, platform: 'web' }).success).toBe(false);
  });
});

describe('core → BFF: server events', () => {
  it('accepts bounded turn_stats in done without raw model_trace', () => {
    const stats = {
      duration_ms: 8400,
      llm_ms: 7200,
      output_tokens: 240,
      tokens_per_second: 33.3,
      lanes: {
        brain: { calls: 1, duration_ms: 3100, model: 'brain-model', input_tokens: 100, output_tokens: 20 },
        talk: { calls: 1, duration_ms: 2600, model: 'talk-model', output_tokens: 200 },
        memory: { calls: 2, duration_ms: 1500, model: 'memory-model' },
      },
    };
    expect(TurnStatsSchema.safeParse(stats).success).toBe(true);
    expect(TurnStatsSchema.safeParse({ ...stats, raw: 'secret' }).success).toBe(false);
    expect(BrowserServerEventSchema.safeParse({ type: 'done', text: 'ok', trace_id: 't', turn_stats: stats }).success).toBe(true);
    expect(KernelServerEventSchema.safeParse({ type: 'done', text: 'ok', trace_id: 't', turn_stats: stats }).success).toBe(true);
    expect(SseChatEventSchema.safeParse({ type: 'done', text: 'ok', turn_stats: stats }).success).toBe(true);
  });

  it('accepts phase, usage in done and stopped', () => {
    expect(KernelServerEventSchema.safeParse({ type: 'phase', phase: 'answer', label: 'Формулирую ответ…' }).success).toBe(true);
    expect(KernelServerEventSchema.safeParse({ type: 'done', text: 'ok', trace_id: 't', usage: { total: { used: 1, limit: 10 } } }).success).toBe(true);
    expect(KernelServerEventSchema.safeParse({ type: 'stopped', trace_id: 't' }).success).toBe(true);
    expect(BrowserServerEventSchema.safeParse({ type: 'stopped', trace_id: 't' }).success).toBe(true);
  });
});

describe('browser → BFF: memory requests', () => {
  it('strips user_id from search and recall', () => {
    expect(MemorySearchRequestSchema.parse({ query: 'x' }).top_k).toBe(3);
    expect(MemorySearchRequestSchema.safeParse({ query: 'x', top_k: 21 }).success).toBe(false);
    expect(MemorySearchRequestSchema.safeParse({ query: 'x', user_id: 'usr-1' }).success).toBe(false);
    expect(MemoryRecallRequestSchema.parse({}).limit).toBe(20);
    expect(MemoryRecallRequestSchema.safeParse({ offset: -1 }).success).toBe(false);
    expect(MemoryRecallRequestSchema.safeParse({ user_id: 'usr-1' }).success).toBe(false);
    expect(MemoryRecallRequestSchema.safeParse({ channel_id: 'web:1' }).success).toBe(false);
    expect(MemoryWriteRequestSchema.safeParse({ user_text: 'x', assistant_text: 'y' }).success).toBe(true);
    expect(MemoryWriteRequestSchema.safeParse({ user_text: 'x', assistant_text: 'y', username: 'spoof' }).success).toBe(false);
    expect(MemoryWriteRequestSchema.safeParse({ user_text: 'x', assistant_text: 'y', platform_user_id: 'spoof' }).success).toBe(false);
  });

  it('keeps identity in the kernel memory schemas', () => {
    expect(KernelMemorySearchRequestSchema.safeParse({ query: 'x', user_id: 'usr-1' }).success).toBe(true);
    expect(KernelMemoryRecallRequestSchema.safeParse({ user_id: 'usr-1', channel_id: 'web:1' }).success).toBe(true);
    expect(KernelMemoryWriteRequestSchema.safeParse({ user_text: 'x', assistant_text: 'y', username: 'alice', platform_user_id: 'usr-1' }).success).toBe(true);
    expect(KernelMemorySearchRequestSchema.safeParse({ query: 'x', extra: true }).success).toBe(false);
  });

  it('keeps memory add strict but usable', () => {
    expect(MemoryAddRequestSchema.safeParse({ text: 'x' }).success).toBe(true);
    expect(MemoryAddRequestSchema.safeParse({ text: 'x', metadata: { a: 1 }, extra: true }).success).toBe(false);
  });
});

describe('server-only payloads', () => {
  it('allows identity only in the kernel chat request, not in the browser request', () => {
    const request = { text: 'hello', username: 'alice', platform_user_id: 'usr-1', channel_id: 'web:1', platform: 'web', attachments: [kernelAttachment] };
    expect(KernelChatRequestSchema.safeParse(request).success).toBe(true);
    expect(KernelChatRequestSchema.safeParse({ text: 'hello' }).success).toBe(true);
    expect(ChatRequestSchema.safeParse({ text: 'hello', username: 'alice' }).success).toBe(false);
    expect(KernelChatRequestSchema.safeParse({ ...request, extra: true }).success).toBe(false);
    expect(KernelChatRequestSchema.safeParse({ ...request, attachments: [{ upload_id: uploadId }] }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ text: 'hello', model: 'm'.repeat(200) }).success).toBe(true);
    expect(ChatRequestSchema.safeParse({ text: 'hello', model: 'm'.repeat(201) }).success).toBe(false);
    expect(KernelChatRequestSchema.safeParse({ ...request, model: 'm'.repeat(200) }).success).toBe(true);
    expect(KernelChatRequestSchema.safeParse({ ...request, model: 'm'.repeat(201) }).success).toBe(false);
  });

  it('keeps model_trace in kernel events and rejects it in browser events', () => {
    const kernelDone = { type: 'done', text: 'x', trace_id: 't', model_trace: { lane: 'talk' } };
    expect(KernelServerEventSchema.safeParse(kernelDone).success).toBe(true);
    expect(BrowserServerEventSchema.safeParse(kernelDone).success).toBe(false);
    expect(WsChatEventSchema.safeParse(kernelDone).success).toBe(false);
    expect(WsChatEventSchema.safeParse({ type: 'done', text: 'x', trace_id: 't' }).success).toBe(true);
    expect(BrowserServerEventSchema.safeParse({ type: 'done', text: 'x', trace_id: 't' }).success).toBe(true);
    expect(BrowserServerEventSchema.safeParse({ type: 'token', text: 'x', trace_id: 't', extra: 1 }).success).toBe(false);
    expect(KernelServerEventSchema.safeParse({ type: 'token', text: 3, trace_id: 't' }).success).toBe(false);
  });
});

describe('desktop and capture contracts', () => {
  it('validates desktop IDs and tools', () => {
    const manifest = { device_id: uuid, session_id: uuid, name: 'PC', platform: 'linux-x11' };
    expect(DesktopManifestSchema.safeParse(manifest).success).toBe(true);
    expect(DesktopManifestSchema.safeParse({ ...manifest, tools: ['shell'] }).success).toBe(false);
  });

  it('distinguishes capture stages and clip correlation', () => {
    expect(CaptureEventSchema.safeParse({ type: 'capture.failed', code: 'busy', stage: 'start' }).success).toBe(true);
    expect(CaptureEventSchema.safeParse({ type: 'capture.failed', code: 'busy', stage: 'other' }).success).toBe(false);
    expect(CaptureEventSchema.safeParse({ type: 'voice.clip', audio: 'x', duration_ms: 100, request_id: uuid }).success).toBe(true);
  });

  it('keeps the capture number of a failed stop', () => {
    const parsed = CaptureEventSchema.parse({ type: 'capture.failed', code: 'busy', stage: 'stop', seq: 3 });
    expect(parsed).toMatchObject({ seq: 3 });
  });
});
