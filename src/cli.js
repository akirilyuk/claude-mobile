import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';
import { Store } from './store.js';
import { SessionManager } from './sessions.js';
import { TerminalManager } from './terminals.js';
import { createServer } from './server.js';
import { startTunnel } from './tunnel.js';

const MIN_PASSWORD = 8;

const HELP = `Usage: claude-mobile [options]

Run Claude Code sessions in the current directory and control them from your phone.

Options:
  --port <n>     Local port to listen on (default: a free port)
  --no-tunnel    Do not open a cloudflared tunnel; serve on localhost only
  --no-terminal  Do not offer shell terminals in the web app
  -h, --help     Show this help

The password is asked for on start. For non-interactive use set CLAUDE_MOBILE_PASSWORD.
Session history is stored in .claude-mobile/ inside the workspace.`;

function parseArgs(argv) {
  const opts = { port: 0, tunnel: true, terminal: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') opts.port = Number(argv[++i]);
    else if (arg === '--no-tunnel') opts.tunnel = false;
    else if (arg === '--no-terminal') opts.terminal = false;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else throw new Error(`Unknown option ${arg}. See --help.`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error('--port must be a port number');
  return opts;
}

function promptHidden(label) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      reject(new Error('No terminal to ask for a password on. Set CLAUDE_MOBILE_PASSWORD instead.'));
      return;
    }
    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const done = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          done();
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          done();
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function getPassword() {
  const fromEnv = process.env.CLAUDE_MOBILE_PASSWORD;
  if (fromEnv !== undefined) {
    // Keep it out of the environment the Claude sessions and terminals inherit.
    delete process.env.CLAUDE_MOBILE_PASSWORD;
    if (fromEnv.length < MIN_PASSWORD) throw new Error(`CLAUDE_MOBILE_PASSWORD must be at least ${MIN_PASSWORD} characters.`);
    return fromEnv;
  }
  for (;;) {
    const password = await promptHidden(`Password for this run (min ${MIN_PASSWORD} characters): `);
    if (password.length >= MIN_PASSWORD) return password;
    console.log(`Too short. Anyone with this password can run code on this machine.`);
  }
}

function findClaude() {
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const workspace = process.cwd();
  const password = await getPassword();

  const store = new Store(workspace);
  const manager = new SessionManager({ workspace, store, claudePath: findClaude() });
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  const terminals = opts.terminal ? new TerminalManager({ workspace }) : null;
  const server = createServer({ password, manager, terminals, workspace, publicDir });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const localUrl = `http://127.0.0.1:${port}`;

  let tunnel = null;
  const shutdown = () => {
    manager.shutdown();
    terminals?.shutdown();
    tunnel?.child.kill();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`\nWorkspace: ${workspace}`);
  console.log(`Local:     ${localUrl}`);

  if (opts.tunnel) {
    console.log('Opening cloudflared tunnel…');
    try {
      tunnel = await startTunnel(port, {
        onFallback: () => console.log('QUIC is blocked on this network, retrying over HTTP/2…'),
      });
    } catch (err) {
      manager.shutdown();
      server.close();
      throw err;
    }
    tunnel.child.on('exit', () => {
      console.error('\ncloudflared exited; the phone link no longer works. Restart claude-mobile.');
    });
    console.log(`Public:    ${tunnel.url}\n`);
    qrcode.generate(tunnel.url, { small: true });
    console.log('Scan the QR code with your phone and sign in with the password.');
  }

  manager.on('session', (meta) => {
    if (meta.status === 'needs_input') console.log(`[needs input] ${meta.title}`);
  });
  console.log(`${manager.list().length} saved session(s). Press Ctrl+C to stop.\n`);
}
