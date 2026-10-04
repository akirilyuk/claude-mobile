import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto'];

const MAX_TOOL_TEXT = 4000;
const PREVIEW_LEN = 140;

// Async iterable the SDK reads user messages from; we push into it as the phone sends them.
class InputQueue {
  #items = [];
  #waiters = [];
  #ended = false;

  push(value) {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#items.push(value);
  }

  end() {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#items.length) return Promise.resolve({ value: this.#items.shift(), done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function truncate(text, max = MAX_TOOL_TEXT) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('\n');
}

/**
 * Owns every Claude session of one workspace.
 *
 * Emits:
 *   'session' (meta)            metadata or status changed
 *   'event'   (id, event)       something was added to a session's log
 *   'delta'   (id, text, kind)  streamed 'text' or 'thinking' of the reply in progress, not persisted
 *   'deleted' (id)
 */
export class SessionManager extends EventEmitter {
  #sessions = new Map();

  constructor({ workspace, store, claudePath, queryFn = query }) {
    super();
    this.workspace = workspace;
    this.store = store;
    this.claudePath = claudePath;
    this.queryFn = queryFn;

    for (const meta of store.loadAll()) {
      // Nothing survives a restart of the CLI, so nothing is running yet.
      if (meta.status !== 'closed') {
        meta.status = 'closed';
        store.saveMeta(meta);
      }
      this.#sessions.set(meta.id, { meta, rt: null, seq: store.readEvents(meta.id).length });
    }
  }

  list() {
    return [...this.#sessions.values()].map((s) => s.meta);
  }

  create({ title, permissionMode = 'default', prompt } = {}) {
    if (!PERMISSION_MODES.includes(permissionMode)) throw new Error('Unknown permission mode');
    const now = Date.now();
    const text = typeof prompt === 'string' ? prompt.trim() : '';
    const meta = {
      id: randomUUID(),
      title: (title || '').trim().slice(0, 80) || text.slice(0, 48) || `Session ${this.#sessions.size + 1}`,
      status: 'idle',
      permissionMode,
      claudeSessionId: null,
      model: null,
      preview: '',
      costUsd: 0,
      createdAt: now,
      updatedAt: now,
    };
    const session = { meta, rt: null, seq: 0 };
    this.#sessions.set(meta.id, session);
    this.store.saveMeta(meta);
    this.emit('session', meta);
    if (text) this.send(meta.id, text);
    return meta;
  }

  history(id) {
    const session = this.#get(id);
    return {
      events: this.store.readEvents(id),
      pending: session.rt ? [...session.rt.pending.keys()] : [],
    };
  }

  send(id, text) {
    const session = this.#get(id);
    if (typeof text !== 'string' || !text.trim()) throw new Error('Empty message');
    if (!session.rt) this.#start(session);
    this.#record(session, { kind: 'user', text });
    session.meta.preview = text.slice(0, PREVIEW_LEN);
    session.rt.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    if (session.rt.pending.size === 0) this.#setStatus(session, 'working');
  }

  resolvePermission(id, requestId, { decision, answers, message } = {}) {
    const session = this.#get(id);
    const pending = session.rt?.pending.get(requestId);
    if (!pending) throw new Error('That request is no longer waiting');
    session.rt.pending.delete(requestId);

    if (decision === 'allow' || decision === 'always') {
      const result = { behavior: 'allow', updatedInput: pending.input };
      if (answers && typeof answers === 'object') result.updatedInput = { ...pending.input, answers };
      if (decision === 'always' && pending.suggestions) result.updatedPermissions = pending.suggestions;
      pending.resolve(result);
    } else {
      decision = 'deny';
      pending.resolve({ behavior: 'deny', message: (message || '').trim() || 'The user denied this request.' });
    }
    this.#record(session, { kind: 'permission_resolved', requestId, decision });
    this.#setStatus(session, session.rt.pending.size ? 'needs_input' : 'working');
  }

  async interrupt(id) {
    const session = this.#get(id);
    if (session.rt) await session.rt.q.interrupt();
  }

  close(id) {
    const session = this.#get(id);
    this.#stop(session);
    this.#setStatus(session, 'closed');
  }

  remove(id) {
    const session = this.#get(id);
    this.#stop(session);
    this.#sessions.delete(id);
    this.store.remove(id);
    this.emit('deleted', id);
  }

  rename(id, title) {
    const session = this.#get(id);
    const clean = String(title || '').trim().slice(0, 80);
    if (!clean) throw new Error('Title cannot be empty');
    session.meta.title = clean;
    this.#touch(session);
  }

  shutdown() {
    for (const session of this.#sessions.values()) {
      if (!session.rt) continue;
      this.#stop(session);
      session.meta.status = 'closed';
      this.store.saveMeta(session.meta);
    }
  }

  #get(id) {
    const session = this.#sessions.get(id);
    if (!session) throw new Error('Unknown session');
    return session;
  }

  #touch(session) {
    session.meta.updatedAt = Date.now();
    this.store.saveMeta(session.meta);
    this.emit('session', session.meta);
  }

