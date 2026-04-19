#!/usr/bin/env node
/**
 * mcp-shell-bun
 * --------------
 * Bun-native MCP shell server. Port of tumf/mcp-shell-server semantics
 * (allowlist + stdin + shell-operator validation, no /bin/sh) plus:
 *   - HTTP transport with bearer token
 *   - File helpers (read/write/upload/list)
 *   - Cross-platform single binary via `bun build --compile`
 *
 * Modes:
 *   ALLOW_COMMANDS unset  → UNRESTRICTED (lab mode; warning on boot)
 *   ALLOW_COMMANDS="ls,cat,..." → allowlist enforced, same as tumf
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { loadAllowList, validateCommand, type AllowList } from "./validator.js";
import { execPipeline } from "./executor.js";

const SERVER_NAME = "mcp-shell-bun";
const SERVER_VERSION = "1.0.0";

const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 1800;
const OUTPUT_CAP_BYTES = 1_000_000;
const MAX_FILE_READ = 10_000_000;
const MAX_FILE_WRITE = 50_000_000;

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server factory
// ─────────────────────────────────────────────────────────────────────────────

function buildServer(allow: AllowList): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const allowDesc = allow.unrestricted
    ? "UNRESTRICTED mode — any command allowed. Lab use only."
    : `Allowlist: ${[...allow.commands].sort().join(", ")}`;

  // ── shell_execute ────────────────────────────────────────────────────────
  server.registerTool(
    "shell_execute",
    {
      title: "Execute Shell Command",
      description: `Execute a command as argv (no shell interpretation). Compatible with tumf/mcp-shell-server request format.

${allowDesc}

Shell operators (\`;\`, \`&&\`, \`||\`, \`|\`) may appear as separate argv tokens.
They are parsed in-process, not by /bin/sh:
  - \`|\` chains stdout→stdin between adjacent stages
  - \`;\` runs next statement unconditionally
  - \`&&\` runs next only if previous exited 0
  - \`||\` runs next only if previous exited non-0
Each statement's head command is validated against the allowlist.

Args:
  - command (string[], required): argv tokens, e.g. ["ls", "-l", "/tmp"]
      or ["cat", "file.txt", "|", "grep", "foo"]
  - stdin (string, optional): input piped to the first statement's stdin
  - directory (string, optional): cwd for all stages (~ expanded)
  - timeout (number, optional): seconds, default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}

Returns (JSON):
  {
    "stdout": string,
    "stderr": string,
    "status": number | null,     // exit code of last statement
    "execution_time": number,    // seconds
    "timed_out": boolean,
    "truncated": boolean,        // true if stdout/stderr hit 1MB cap
    "error"?: string             // present only on validation failure
  }`,
      inputSchema: {
        command: z.array(z.string().min(1)).min(1).describe("argv tokens"),
        stdin: z.string().optional().describe("Input piped to first stage"),
        directory: z.string().optional().describe("Working directory"),
        timeout: z
          .number()
          .int()
          .positive()
          .max(MAX_TIMEOUT_SEC)
          .optional()
          .describe(`Timeout in seconds (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC})`),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ command, stdin, directory, timeout }) => {
      const valid = validateCommand(command, allow);
      if (!valid.ok) {
        const result = {
          stdout: "",
          stderr: valid.error,
          status: 1,
          execution_time: 0,
          timed_out: false,
          truncated: false,
          error: valid.error,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: true,
        };
      }

      const result = await execPipeline(command, {
        cwd: directory ? expandHome(directory) : undefined,
        timeoutMs: (timeout ?? DEFAULT_TIMEOUT_SEC) * 1000,
        stdin,
        outputCapBytes: OUTPUT_CAP_BYTES,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
  );

  // ── read_file ────────────────────────────────────────────────────────────
  server.registerTool(
    "read_file",
    {
      title: "Read File",
      description: `Read a file from the host filesystem as UTF-8 text.

Args:
  - path (string, required): absolute or ~-relative path
  - max_bytes (number, optional): cap read size (default 10MB)

Returns { path, size_bytes, content, truncated }`,
      inputSchema: {
        path: z.string().min(1),
        max_bytes: z.number().int().positive().max(MAX_FILE_READ).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ path: p, max_bytes }) => {
      const full = expandHome(p);
      const cap = max_bytes ?? MAX_FILE_READ;
      const stat = await fs.stat(full);
      const fh = await fs.open(full, "r");
      try {
        const len = Math.min(stat.size, cap);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, 0);
        const out = {
          path: full,
          size_bytes: stat.size,
          content: buf.toString("utf8"),
          truncated: stat.size > cap,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      } finally {
        await fh.close();
      }
    }
  );

  // ── write_file ───────────────────────────────────────────────────────────
  server.registerTool(
    "write_file",
    {
      title: "Write File",
      description: `Write/overwrite a UTF-8 text file.

Args:
  - path (string, required)
  - content (string, required)
  - mode (string, optional): octal like "0644"
  - mkdir_parents (boolean, optional)

Returns { path, bytes_written }`,
      inputSchema: {
        path: z.string().min(1),
        content: z.string().max(MAX_FILE_WRITE),
        mode: z.string().regex(/^0?[0-7]{3,4}$/).optional(),
        mkdir_parents: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ path: p, content, mode, mkdir_parents }) => {
      const full = expandHome(p);
      if (mkdir_parents) await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf8");
      if (mode) await fs.chmod(full, parseInt(mode, 8));
      const out = { path: full, bytes_written: Buffer.byteLength(content, "utf8") };
      return {
        content: [{ type: "text", text: JSON.stringify(out) }],
        structuredContent: out,
      };
    }
  );

  // ── upload_file_b64 ──────────────────────────────────────────────────────
  server.registerTool(
    "upload_file_b64",
    {
      title: "Upload Binary File (base64)",
      description: `Write a binary file from base64 data. For installers, archives, certs.

Args:
  - path (string, required)
  - data_b64 (string, required)
  - mode (string, optional)
  - mkdir_parents (boolean, optional)

Returns { path, bytes_written }`,
      inputSchema: {
        path: z.string().min(1),
        data_b64: z.string().min(1),
        mode: z.string().regex(/^0?[0-7]{3,4}$/).optional(),
        mkdir_parents: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ path: p, data_b64, mode, mkdir_parents }) => {
      const full = expandHome(p);
      const buf = Buffer.from(data_b64, "base64");
      if (buf.length > MAX_FILE_WRITE) {
        throw new Error(`File too large: ${buf.length} > ${MAX_FILE_WRITE}`);
      }
      if (mkdir_parents) await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, buf);
      if (mode) await fs.chmod(full, parseInt(mode, 8));
      const out = { path: full, bytes_written: buf.length };
      return {
        content: [{ type: "text", text: JSON.stringify(out) }],
        structuredContent: out,
      };
    }
  );

  // ── list_dir ─────────────────────────────────────────────────────────────
  server.registerTool(
    "list_dir",
    {
      title: "List Directory",
      description: `List directory entries with type + size.

Args:
  - path (string, required)
  - show_hidden (boolean, optional)

Returns { path, count, entries: [{ name, type, size_bytes? }] }`,
      inputSchema: {
        path: z.string().min(1),
        show_hidden: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ path: p, show_hidden }) => {
      const full = expandHome(p);
      const names = await fs.readdir(full);
      const entries: Array<{ name: string; type: string; size_bytes?: number }> = [];
      for (const name of names) {
        if (!show_hidden && name.startsWith(".")) continue;
        try {
          const st = await fs.lstat(path.join(full, name));
          let type = "other";
          if (st.isDirectory()) type = "dir";
          else if (st.isSymbolicLink()) type = "symlink";
          else if (st.isFile()) type = "file";
          entries.push({ name, type, ...(st.isFile() ? { size_bytes: st.size } : {}) });
        } catch {
          entries.push({ name, type: "unreadable" });
        }
      }
      const out = { path: full, count: entries.length, entries };
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    }
  );

  // ── system_info ──────────────────────────────────────────────────────────
  server.registerTool(
    "system_info",
    {
      title: "System Info",
      description: `Return basic host info: hostname, platform, arch, user, cwd, uptime, loadavg, memory.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const info = {
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        node_version: process.version,
        user: os.userInfo().username,
        home: os.homedir(),
        cwd: process.cwd(),
        uptime_sec: Math.round(os.uptime()),
        loadavg: os.loadavg(),
        total_mem_mb: Math.round(os.totalmem() / 1024 / 1024),
        free_mem_mb: Math.round(os.freemem() / 1024 / 1024),
        allow_mode: allow.unrestricted ? "unrestricted" : "allowlist",
        allowed_commands: allow.unrestricted ? null : [...allow.commands].sort(),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
        structuredContent: info,
      };
    }
  );

  return server;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transports
// ─────────────────────────────────────────────────────────────────────────────

function bootBanner(allow: AllowList, mode: string): void {
  console.error(`[${SERVER_NAME}] v${SERVER_VERSION} — ${mode} transport`);
  if (allow.unrestricted) {
    console.error(
      `[${SERVER_NAME}] ⚠  ALLOW_COMMANDS is unset — UNRESTRICTED mode. ` +
      `Any command the process user can run will execute. Set ALLOW_COMMANDS="ls,cat,..." to enforce an allowlist.`
    );
  } else {
    console.error(
      `[${SERVER_NAME}] allowlist: ${[...allow.commands].sort().join(", ")}`
    );
  }
}

async function runStdio(): Promise<void> {
  const allow = loadAllowList();
  bootBanner(allow, "stdio");
  const server = buildServer(allow);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function runHttp(): Promise<void> {
  const allow = loadAllowList();
  bootBanner(allow, "http");

  const token = process.env.SHELL_MCP_TOKEN;
  if (!token || token.length < 16) {
    console.error(
      "FATAL: SHELL_MCP_TOKEN must be set (>=16 chars) for HTTP transport.\n" +
      "  generate: openssl rand -hex 32"
    );
    process.exit(1);
  }

  const host = process.env.HOST || "127.0.0.1";
  const port = parseInt(process.env.PORT || "3000", 10);

  const app = express();
  app.use(express.json({ limit: "100mb" }));

  app.use("/mcp", (req: Request, res: Response, next: NextFunction) => {
    const h = req.header("authorization") || "";
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m || !timingSafeEq(m[1], token)) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
      return;
    }
    next();
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    const server = buildServer(allow);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/healthz", (_req, res) =>
    res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION })
  );

  app.listen(port, host, () => {
    console.error(`[${SERVER_NAME}] listening http://${host}:${port}/mcp`);
    if (host === "0.0.0.0") {
      console.error(
        `[${SERVER_NAME}] ⚠  bound to 0.0.0.0 — token is your only defense. ` +
        `Prefer HOST=127.0.0.1 + SSH tunnel.`
      );
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────────────────────

const transport = (process.env.TRANSPORT || "stdio").toLowerCase();
const main = transport === "http" ? runHttp : runStdio;
main().catch((err) => {
  console.error(`[${SERVER_NAME}] fatal:`, err);
  process.exit(1);
});
