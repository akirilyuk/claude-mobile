import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const xtermLib = path.dirname(require.resolve('@xterm/xterm'));
const fitLib = path.dirname(require.resolve('@xterm/addon-fit'));

const COOKIE = 'cm_session';
const JS = 'text/javascript; charset=utf-8';
const CSS = 'text/css; charset=utf-8';
const staticFiles = (publicDir) => ({
  '/': [path.join(publicDir, 'index.html'), 'text/html; charset=utf-8'],
  '/app.js': [path.join(publicDir, 'app.js'), JS],
  '/style.css': [path.join(publicDir, 'style.css'), CSS],
  '/vendor/xterm.js': [path.join(xtermLib, 'xterm.js'), JS],
  '/vendor/xterm.css': [path.join(xtermLib, '..', 'css', 'xterm.css'), CSS],
  '/vendor/addon-fit.js': [path.join(fitLib, 'addon-fit.js'), JS],
});
const SECURITY_HEADERS = {
  // xterm.js injects <style> elements, hence 'unsafe-inline' for styles only.
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};
const MAX_MESSAGE_CHARS = 100_000;

const FREE_ATTEMPTS = 3;
const BASE_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 3_600_000;

// Everything is reachable from the internet through the tunnel, so failed logins lock out
// all further attempts regardless of who made them: three tries are free, then every further
// failure doubles the cooldown (30s, 1m, 2m, … up to 1h). Held in memory, so a CLI restart clears it.
class LoginGuard {
  #failures = 0;
  #lockedUntil = 0;

  retryAfterMs() {
    return Math.max(0, this.#lockedUntil - Date.now());
  }

  fail() {
    this.#failures += 1;
    if (this.#failures >= FREE_ATTEMPTS) {
      this.#lockedUntil = Date.now() + Math.min(BASE_COOLDOWN_MS * 2 ** (this.#failures - FREE_ATTEMPTS), MAX_COOLDOWN_MS);
    }
  }

  succeed() {
    this.#failures = 0;
    this.#lockedUntil = 0;
  }
}

function readCookie(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === COOKIE) return value;
  }
  return null;
}

function readJson(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function createServer({ password, manager, terminals = null, workspace, publicDir }) {
  const STATIC = staticFiles(publicDir);
  const salt = randomBytes(16);
  const expected = scryptSync(password, salt, 32);
  const tokens = new Set();
  const guard = new LoginGuard();

  const authed = (req) => {
    const token = readCookie(req);
    return Boolean(token) && tokens.has(token);
  };

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && STATIC[pathname]) {
      const [file, type] = STATIC[pathname];
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type });
      res.end(fs.readFileSync(file));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/me') {
      json(res, 200, { authed: authed(req), workspace: path.basename(workspace), terminals: Boolean(terminals) });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/login') {
      const wait = guard.retryAfterMs();
      if (wait > 0) {
        json(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.` });
        return;
      }
      let body;
      try {
        body = await readJson(req);
      } catch {
        json(res, 400, { error: 'Bad request' });
        return;
      }
      const given = scryptSync(String(body.password ?? ''), salt, 32);
      if (!timingSafeEqual(given, expected)) {
        guard.fail();
        json(res, 401, { error: 'Wrong password' });
        return;
      }
      guard.succeed();
      const token = randomBytes(32).toString('hex');
      tokens.add(token);
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/${secure}` });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/logout') {
      tokens.delete(readCookie(req));
      json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      return;
    }

    json(res, 404, { error: 'Not found' });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    let sameOrigin = false;
    try {
      sameOrigin = new URL(req.headers.origin).host === req.headers.host;
    } catch {
      // Missing or malformed Origin: not a browser page of ours.
    }
    if (pathname !== '/ws' || !sameOrigin || !authed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const broadcast = (message) => {
    const data = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  };

  manager.on('session', (session) => broadcast({ t: 'session', session }));
  manager.on('event', (id, event) => broadcast({ t: 'event', id, event }));
  manager.on('delta', (id, text, kind) => broadcast({ t: 'delta', id, text, kind }));
  manager.on('deleted', (id) => broadcast({ t: 'deleted', id }));
  terminals?.on('terminal', (terminal) => broadcast({ t: 'terminal', terminal }));
  terminals?.on('data', (id, data) => broadcast({ t: 'term_data', id, data }));
  terminals?.on('deleted', (id) => broadcast({ t: 'term_deleted', id }));

  const handlers = {
    list: () => ({ t: 'sessions', sessions: manager.list() }),
    create: (m) => ({ t: 'created', session: manager.create({ title: m.title, permissionMode: m.permissionMode, prompt: m.prompt }) }),
    open: (m) => ({ t: 'history', id: m.id, ...manager.history(m.id) }),
    send: (m) => {
      if (typeof m.text !== 'string' || m.text.length > MAX_MESSAGE_CHARS) throw new Error('Message too long');
      manager.send(m.id, m.text);
    },
    permission: (m) => manager.resolvePermission(m.id, m.requestId, { decision: m.decision, answers: m.answers, message: m.message }),
    interrupt: (m) => manager.interrupt(m.id),
    close: (m) => manager.close(m.id),
    delete: (m) => manager.remove(m.id),
    rename: (m) => manager.rename(m.id, m.title),
  };
  if (terminals) {
    Object.assign(handlers, {
      term_create: (m) => ({ t: 'term_created', terminal: terminals.create({ cols: m.cols, rows: m.rows }) }),
      term_open: (m) => ({ t: 'term_history', id: m.id, data: terminals.history(m.id) }),
      term_input: (m) => terminals.write(m.id, m.data),
      term_resize: (m) => terminals.resize(m.id, m.cols, m.rows),
      term_close: (m) => terminals.remove(m.id),
    });
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', async (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        const handler = Object.hasOwn(handlers, message.t) ? handlers[message.t] : null;
        if (!handler) throw new Error('Unknown message type');
        const reply = await handler(message);
        if (reply) ws.send(JSON.stringify(reply));
      } catch (err) {
        ws.send(JSON.stringify({ t: 'error', message: err.message || 'Request failed' }));
      }
    });
    ws.send(JSON.stringify({ t: 'sessions', sessions: manager.list(), terminals: terminals?.list() ?? [] }));
  });

  // Keeps idle connections alive through the tunnel and drops dead phones.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  server.on('close', () => clearInterval(heartbeat));

  return server;
}
