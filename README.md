# mcp-linux-js

Single-binary MCP shell server. Bun/TypeScript port of [tumf/mcp-shell-server](https://github.com/tumf/mcp-shell-server) (MIT) + HTTP transport w/ bearer auth + file helpers + cross-platform prebuilt binaries.

Same request/response shape as upstream, so existing clients work unchanged.

## What's in here

| Feature | Source | Notes |
|---|---|---|
| Allowlist w/ `ALLOW_COMMANDS` / `ALLOWED_COMMANDS` | tumf | Comma-sep, trimmed |
| Shell-operator validation (`;` `&&` `\|\|` `\|`) | tumf | Each segment head checked |
| No /bin/sh — direct execve | tumf | No shell injection |
| `stdin` input | tumf | Piped to first statement |
| In-process pipeline semantics | new | `;` `&&` `\|\|` `\|` emulated, no shell |
| **Unrestricted mode** (ALLOW_COMMANDS unset) | new | Lab convenience. Logged loudly. |
| **HTTP transport + bearer token** | new | For remote control |
| `read_file` / `write_file` / `upload_file_b64` / `list_dir` / `system_info` | new | Quality-of-life |
| Single-binary build (Bun compile) | new | 5 platforms via CI |

## Modes

```bash
# Same as tumf (safe-ish): only listed commands allowed
ALLOW_COMMANDS="ls,cat,pwd,grep,wc,find" mcp-linux-js

# Unrestricted (lab): no allowlist
mcp-linux-js   # emits WARNING on boot
```

## Transports

### stdio (default)

```json
{
  "mcpServers": {
    "shell": {
      "command": "/path/to/mcp-linux-js-linux-x64",
      "env": { "ALLOW_COMMANDS": "ls,cat,pwd,grep,wc,find" }
    }
  }
}
```

### HTTP w/ bearer token (for remote boxes)

On the server:
```bash
export SHELL_MCP_TOKEN=$(openssl rand -hex 32)
# optionally: export ALLOW_COMMANDS="ls,cat,apt-get,..."
TRANSPORT=http HOST=127.0.0.1 PORT=3000 ./mcp-linux-js-linux-x64
```

On the client machine, SSH-tunnel the port:
```bash
ssh -N -L 3000:127.0.0.1:3000 user@remote-host
```

Claude Desktop config:
```json
{
  "mcpServers": {
    "shell-remote": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

## Tool: `shell_execute`

Request (tumf-compatible):
```json
{
  "command": ["ls", "-l", "/tmp"],
  "stdin": "optional input",
  "directory": "/some/path",
  "timeout": 60
}
```

Response:
```json
{
  "stdout": "...",
  "stderr": "",
  "status": 0,
  "execution_time": 0.017,
  "timed_out": false,
  "truncated": false
}
```

Pipelines and sequences:
```json
{ "command": ["cat", "file.txt", "|", "grep", "foo", "|", "wc", "-l"] }
{ "command": ["apt-get", "update", "&&", "apt-get", "install", "-y", "nginx"] }
{ "command": ["systemctl", "restart", "nginx", "||", "journalctl", "-u", "nginx", "-n", "50"] }
```

## Env vars

| Var | Default | Notes |
|---|---|---|
| `TRANSPORT` | `stdio` | `stdio` or `http` |
| `HOST` | `127.0.0.1` | HTTP bind |
| `PORT` | `3000` | HTTP port |
| `SHELL_MCP_TOKEN` | — | Required for HTTP, ≥16 chars |
| `ALLOW_COMMANDS` | unset | Comma list. Unset → unrestricted. |
| `ALLOWED_COMMANDS` | — | Alias of `ALLOW_COMMANDS` |

## Build locally

```bash
bun install
bun run compile:linux-x64   # → dist/mcp-linux-js-linux-x64
# or all 5 platforms:
bun run compile:all
```

## Docker

```bash
docker build -t mcp-linux-js .
docker run --rm \
  -e SHELL_MCP_TOKEN=$(openssl rand -hex 32) \
  -e ALLOW_COMMANDS="ls,cat,grep" \
  -p 127.0.0.1:3000:3000 \
  mcp-linux-js
```

## Security reality check

- **Allowlist is not a security boundary** if you include `bash`, `sh`, `python`, `perl`, `node`, `ruby`, `awk`, `find`, `xargs`, `ssh`, `sudo`, `make`, or `env`. Any of these → RCE via `-c`/`-e`/`-exec`. Allowlist is only meaningful for inspection-only binaries (`ls`, `cat`, `grep`, `wc`, `head`, `tail`, `df`, `uptime`, etc.).
- **Never expose to the public internet**, even w/ a token. Bind `127.0.0.1` + SSH tunnel.
- **Run as non-root.** Passwordless sudo = RCE-to-root.
- **On EC2**: enforce IMDSv2 with hop-limit 1 to stop credential theft → IAM pivot.
- **Destroy the box when done.**

## Credits

Original design, request/response shape, and validation semantics: [tumf/mcp-shell-server](https://github.com/tumf/mcp-shell-server) (MIT).
This repo is an independent TypeScript/Bun reimplementation.

## License

MIT.
