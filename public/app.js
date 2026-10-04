const $ = (id) => document.getElementById(id);

const STATUS = {
  needs_input: 'Needs your input',
  working: 'Working',
  idle: 'Idle',
  error: 'Error',
  closed: 'Stopped',
};
const STATUS_ORDER = ['needs_input', 'working', 'error', 'idle', 'closed'];

const state = {
  sessions: new Map(),
  terminals: new Map(),
  term: null, // id of the terminal open in the terminal view
  termReady: false, // scrollback received; live output may be written
  current: null, // id of the session open in the chat view
  pending: new Set(), // permission requests still waiting for an answer
  tools: new Map(), // toolId -> <details> element
  asks: new Map(), // requestId -> card element
  streaming: null, // bubble holding streamed text of the reply in progress
  thinking: null, // same for streamed thinking
  ws: null,
  retry: 0,
};

// ---------- helpers ----------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Small markdown subset: fenced code, inline code, bold, headings, links. Input is escaped first.
function markdown(text) {
  return text
    .split(/```/)
    .map((part, i) => {
      if (i % 2) return `<pre><code>${escapeHtml(part.replace(/^[\w+-]*\n/, ''))}</code></pre>`;
      return escapeHtml(part)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/^#{1,6} (.+)$/gm, '<h3>$1</h3>')
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    })
    .join('');
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

let toastTimer;
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 4000);
}

function show(view) {
  for (const id of ['login', 'list', 'chat', 'term']) $(id).hidden = id !== view;
}

function closeOverlays() {
  for (const id of ['backdrop', 'drawer', 'sheet-new', 'sheet-actions']) $(id).hidden = true;
}

function openOverlay(id) {
  closeOverlays();
  $('backdrop').hidden = false;
  $(id).hidden = false;
}

// ---------- connection ----------

function send(message) {
  if (state.ws?.readyState !== WebSocket.OPEN) {
    toast('Not connected. Reconnecting…');
    return false;
  }
  state.ws.send(JSON.stringify(message));
  return true;
}

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    state.retry = 0;
    $('conn').classList.add('on');
    if (state.current) send({ t: 'open', id: state.current });
    if (state.term) attachTerm();
  };
  ws.onmessage = (e) => receive(JSON.parse(e.data));
  ws.onclose = async () => {
    $('conn').classList.remove('on');
    if (state.ws !== ws) return;
    // A rejected socket usually means the CLI restarted and our cookie is no longer valid.
    const me = await fetch('/api/me').then((r) => r.json()).catch(() => null);
    if (me && !me.authed) {
      showLogin(me);
      return;
    }
    state.retry = Math.min(state.retry + 1, 6);
    setTimeout(connect, 500 * 2 ** state.retry);
  };
}

function receive(m) {
  switch (m.t) {
    case 'sessions':
      state.sessions = new Map(m.sessions.map((s) => [s.id, s]));
      state.terminals = new Map(m.terminals.map((t) => [t.id, t]));
      if (state.term && !state.terminals.has(state.term)) openList();
      renderLists();
      break;
    case 'terminal':
      state.terminals.set(m.terminal.id, m.terminal);
      renderLists();
      break;
    case 'term_created':
      state.terminals.set(m.terminal.id, m.terminal);
      openTerm(m.terminal.id);
      break;
    case 'term_deleted':
      state.terminals.delete(m.id);
      if (state.term === m.id) openList();
      renderLists();
      break;
    case 'term_history':
      if (m.id !== state.term) break;
      xterm.reset();
      xterm.write(m.data);
      state.termReady = true;
      break;
    case 'term_data':
      if (m.id === state.term && state.termReady) xterm.write(m.data);
      break;
    case 'session':
      state.sessions.set(m.session.id, m.session);
      renderLists();
      break;
    case 'created':
      state.sessions.set(m.session.id, m.session);
      openChat(m.session.id);
      break;
    case 'deleted':
      state.sessions.delete(m.id);
      if (state.current === m.id) openList();
      renderLists();
      break;
    case 'history':
      if (m.id !== state.current) break;
      resetChat();
      state.pending = new Set(m.pending);
      for (const event of m.events) renderEvent(event);
      scrollDown(true);
      break;
    case 'event':
      if (m.id !== state.current) break;
      if (m.event.kind === 'permission_request') state.pending.add(m.event.requestId);
      renderEvent(m.event);
      scrollDown();
      break;
    case 'delta':
      if (m.id !== state.current) break;
      if (m.kind === 'thinking') {
        if (!state.thinking) {
          state.thinking = el('div', { class: 'msg thinking streaming' });
          $('messages').append(state.thinking);
        }
        state.thinking.textContent += m.text;
        scrollDown();
        break;
      }
      if (!state.streaming) {
        state.streaming = el('div', { class: 'msg assistant streaming' });
        state.streaming.raw = '';
        $('messages').append(state.streaming);
      }
      state.streaming.raw += m.text;
      state.streaming.innerHTML = markdown(state.streaming.raw);
      scrollDown();
      break;
    case 'error':
      toast(m.message);
      break;
  }
}

// ---------- overview ----------

function sortedSessions() {
  return [...state.sessions.values()].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || b.updatedAt - a.updatedAt,
  );
}

function card(session) {
  return el(
    'button',
    {
      class: `card s-${session.status}${session.id === state.current ? ' current' : ''}`,
      onclick: () => openChat(session.id),
    },
    [
      el('span', { class: 'dot' }),
      el('div', { class: 'card-body' }, [
        el('div', { class: 'card-top' }, [
          el('span', { class: 'card-title', text: session.title }),
          el('span', { class: 'muted', text: ago(session.updatedAt) }),
        ]),
        session.preview ? el('div', { class: 'card-preview', text: session.preview }) : null,
        el('div', { class: 'card-meta', text: STATUS[session.status] }),
      ]),
    ],
  );
}

function renderLists() {
  const sessions = sortedSessions();
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
  for (const s of sessions) counts[s.status] += 1;

  $('summary').replaceChildren(
    ...STATUS_ORDER.map((s) =>
      el('span', { class: `chip s-${s}${counts[s] ? '' : ' zero'}` }, [el('b', { text: String(counts[s]) }), STATUS[s]]),
    ),
  );
  $('cards').replaceChildren(
    ...(sessions.length
      ? sessions.map(card)
      : [el('div', { class: 'empty', text: 'No sessions yet. Tap ＋ to start one in this workspace.' })]),
  );
  const terminals = [...state.terminals.values()].sort((a, b) => a.createdAt - b.createdAt);
  if (terminals.length) {
    $('cards').append(el('div', { class: 'section', text: 'Terminals' }), ...terminals.map(termCard));
  }
  $('drawer-list').replaceChildren(
    ...sessions.map(card),
    ...(terminals.length ? [el('div', { class: 'section', text: 'Terminals' }), ...terminals.map(termCard)] : []),
  );

  const waitingElsewhere = sessions.filter((s) => s.status === 'needs_input' && s.id !== state.current).length;
  $('attention').hidden = !waitingElsewhere;
  $('attention').textContent = String(waitingElsewhere);
  document.title = counts.needs_input ? `(${counts.needs_input}) claude-mobile` : 'claude-mobile';

  renderChatHeader();
  renderTermHeader();
}

function openList() {
  state.current = null;
  state.term = null;
  closeOverlays();
  show('list');
  renderLists();
}

// ---------- chat ----------

function renderChatHeader() {
  const session = state.sessions.get(state.current);
  if (!session) return;
  $('chat-title').textContent = session.title;
  $('chat-status').textContent = STATUS[session.status];
  $('chat-status').className = `status-label s-${session.status}`;
  $('stop').hidden = session.status !== 'working';
}

function resetChat() {
  $('messages').replaceChildren();
  state.pending.clear();
  state.tools.clear();
  state.asks.clear();
  state.streaming = null;
  state.thinking = null;
}

function openChat(id) {
  state.term = null;
  state.current = id;
  closeOverlays();
  resetChat();
  show('chat');
  renderLists();
  send({ t: 'open', id });
}

function scrollDown(force = false) {
  const box = $('messages');
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 240) box.scrollTop = box.scrollHeight;
}

function toolSummary(input) {
  const value = input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.url ?? input.query ?? input.prompt;
  return typeof value === 'string' ? value.split('\n')[0].slice(0, 120) : '';
}

function askCard(event) {
  const open = state.pending.has(event.requestId);
  const box = el('div', { class: `ask${open ? '' : ' done'}` });
  const answer = (payload) => send({ t: 'permission', id: state.current, requestId: event.requestId, ...payload });
  const questions = event.toolName === 'AskUserQuestion' && Array.isArray(event.input.questions) ? event.input.questions : null;

  if (questions) {
    const groups = questions.map((q, qi) => {
      const group = el('div', {}, [el('div', { class: 'ask-title', text: q.question })]);
      for (const option of q.options) {
        group.append(
          el('label', { class: 'option' }, [
            el('input', { type: q.multiSelect ? 'checkbox' : 'radio', name: `${event.requestId}-${qi}`, value: option.label }),
            el('span', {}, [option.label, el('small', { text: option.description })]),
          ]),
        );
      }
      const other = el('input', { type: 'text', placeholder: 'Or type your own answer' });
      group.append(other);
      return { q, group, other };
    });
    box.append(...groups.map((g) => g.group));
    if (open) {
      box.append(
        el('div', { class: 'ask-buttons' }, [
          el('button', {
            class: 'primary',
            text: 'Send answers',
            onclick: () => {
              const answers = {};
              for (const { q, group, other } of groups) {
                const picked = [...group.querySelectorAll('input:checked')].map((i) => i.value);
                if (other.value.trim()) picked.push(other.value.trim());
                if (!picked.length) return toast('Answer every question first');
                answers[q.question] = picked.join(', ');
              }
              answer({ decision: 'allow', answers });
            },
          }),
          el('button', { text: 'Skip', onclick: () => answer({ decision: 'deny', message: 'The user declined to answer.' }) }),
        ]),
      );
    }
  } else {
    box.append(
      el('div', { class: 'ask-title', text: event.title || `Claude wants to use ${event.toolName}` }),
      el('pre', { text: toolSummary(event.input) || JSON.stringify(event.input, null, 2) }),
    );
    if (open) {
      box.append(
        el('div', { class: 'ask-buttons' }, [
          el('button', { class: 'primary', text: 'Allow', onclick: () => answer({ decision: 'allow' }) }),
          event.canAlways ? el('button', { text: 'Always allow', onclick: () => answer({ decision: 'always' }) }) : null,
          el('button', { class: 'danger', text: 'Deny', onclick: () => answer({ decision: 'deny' }) }),
        ]),
      );
    }
  }
  box.append(el('div', { class: 'muted ask-state', text: open ? '' : 'No longer waiting' }));
  return box;
}

function renderEvent(event) {
  const box = $('messages');
  switch (event.kind) {
    case 'user':
      box.append(el('div', { class: 'msg user', text: event.text }));
      break;

    case 'assistant': {
      state.streaming?.remove();
      state.streaming = null;
      const node = el('div', { class: 'msg assistant' });
      node.innerHTML = markdown(event.text);
      box.append(node);
      break;
    }

    case 'thinking': {
      state.thinking?.remove();
      state.thinking = null;
      const firstLine = event.text.trim().split('\n')[0].slice(0, 90);
      box.append(
        el('details', { class: 'tool thought' }, [
          el('summary', {}, [el('b', { text: 'Thinking' }), ` ${firstLine}`]),
          el('div', { class: 'msg thinking', text: event.text }),
        ]),
      );
      break;
    }

    case 'tool_use': {
      const summary = el('summary', {}, [el('b', { text: event.name }), ` ${toolSummary(event.input)}`]);
      const details = el('details', { class: 'tool' }, [summary, el('pre', { text: JSON.stringify(event.input, null, 2) })]);
      state.tools.set(event.toolId, details);
      box.append(details);
      break;
    }

    case 'tool_result': {
      const details = state.tools.get(event.toolId);
      if (!details) break;
      if (event.isError) details.classList.add('failed');
      details.append(el('pre', { text: event.text || '(no output)' }));
      break;
    }

    case 'permission_request': {
      const node = askCard(event);
      state.asks.set(event.requestId, node);
      box.append(node);
      break;
    }

    case 'permission_resolved': {
      state.pending.delete(event.requestId);
      const node = state.asks.get(event.requestId);
      if (!node) break;
      node.classList.add('done');
      node.querySelector('.ask-buttons')?.remove();
      const labels = { allow: 'Allowed', always: 'Always allowed', deny: 'Denied', cancelled: 'Cancelled' };
      node.querySelector('.ask-state').textContent = labels[event.decision] || event.decision;
      break;
    }

    case 'result':
      state.streaming?.remove();
      state.streaming = null;
      state.thinking?.remove();
      state.thinking = null;
      if (event.ok) {
        box.append(el('div', { class: 'msg note', text: `Done in ${Math.round(event.durationMs / 1000)}s · $${event.costUsd.toFixed(2)} total` }));
      } else {
        box.append(el('div', { class: 'msg note bad', text: event.text || `Turn ended: ${event.subtype}` }));
      }
      break;

    case 'error':
      box.append(el('div', { class: 'msg note bad', text: event.text }));
      break;
  }
}

// ---------- terminal ----------

const KEY_SEQ = { esc: '\x1b', tab: '\t', 'ctrl-c': '\x03', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' };
let xterm = null;
let fit = null;
let ctrlArmed = false;

function termStatus(terminal) {
  return terminal.status === 'running' ? 'Running' : `Exited (${terminal.exitCode})`;
}

function termCard(terminal) {
  const cls = terminal.status === 'running' ? 's-idle' : 's-closed';
  return el(
    'button',
    { class: `card ${cls}${terminal.id === state.term ? ' current' : ''}`, onclick: () => openTerm(terminal.id) },
    [
      el('span', { class: 'dot' }),
      el('div', { class: 'card-body' }, [
        el('div', { class: 'card-top' }, [
          el('span', { class: 'card-title', text: terminal.title }),
          el('span', { class: 'muted', text: ago(terminal.updatedAt) }),
        ]),
        el('div', { class: 'card-meta', text: termStatus(terminal) }),
      ]),
    ],
  );
}

function renderTermHeader() {
  const terminal = state.terminals.get(state.term);
  if (!terminal) return;
  $('term-title').textContent = terminal.title;
  $('term-status').textContent = termStatus(terminal);
  $('term-status').className = `status-label ${terminal.status === 'running' ? 's-idle' : 's-closed'}`;
}

function setCtrl(on) {
  ctrlArmed = on;
  $('key-ctrl').classList.toggle('on', on);
}

function termInput(data) {
  if (ctrlArmed && data.length === 1) {
    // Ctrl+letter is the letter's code with the top bits cleared (Ctrl+C -> 0x03).
    data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 0x1f);
    setCtrl(false);
  }
  if (state.term) send({ t: 'term_input', id: state.term, data });
}

function ensureXterm() {
  if (xterm) return;
  xterm = new Terminal({
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#000000' },
  });
  fit = new FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open($('xterm'));
  xterm.onData(termInput);
  xterm.onResize(({ cols, rows }) => {
    if (state.term) send({ t: 'term_resize', id: state.term, cols, rows });
  });
}

function attachTerm() {
  state.termReady = false;
  fit.fit();
  send({ t: 'term_resize', id: state.term, cols: xterm.cols, rows: xterm.rows });
  send({ t: 'term_open', id: state.term });
}

function openTerm(id) {
  state.current = null;
  state.term = id;
  closeOverlays();
  show('term');
  ensureXterm();
  xterm.reset();
  renderLists();
  attachTerm();
  xterm.focus();
}

function newTerminal() {
  // Size the first prompt for a phone; the real size follows once the view is open.
  send({ t: 'term_create', cols: 48, rows: 24 });
}

$('new-terminal').addEventListener('click', newTerminal);
$('term-back').addEventListener('click', openList);
$('term-switcher').addEventListener('click', () => openOverlay('drawer'));
$('term-close').addEventListener('click', () => {
  const terminal = state.terminals.get(state.term);
  if (!terminal) return;
  if (terminal.status !== 'running' || confirm(`Close "${terminal.title}" and end its shell?`)) {
    send({ t: 'term_close', id: terminal.id });
  }
});
$('keys').addEventListener('click', (e) => {
  const seq = e.target.dataset?.seq;
  if (!seq) return;
  if (seq === 'ctrl') setCtrl(!ctrlArmed);
  else termInput(KEY_SEQ[seq] ?? seq);
  xterm.focus();
});

// Keep the layout above the on-screen keyboard and the terminal sized to what is visible.
function onViewport() {
  if (window.visualViewport) document.documentElement.style.setProperty('--vh', `${window.visualViewport.height}px`);
  if (state.term && xterm) fit.fit();
}
window.visualViewport?.addEventListener('resize', onViewport);
window.addEventListener('resize', onViewport);

// ---------- wiring ----------

function showLogin(me) {
  $('login-workspace').textContent = me?.workspace ? `Workspace: ${me.workspace}` : '';
  show('login');
  $('login-password').focus();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('login-password').value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    $('login-error').textContent = body.error || 'Sign-in failed';
    $('login-error').hidden = false;
    return;
  }
  $('login-password').value = '';
  $('login-error').hidden = true;
  openList();
  connect();
});

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  const ws = state.ws;
  state.ws = null;
  ws?.close();
  showLogin();
});

$('new-session').addEventListener('click', () => openOverlay('sheet-new'));
$('new-form').addEventListener('submit', (e) => {
  e.preventDefault();
  send({ t: 'create', title: $('new-title').value, prompt: $('new-prompt').value, permissionMode: $('new-mode').value });
  $('new-title').value = '';
  $('new-prompt').value = '';
  closeOverlays();
});

$('back').addEventListener('click', openList);
$('switcher').addEventListener('click', () => openOverlay('drawer'));
$('actions').addEventListener('click', () => openOverlay('sheet-actions'));
$('backdrop').addEventListener('click', closeOverlays);

$('sheet-actions').addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  const session = state.sessions.get(state.current);
  if (!action || !session) return;
  closeOverlays();
  if (action === 'rename') {
    const title = prompt('Session name', session.title);
    if (title?.trim()) send({ t: 'rename', id: session.id, title });
  } else if (action === 'delete') {
    if (confirm(`Delete "${session.title}" and its saved history?`)) send({ t: 'delete', id: session.id });
  } else {
    send({ t: action, id: session.id });
  }
});

$('stop').addEventListener('click', () => send({ t: 'interrupt', id: state.current }));

const input = $('input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
});
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || !state.current) return;
  if (!send({ t: 'send', id: state.current, text })) return;
  input.value = '';
  input.style.height = 'auto';
  scrollDown(true);
});

// Refresh the "5m" labels on the overview.
setInterval(() => {
  if (!$('list').hidden) renderLists();
}, 30_000);

const me = await fetch('/api/me').then((r) => r.json());
$('list-workspace').textContent = me.workspace;
$('new-terminal').hidden = !me.terminals;
if (me.authed) {
  openList();
  connect();
} else {
  showLogin(me);
}
