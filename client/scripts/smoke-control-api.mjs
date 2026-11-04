// Node equivalent of the client's TLS + Bearer desktop bridge, plus legacy chat.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import https from 'node:https';
import { once } from 'node:events';
import WebSocket from 'ws';

const base = new URL(process.env.SMOKE_URL);
assert.equal(base.protocol, 'https:');
assert.equal(base.hostname, '127.0.0.1');
assert.equal(base.pathname, '/api');
assert.equal(base.username + base.password + base.search + base.hash, '');
const token = process.env.API_TOKEN;
assert.ok(token);
const headers = { Authorization: `Bearer ${token}` };

function request(path, { authenticated = true, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(authenticated ? headers : {}), 'Content-Type': 'application/json' },
      timeout: 5000,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('HTTP timeout')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const health = await request('/v1/health');
assert.equal(health.status, 200);
assert.equal(health.body.ok, true);
assert.equal(health.body.data.summary, 'offline');
const denied = await request('/v1/health', { authenticated: false });
assert.ok([401, 403].includes(denied.status));
const chatDenied = await request('/v1/chat', { authenticated: false, body: { text: 'smoke' } });
assert.ok([401, 403].includes(chatDenied.status));
const chat = await request('/v1/chat', { body: { text: 'smoke' } });
assert.equal(chat.status, 200);
assert.equal(chat.body.ok, true);
assert.equal(chat.body.data.text, 'offline:smoke');
assert.ok(chat.body.trace_id);

const wsUrl = new URL(`${base}/v1/ws/chat`);
wsUrl.protocol = 'wss:';

// The HTTP auth gate must also protect the WebSocket upgrade.
async function assertSocketDenied(url) {
  const deniedSocket = new WebSocket(url, { handshakeTimeout: 5000 });
  try {
    await new Promise((resolve, reject) => {
      deniedSocket.on('error', reject);
      deniedSocket.on('open', () => {
        reject(new Error('Unauthenticated WebSocket accepted'));
      });
      deniedSocket.on('unexpected-response', (_req, res) => {
        res.resume();
        try { assert.ok([401, 403].includes(res.statusCode)); resolve(); }
        catch (error) { reject(error); }
      });
    });
  } finally {
    deniedSocket.terminate();
  }
}
await assertSocketDenied(wsUrl);

const ws = new WebSocket(wsUrl, { headers, handshakeTimeout: 5000 });
const timer = setTimeout(() => ws.terminate(), 5000);
try {
  await new Promise((resolve, reject) => {
    let stage = 'hello';
    let text = '';
    ws.on('error', reject);
    ws.on('close', () => {
      if (stage !== 'done') reject(new Error('WebSocket closed before done'));
    });
    ws.on('message', (raw) => {
      try {
        const packet = JSON.parse(raw.toString());
        assert.ok(packet.trace_id);
        if (stage === 'hello') {
          assert.equal(packet.type, 'hello');
          assert.equal(packet.protocol, 'neyra.ws.chat.v1');
          assert.equal(packet.role, 'admin');
          assert.ok(packet.ping_interval_seconds > 0);
          assert.ok(packet.idle_timeout_seconds > 0);
          stage = 'pong';
          ws.send(JSON.stringify({ type: 'ping' }));
        } else if (stage === 'pong') {
          assert.equal(packet.type, 'pong');
          stage = 'chat';
          ws.send(JSON.stringify({ type: 'chat', text: 'smoke' }));
        } else if (stage === 'chat' && packet.type === 'token') {
          assert.equal(typeof packet.text, 'string');
          text += packet.text;
        } else {
          assert.equal(stage, 'chat');
          assert.equal(packet.type, 'done');
          assert.equal(packet.text, 'offline:smoke');
          assert.equal(text, packet.text);
          stage = 'done';
          resolve();
        }
      } catch (error) { reject(error); }
    });
  });
  const closed = once(ws, 'close');
  ws.close(1000);
  const [code] = await closed;
  assert.equal(code, 1000);
} finally {
  clearTimeout(timer);
  ws.terminate();
}

const bridgeUrl = new URL(`${base}/v1/desktop/bridge`);
bridgeUrl.protocol = 'wss:';
await assertSocketDenied(bridgeUrl);

// Match lib.rs manifest() and connect_profile(): send the raw manifest on open.
const manifest = {
  protocol: 'neyra.desktop.v1',
  device_id: randomUUID(),
  session_id: randomUUID(),
  name: 'Offline smoke desktop',
  platform: 'linux-x11',
  tools: ['client.open_url'],
  commands: [],
  features: ['command_drafts'],
};
const updatedManifest = { ...manifest, tools: ['client.list_apps'] };
const requestId = randomUUID();
const bridge = new WebSocket(bridgeUrl, { headers, handshakeTimeout: 5000 });
const bridgeTimer = setTimeout(() => bridge.terminate(), 5000);
try {
  await new Promise((resolve, reject) => {
    let stage = 'hello';
    let text = '';
    bridge.on('error', reject);
    bridge.on('open', () => bridge.send(JSON.stringify(manifest)));
    bridge.on('close', () => {
      if (stage !== 'done') reject(new Error('Desktop bridge closed before done'));
    });
    bridge.on('message', (raw) => {
      try {
        const packet = JSON.parse(raw.toString());
        if (stage === 'hello') {
          assert.equal(packet.type, 'hello');
          assert.equal(packet.protocol, manifest.protocol);
          assert.equal(packet.device_id, manifest.device_id);
          stage = 'capabilities';
          bridge.send(JSON.stringify({ type: 'capabilities', manifest: updatedManifest }));
        } else if (stage === 'capabilities') {
          assert.equal(packet.type, 'capabilities');
          assert.deepEqual(packet.tools, updatedManifest.tools);
          stage = 'pong';
          bridge.send(JSON.stringify({ type: 'ping' }));
        } else if (stage === 'pong') {
          assert.equal(packet.type, 'pong');
          stage = 'chat';
          bridge.send(JSON.stringify({ type: 'chat', text: 'smoke', request_id: requestId }));
        } else {
          assert.equal(stage, 'chat');
          assert.equal(packet.request_id, requestId);
          if (packet.type === 'token') {
            text += packet.text;
          } else {
            assert.equal(packet.type, 'done');
            assert.equal(packet.text, 'offline:smoke');
            assert.equal(text, packet.text);
            stage = 'done';
            resolve();
          }
        }
      } catch (error) { reject(error); }
    });
  });
  const closed = once(bridge, 'close');
  bridge.close(1000);
  const [code] = await closed;
  assert.equal(code, 1000);
} finally {
  clearTimeout(bridgeTimer);
  bridge.terminate();
}
console.log('Node client: health/auth/REST/legacy WSS/desktop bridge hello/capabilities/chat/done PASS');
