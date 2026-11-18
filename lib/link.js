// The local link between this MCP server and the Tabmate extension.
// - Listens on 127.0.0.1 only, on the first free port in PORTS.
// - Accepts a WebSocket only from a chrome-extension:// origin with a local Host header.
// - Both sides prove they know the pairing token with an HMAC challenge. The token is never sent.
'use strict';
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');

const PORTS = [47821, 47822, 47823, 47824, 47825, 47826, 47827, 47828, 47829, 47830];
const HOST = '127.0.0.1';
const EXT_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const AUTH_TIMEOUT_MS = 5000;
const PING_MS = 20000;
const MAX_MESSAGE_BYTES = 1024 * 1024;

const hmac = (token, text) => crypto.createHmac('sha256', token).update(text).digest('hex');
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Rejects anything that is not the extension talking to us on this machine.
function allowedUpgrade(req, port, extensionId) {
  const host = String(req.headers.host || '');
  const origin = String(req.headers.origin || '');
  if (req.url !== '/tabmate') return false;
  if (host !== HOST + ':' + port && host !== 'localhost:' + port) return false; // DNS rebinding guard
  if (!EXT_ORIGIN.test(origin)) return false; // web pages can't fake their Origin
  if (extensionId && origin !== 'chrome-extension://' + extensionId) return false;
  return true;
}

class ExtensionLink extends EventEmitter {
  constructor({ token, ports = PORTS, extensionId = '', clientName = 'Claude' }) {
    super();
    if (!token || String(token).length < 16) throw new Error('A pairing token is required (TABMATE_TOKEN). Run: npx tabmate-mcp install --token <token from the Tabmate popup>');
    this.token = String(token);
    this.ports = ports;
    this.extensionId = extensionId;
    this.clientName = clientName;
    this.ws = null;
    this.port = 0;
    this.nextId = 1;
    this.pending = new Map();
  }

  get connected() {
    return !!this.ws;
  }

  setClientName(name) {
    this.clientName = String(name || 'Claude').slice(0, 40);
    this.sendRaw({ t: 'client', client: this.clientName });
  }

  async listen() {
    for (const port of this.ports) {
      if (await this.tryPort(port)) { this.port = port; return port; }
    }
    throw new Error('No free local port for Tabmate (' + this.ports[0] + '-' + this.ports[this.ports.length - 1] + ').');
  }

  tryPort(port) {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        // A tiny probe so the extension can look for us without noisy failed WebSockets.
        if (req.method === 'GET' && req.url === '/tabmate-mcp' && allowedHost(req, port)) {
          res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
          return res.end('tabmate-mcp');
        }
        res.writeHead(404);
        res.end();
      });
      const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
      server.on('upgrade', (req, socket, head) => {
        if (!allowedUpgrade(req, port, this.extensionId)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          return socket.destroy();
        }
        wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
      });
      server.once('error', () => resolve(false));
      server.listen(port, HOST, () => { this.server = server; this.wss = wss; resolve(true); });
    });
  }

  onSocket(ws) {
    const challenge = crypto.randomBytes(16).toString('hex');
    let authed = false;
    const timer = setTimeout(() => { if (!authed) ws.close(4001, 'auth timeout'); }, AUTH_TIMEOUT_MS);
    ws.send(JSON.stringify({ t: 'hello', v: 1, nonce: challenge }));
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(String(data)); } catch (e) { return ws.close(4002, 'bad json'); }
      if (!m || typeof m.t !== 'string') return;
      if (!authed) {
        if (m.t !== 'auth' || !sameHex(m.mac, hmac(this.token, 'tabmate-ext:' + challenge)) || typeof m.nonce !== 'string' || m.nonce.length < 16) {
          return ws.close(4003, 'not paired');
        }
        authed = true;
        clearTimeout(timer);
        ws.send(JSON.stringify({ t: 'ok', mac: hmac(this.token, 'tabmate-srv:' + m.nonce), client: this.clientName }));
        if (this.ws && this.ws !== ws) this.ws.close(1000, 'replaced');
        this.ws = ws;
        this.extensionVersion = String(m.version || '').slice(0, 20);
        this.startPing(ws);
        this.emit('connected');
        return;
      }
      if (m.t === 'res' && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(String(m.error)));
        else p.resolve(m.result);
      } else if (m.t === 'changed') this.emit('changed');
    });
    ws.on('close', () => {
      clearTimeout(timer);
      if (this.ws === ws) {
        this.ws = null;
        clearInterval(this.pinger);
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Tabmate disconnected')); }
        this.pending.clear();
        this.emit('disconnected');
      }
    });
    ws.on('error', () => {});
  }

  startPing(ws) {
    clearInterval(this.pinger);
    this.pinger = setInterval(() => { if (this.ws === ws) this.sendRaw({ t: 'ping' }); }, PING_MS);
    this.pinger.unref();
  }

  sendRaw(m) {
    if (this.ws) { try { this.ws.send(JSON.stringify(m)); } catch (e) { /* closed */ } }
  }

  request(method, params, timeoutMs = 120000) {
    if (!this.ws) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Tabmate did not answer in time')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sendRaw({ t: 'req', id, method, params });
    });
  }

  waitConnected(ms) {
    if (this.ws) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.off('connected', on); resolve(false); }, ms);
      const on = () => { clearTimeout(t); resolve(true); };
      this.once('connected', on);
    });
  }

  close() {
    if (this.ws) this.ws.close(1000, 'bye');
    if (this.wss) this.wss.close();
    if (this.server) { this.server.close(); if (this.server.closeAllConnections) this.server.closeAllConnections(); }
    clearInterval(this.pinger);
  }
}

function allowedHost(req, port) {
  const host = String(req.headers.host || '');
  return host === HOST + ':' + port || host === 'localhost:' + port;
}

module.exports = { ExtensionLink, PORTS, HOST, hmac, allowedUpgrade };
