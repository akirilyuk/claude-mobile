import { spawn } from 'node:child_process';

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const QUIC_FAILED = 'Failed to dial a quic connection';

function open(port, protocol, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = ['tunnel', '--no-autoupdate'];
    if (protocol) args.push('--protocol', protocol);
    args.push('--url', `http://127.0.0.1:${port}`);
    const child = spawn('cloudflared', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let output = '';

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new Error(`cloudflared could not connect the tunnel within ${timeoutMs / 1000}s.\n${output.slice(-600)}`)),
      timeoutMs,
    );

    const onData = (chunk) => {
      if (settled) return;
      output += chunk;
      // Networks that block UDP never get a QUIC connection; give up early so HTTP/2 can be tried.
      if (!protocol && output.includes(QUIC_FAILED)) {
        const err = new Error('QUIC connection to Cloudflare failed.');
        err.quicBlocked = true;
        fail(err);
        return;
      }
      const match = output.match(URL_RE);
      // The URL is announced before the tunnel is connected; wait until it can carry traffic.
      if (!match || !output.includes('Registered tunnel connection')) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url: match[0], child });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) =>
      fail(
        err.code === 'ENOENT'
          ? new Error('cloudflared is not installed. Install it (e.g. `brew install cloudflared`) or run with --no-tunnel.')
          : err,
      ),
    );
    child.on('exit', (code) => fail(new Error(`cloudflared exited with code ${code}.\n${output.slice(-600)}`)));
  });
}

// Opens a cloudflared quick tunnel to the local server and resolves with its public URL.
export async function startTunnel(port, { timeoutMs = 30000, onFallback } = {}) {
  try {
    return await open(port, null, timeoutMs);
  } catch (err) {
    if (!err.quicBlocked) throw err;
    onFallback?.();
    return open(port, 'http2', timeoutMs);
  }
}
