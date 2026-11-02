// Node equivalent of the client's TLS + Bearer transport, for the legacy chat WS.
import assert from 'node:assert/strict';
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
const deniedSocket = new WebSocket(wsUrl, { handshakeTimeout: 5000 });
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
console.log('Node client: health/auth/REST chat/WSS hello/ping/token/done PASS');
