import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SCROLLBACK_CHARS = 200_000;

// node-pty 1.1.0 ships its macOS spawn-helper without the execute bit, which makes every
// spawn fail with "posix_spawnp failed". Restore it before first use.
function fixSpawnHelper() {
  try {
    const helper = path.join(
      path.dirname(require.resolve('node-pty')),
      '..',
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper',
    );
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  } catch {
    // Built from source or a different layout: nothing to fix.
  }
}

function clampSize(value, fallback, max) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 2 ? Math.min(n, max) : fallback;
}

/**
 * Shell terminals running in the workspace. They live only as long as the CLI does;
 * output is kept in memory so a phone that reconnects sees the recent scrollback.
 *
 * Emits:
 *   'terminal' (info)        created, renamed or exited
 *   'data'     (id, chunk)   output from the shell
 *   'deleted'  (id)
 */
export class TerminalManager extends EventEmitter {
  #terminals = new Map();
  #pty = null;
  #count = 0;

  constructor({ workspace }) {
    super();
    this.workspace = workspace;
  }

  list() {
    return [...this.#terminals.values()].map((t) => t.info);
  }

  create({ cols, rows } = {}) {
    if (!this.#pty) {
      fixSpawnHelper();
      this.#pty = require('node-pty');
    }
    const shell = process.env.SHELL || '/bin/sh';
    const proc = this.#pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: clampSize(cols, 80, 500),
      rows: clampSize(rows, 24, 200),
      cwd: this.workspace,
      env: process.env,
    });
    const now = Date.now();
    const info = {
      id: randomUUID(),
      title: `Terminal ${++this.#count}`,
      status: 'running',
      exitCode: null,
      createdAt: now,
      updatedAt: now,
    };
    const terminal = { info, proc, buffer: '' };
    this.#terminals.set(info.id, terminal);

    proc.onData((chunk) => {
      terminal.buffer += chunk;
      if (terminal.buffer.length > SCROLLBACK_CHARS) terminal.buffer = terminal.buffer.slice(-SCROLLBACK_CHARS);
      this.emit('data', info.id, chunk);
    });
    proc.onExit(({ exitCode }) => {
      if (!this.#terminals.has(info.id)) return;
      info.status = 'exited';
      info.exitCode = exitCode;
      info.updatedAt = Date.now();
      this.emit('terminal', info);
    });

    this.emit('terminal', info);
    return info;
  }

  history(id) {
    return this.#get(id).buffer;
  }

  write(id, data) {
    const terminal = this.#get(id);
    if (typeof data !== 'string') throw new Error('Bad input');
    if (terminal.info.status === 'running') terminal.proc.write(data);
  }

  resize(id, cols, rows) {
    const terminal = this.#get(id);
    if (terminal.info.status !== 'running') return;
    terminal.proc.resize(clampSize(cols, 80, 500), clampSize(rows, 24, 200));
  }

  remove(id) {
    const terminal = this.#get(id);
    this.#terminals.delete(id);
    if (terminal.info.status === 'running') terminal.proc.kill();
    this.emit('deleted', id);
  }

  shutdown() {
    for (const terminal of this.#terminals.values()) {
      if (terminal.info.status === 'running') terminal.proc.kill();
    }
    this.#terminals.clear();
  }

  #get(id) {
    const terminal = this.#terminals.get(id);
    if (!terminal) throw new Error('Unknown terminal');
    return terminal;
  }
}
