# claude-mobile

Run and orchestrate several Claude Code sessions in one workspace from your phone.

```bash
npm install
npm link            # once, makes `claude-mobile` available everywhere

cd ~/code/my-project
claude-mobile
```

1. You are asked for a password for this run (at least 8 characters).
2. A cloudflared quick tunnel is opened and its URL is shown as a QR code.
3. Scan it with your phone, enter the password, and start sessions.

## What you get

- **Overview** of all sessions with their state: needs your input, working, idle, error, stopped.
- **Chat** per session: streamed replies, tool calls and results, a stop button.
- **Approvals on the phone**: tool permission prompts (allow / always allow / deny) and Claude's multiple-choice questions.
- **Session switcher** in the chat header, with a badge when another session is waiting for you.
- **Stop** a session (history kept, the next message resumes it) or **delete** it.
- **Terminals**: tap `>_` to open a shell in the workspace, with a key bar for esc, tab, ctrl and arrows.
  Terminals keep running while you look at something else and end when you close them or stop the CLI.

## Options

| Flag | Meaning |
|------|---------|
| `--port <n>` | Local port (default: a free one) |
| `--no-tunnel` | Serve on `127.0.0.1` only, no cloudflared |
| `--no-terminal` | Do not offer shell terminals in the web app |

`CLAUDE_MOBILE_PASSWORD` sets the password without a prompt.

## Requirements

- Node.js 20+
- `claude` (Claude Code) installed and signed in
- `cloudflared` on `PATH` (`brew install cloudflared`)

## Storage

Everything is kept in `.claude-mobile/sessions/` inside the workspace: `<id>.json` holds a session's
metadata and `<id>.jsonl` its full input and output. The folder ignores itself in git. After a restart
sessions show as stopped; sending a message resumes the underlying Claude conversation.

## Security

Whoever has the URL and the password can run code on your machine through Claude.

- The server listens on `127.0.0.1` only; the tunnel is the only way in.
- The password lives in memory for one run. After three wrong attempts sign-in is locked for 30 seconds, and every further wrong attempt doubles the wait (up to an hour). Restarting the CLI clears it.
- The WebSocket needs the sign-in cookie and a same-origin request.
- `bypassPermissions` is deliberately not offered as a session mode.
- A terminal is an unrestricted shell as your user, with no approval step. Start with `--no-terminal` if you
  only want Claude sessions reachable from the phone.

## Development

```bash
npm test
```