  #setStatus(session, status) {
    session.meta.status = status;
    this.#touch(session);
  }

  #record(session, data) {
    const event = { seq: session.seq++, ts: Date.now(), ...data };
    this.store.appendEvent(session.meta.id, event);
    this.emit('event', session.meta.id, event);
    return event;
  }

  #start(session) {
    const input = new InputQueue();
    const rt = { input, q: null, pending: new Map(), stopped: false };
    const options = {
      cwd: this.workspace,
      permissionMode: session.meta.permissionMode,
      includePartialMessages: true,
      // Ask for thinking text; without this newer models return thinking blocks with no content.
      thinking: { type: 'adaptive', display: 'summarized' },
      canUseTool: (toolName, toolInput, opts) => this.#ask(session, rt, toolName, toolInput, opts),
    };
    if (session.meta.claudeSessionId) options.resume = session.meta.claudeSessionId;
    if (this.claudePath) options.pathToClaudeCodeExecutable = this.claudePath;
    rt.q = this.queryFn({ prompt: input, options });
    session.rt = rt;
    this.#pump(session, rt);
  }

  #stop(session) {
    const rt = session.rt;
    if (!rt) return;
    rt.stopped = true;
    session.rt = null;
    this.#cancelPending(session, rt);
    rt.input.end();
    try {
      rt.q.close();
    } catch {
      // Already gone.
    }
  }

  #cancelPending(session, rt) {
    for (const [requestId, pending] of rt.pending) {
      pending.resolve({ behavior: 'deny', message: 'The session was stopped.' });
      this.#record(session, { kind: 'permission_resolved', requestId, decision: 'cancelled' });
    }
    rt.pending.clear();
  }

  // Claude wants to run a tool that needs approval, or is asking the user a question.
  #ask(session, rt, toolName, toolInput, opts) {
    return new Promise((resolve) => {
      const requestId = randomUUID();
      rt.pending.set(requestId, { resolve, input: toolInput, suggestions: opts.suggestions });
      opts.signal.addEventListener('abort', () => {
        if (!rt.pending.delete(requestId)) return;
        resolve({ behavior: 'deny', message: 'Cancelled.' });
        this.#record(session, { kind: 'permission_resolved', requestId, decision: 'cancelled' });
        if (session.rt === rt) this.#setStatus(session, rt.pending.size ? 'needs_input' : 'working');
      });
      this.#record(session, {
        kind: 'permission_request',
        requestId,
        toolName,
        input: toolInput,
        title: opts.title,
        canAlways: Boolean(opts.suggestions?.length),
      });
      session.meta.preview = opts.title || `Wants to use ${toolName}`;
      this.#setStatus(session, 'needs_input');
    });
  }

  async #pump(session, rt) {
    let failure = null;
    try {
      for await (const msg of rt.q) {
        if (rt.stopped) break;
        this.#handle(session, rt, msg);
      }
    } catch (err) {
      failure = err;
    }
    if (rt.stopped || session.rt !== rt) return;

    // The Claude process ended without us asking it to.
    session.rt = null;
    rt.input.end();
    this.#cancelPending(session, rt);
    if (failure) {
      this.#record(session, { kind: 'error', text: failure.message || String(failure) });
      this.#setStatus(session, 'error');
    } else {
      this.#setStatus(session, 'closed');
    }
  }

  #handle(session, rt, msg) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          session.meta.claudeSessionId = msg.session_id;
          session.meta.model = msg.model;
          this.#touch(session);
        }
        break;

      case 'stream_event': {
        if (msg.parent_tool_use_id) break;
        const ev = msg.event;
        if (ev.type !== 'content_block_delta') break;
        if (ev.delta.type === 'text_delta') this.emit('delta', session.meta.id, ev.delta.text, 'text');
        else if (ev.delta.type === 'thinking_delta') this.emit('delta', session.meta.id, ev.delta.thinking, 'thinking');
        break;
      }

      case 'assistant': {
        // Subagent chatter stays out of the phone transcript; its Agent tool call and result are shown.
        if (msg.parent_tool_use_id) break;
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            this.#record(session, { kind: 'assistant', text: block.text });
            session.meta.preview = block.text.slice(0, PREVIEW_LEN);
          } else if (block.type === 'thinking' && block.thinking.trim()) {
            this.#record(session, { kind: 'thinking', text: block.thinking });
          } else if (block.type === 'tool_use') {
            this.#record(session, { kind: 'tool_use', toolId: block.id, name: block.name, input: block.input });
          }
        }
        this.#touch(session);
        break;
      }

      case 'user': {
        if (msg.parent_tool_use_id || !Array.isArray(msg.message.content)) break;
        for (const block of msg.message.content) {
          if (block.type !== 'tool_result') continue;
          this.#record(session, {
            kind: 'tool_result',
            toolId: block.tool_use_id,
            text: truncate(toolResultText(block.content)),
            isError: Boolean(block.is_error),
          });
        }
        break;
      }

      case 'result': {
        session.meta.costUsd = msg.total_cost_usd;
        const failed = msg.subtype !== 'success' || msg.is_error;
        this.#record(session, {
          kind: 'result',
          ok: !failed,
          subtype: msg.subtype,
          durationMs: msg.duration_ms,
          costUsd: msg.total_cost_usd,
          text: failed ? (msg.subtype === 'success' ? msg.result : msg.errors.join('\n')) : undefined,
        });
        if (rt.pending.size) this.#setStatus(session, 'needs_input');
        else this.#setStatus(session, msg.queued_turn_count > 0 ? 'working' : 'idle');
        break;
      }
    }
  }
}
