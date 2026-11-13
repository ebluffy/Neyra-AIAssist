#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const WS_PORT = 3991;
const HTTP_PORT = 3992;
const JWT_SECRET = 'supersecretjwtkeythatisthirtytwocharslong';

console.log('=== Starting Neyra /api/chat standalone WS regression smoke test ===');

// 1. Start mock core WS server
let wsReceivedPayload = null;
let wsConnectionCount = 0;

const wsHttpServer = createServer();
const wss = new WebSocketServer({ server: wsHttpServer });

wss.on('connection', (ws, req) => {
  wsConnectionCount++;
  console.log(`[MockCore] Connection received on URL: ${req.url}`);

  const authHeader = req.headers['authorization'];
  const identityHeader = req.headers['x-neyra-identity'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.error('[MockCore] Missing or invalid Authorization header');
    ws.close(1008, 'Unauthorized');
    return;
  }
  if (!identityHeader) {
    console.error('[MockCore] Missing X-Neyra-Identity header');
    ws.close(1008, 'Missing identity token');
    return;
  }

  // 1. Send hello
  ws.send(JSON.stringify({ type: 'hello', protocol: 'neyra.ws.chat.v1' }));
  console.log('[MockCore] Sent hello frame');

  // 2. Listen for client payload (tests masking on client side!)
  ws.on('message', (data, isBinary) => {
    try {
      const parsed = JSON.parse(data.toString());
      console.log(`[MockCore] Successfully received client payload: ${parsed.type} -> "${parsed.text}"`);
      wsReceivedPayload = parsed;

      // Reply with token and done frames
      ws.send(JSON.stringify({ type: 'token', text: `Эхо: ${parsed.text}` }));
      ws.send(JSON.stringify({
        type: 'done',
        text: '',
        usage: {
          prompt_tokens: 42,
          completion_tokens: 15,
          context_used: 57,
          context_limit: 1000000,
          lanes: {
            talk: { used: 30, limit: 250000 },
            brain: { used: 27, limit: 500000 },
          },
        },
      }));
      console.log('[MockCore] Sent token and done frames');
    } catch (err) {
      console.error('[MockCore] Error parsing message from client:', err);
    }
  });

  ws.on('error', (err) => {
    console.error('[MockCore] Socket error:', err);
  });
});

await new Promise((resolve) => wsHttpServer.listen(WS_PORT, '127.0.0.1', resolve));
console.log(`[MockCore] Listening on ws://127.0.0.1:${WS_PORT}`);

// 2. Start standalone Next.js server
const serverPath = '.next/standalone/web/server.js';
console.log(`[Smoke] Spawning standalone server: node ${serverPath} on port ${HTTP_PORT}`);

const child = spawn(process.execPath, [serverPath], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(HTTP_PORT),
    HOSTNAME: '127.0.0.1',
    DATABASE_URL: 'postgresql://localhost:5432/smoke_unused',
    BETTER_AUTH_SECRET: 'supersecretbetterauthsecret32charslong!',
    BETTER_AUTH_URL: `http://127.0.0.1:${HTTP_PORT}`,
    NEYRA_WS_URL: `ws://127.0.0.1:${WS_PORT}`,
    NEYRA_SERVICE_KEY: 'test-service-key-123',
    NEYRA_IDENTITY_JWT_SECRET: JWT_SECRET,
    NEYRA_IDENTITY_JWT_ISSUER: 'neyra-web',
    SMOKE_TEST: '1',
    WS_NO_BUFFER_UTIL: '1',
    WS_NO_UTF_8_VALIDATE: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (d) => process.stdout.write(`[Server:stdout] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[Server:stderr] ${d}`));

let serverExited = false;
child.on('exit', (code) => {
  serverExited = true;
  console.log(`[Server] Process exited with code ${code}`);
});

// Wait for server ready
async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (serverExited) throw new Error('Standalone server exited unexpectedly during startup');
    try {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/health`);
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

async function cleanup() {
  console.log('[Smoke] Cleaning up servers...');
  child.kill('SIGTERM');
  wss.close();
  wsHttpServer.close();
}

try {
  await waitForServer();
  console.log(`[Smoke] Standalone server is healthy on http://127.0.0.1:${HTTP_PORT}`);

  // 3. Send POST to /api/chat
  const chatPayload = {
    text: 'Тестовое сообщение для проверки отправки WS-кадра',
    chat_id: '11111111-2222-3333-4444-555555555555',
  };

  console.log('[Smoke] Sending POST /api/chat with x-smoke-test: 1');
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-smoke-test': '1',
    },
    body: JSON.stringify(chatPayload),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`POST /api/chat returned status ${res.status}: ${errorText}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    throw new Error(`Expected text/event-stream content-type, got: ${contentType}`);
  }

  console.log('[Smoke] Reading SSE response stream...');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const sseEvents = [];

  const readDeadline = Date.now() + 10000;
  while (Date.now() < readDeadline) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop(); // keep last incomplete chunk
      for (const block of lines) {
        for (const line of block.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              console.log(`[Smoke] Received SSE event: ${event.type}`);
              sseEvents.push(event);
            } catch {
              // ignore invalid json
            }
          }
        }
      }
    }

    if (sseEvents.some((e) => e.type === 'done') || done) {
      break;
    }
  }

  // 4. Assertions
  const hasToken = sseEvents.some((e) => e.type === 'token');
  const hasDone = sseEvents.some((e) => e.type === 'done');

  console.log('--- Verification Summary ---');
  console.log(`WS connections count: ${wsConnectionCount}`);
  console.log(`WS mock received client payload: ${wsReceivedPayload ? 'YES' : 'NO'}`);
  console.log(`SSE has token: ${hasToken}`);
  console.log(`SSE has done: ${hasDone}`);

  if (!wsReceivedPayload) {
    throw new Error('FAIL: Client WS frame was NOT received by mock core (probable b.mask error)');
  }
  if (!hasToken) {
    throw new Error('FAIL: /api/chat SSE did not emit any "token" event');
  }
  if (!hasDone) {
    throw new Error('FAIL: /api/chat SSE did not emit "done" event');
  }

  console.log('=== SUCCESS: Standalone /api/chat sends frames without b.mask error and delivers token + done ===');
  await cleanup();
  process.exit(0);
} catch (err) {
  console.error('[Smoke] TEST FAILED:', err);
  await cleanup();
  process.exit(1);
}
