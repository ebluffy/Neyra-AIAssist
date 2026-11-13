import { it, expect } from 'vitest';
import { ChatRequestSchema, ChatMessageSchema, WsChatMessageSchema, WsChatEventSchema, SseChatEventSchema, MemorySearchRequestSchema, MemoryRecallRequestSchema, MemoryWriteRequestSchema, DesktopManifestSchema, CaptureEventSchema } from './index';
const uuid = '11111111-1111-4111-8111-111111111111';
it('validates chat text, chat_id UUID, and forbids unknown keys', () => {
  expect(ChatRequestSchema.safeParse({ text: 'hello' }).success).toBe(true);
  expect(ChatRequestSchema.safeParse({ text: 'hello', chat_id: uuid }).success).toBe(true);
  expect(ChatRequestSchema.safeParse({ text: 'hello', chat_id: 'not-a-uuid' }).success).toBe(false);
  expect(ChatRequestSchema.safeParse({ text: 'a'.repeat(6001) }).success).toBe(false);
  expect(ChatRequestSchema.safeParse({ text: '', extra: true }).success).toBe(false);
});
it('validates message role and identity', () => { expect(ChatMessageSchema.safeParse({role:'user',content:'x',request_id:uuid}).success).toBe(true); expect(ChatMessageSchema.safeParse({role:'tool',content:'x'}).success).toBe(false); });
it('supports target v2 attachments and stop', () => { expect(WsChatMessageSchema.safeParse({type:'stop'}).success).toBe(true); expect(ChatRequestSchema.safeParse({text:'x',attachments:[{kind:'image',mime:'image/png'}]}).success).toBe(false); });
it('validates streaming tokens', () => { expect(WsChatEventSchema.safeParse({type:'token',text:'x',trace_id:'t'}).success).toBe(true); expect(WsChatEventSchema.safeParse({type:'token',text:3}).success).toBe(false); });
it('bounds memory search', () => { expect(MemorySearchRequestSchema.parse({query:'x'}).top_k).toBe(3); expect(MemorySearchRequestSchema.safeParse({query:'x',top_k:21}).success).toBe(false); });
it('bounds memory recall', () => { expect(MemoryRecallRequestSchema.parse({}).limit).toBe(20); expect(MemoryRecallRequestSchema.safeParse({offset:-1}).success).toBe(false); });
it('requires both texts for memory write', () => { expect(MemoryWriteRequestSchema.safeParse({user_text:'x',assistant_text:'y'}).success).toBe(true); expect(MemoryWriteRequestSchema.safeParse({user_text:'x'}).success).toBe(false); });
it('validates desktop IDs and tools', () => { const m={device_id:uuid,session_id:uuid,name:'PC',platform:'linux-x11'}; expect(DesktopManifestSchema.safeParse(m).success).toBe(true); expect(DesktopManifestSchema.safeParse({...m,tools:['shell']}).success).toBe(false); });
it('distinguishes capture stages and clip correlation', () => { expect(CaptureEventSchema.safeParse({type:'capture.failed',code:'busy',stage:'start'}).success).toBe(true); expect(CaptureEventSchema.safeParse({type:'capture.failed',code:'busy',stage:'other'}).success).toBe(false); expect(CaptureEventSchema.safeParse({type:'voice.clip',audio:'x',duration_ms:100,request_id:uuid}).success).toBe(true); });

it('keeps the capture number of a failed stop', () => {
  const parsed = CaptureEventSchema.parse({ type: 'capture.failed', code: 'busy', stage: 'stop', seq: 3 });
  expect(parsed).toMatchObject({ seq: 3 });
});

it('does not accept the REST-only platform field on the WS chat', () => {
  expect(WsChatMessageSchema.safeParse({ type: 'chat', text: 'x', platform: 'web' }).success).toBe(false);
  expect(WsChatMessageSchema.safeParse({ type: 'chat', text: 'x', username: 'u' }).success).toBe(true);
});

it('validates chat SSE events (token, done, error, thinking) with strict whitelisted fields', () => {
  expect(SseChatEventSchema.safeParse({ type: 'token', text: 'hello' }).success).toBe(true);
  expect(SseChatEventSchema.safeParse({ type: 'thinking', text: 'thinking...' }).success).toBe(true);
  expect(SseChatEventSchema.safeParse({ type: 'thinking' }).success).toBe(true);
  expect(SseChatEventSchema.safeParse({ type: 'done', text: 'final' }).success).toBe(true);
  expect(SseChatEventSchema.safeParse({ type: 'error', code: 'chat_error', message: 'fail' }).success).toBe(true);

  // Rejects internal leakage: model_trace, thoughts
  expect(SseChatEventSchema.safeParse({ type: 'done', text: 'final', thoughts: 'th' }).success).toBe(false);
  expect(SseChatEventSchema.safeParse({ type: 'done', text: 'final', model_trace: {} }).success).toBe(false);
  expect(SseChatEventSchema.safeParse({ type: 'error', code: 'chat_error', message: 'fail', model_trace: {} }).success).toBe(false);

  expect(SseChatEventSchema.safeParse({ type: 'unknown', text: 'x' }).success).toBe(false);
  expect(SseChatEventSchema.safeParse({ type: 'token' }).success).toBe(false);
  expect(SseChatEventSchema.safeParse({ type: 'done' }).success).toBe(false);
  expect(SseChatEventSchema.safeParse({ type: 'error' }).success).toBe(false);
});
