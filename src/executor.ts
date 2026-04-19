/**
 * Executor — runs a validated argv pipeline.
 *
 * Design: we NEVER invoke /bin/sh. We execve each segment directly.
 * Operator semantics are emulated in-process:
 *   `a | b`    → pipe a.stdout into b.stdin
 *   `a ; b`    → run a, then b (regardless of a's exit)
 *   `a && b`   → run a, then b only if a.exit_code === 0
 *   `a || b`   → run a, then b only if a.exit_code !== 0
 *
 * Mixing pipes with `;`/`&&`/`||` in one command: we group consecutive
 * `|` segments into a pipeline, and treat `;`/`&&`/`||` as statement breaks.
 * This mirrors POSIX shell precedence closely enough for MCP use.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";

export interface ExecOptions {
  cwd?: string;
  timeoutMs: number;
  stdin?: string;
  outputCapBytes: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  status: number | null;
  execution_time: number;
  timed_out: boolean;
  truncated: boolean;
  error?: string;
}

// ─── segment grouping ────────────────────────────────────────────────────────

type Connector = ";" | "&&" | "||";

interface Statement {
  pipeline: string[][]; // each entry is argv for one stage
  connector: Connector | null; // connector AFTER this statement (null = last)
}

/**
 * Re-walk the original argv (with operators) to build statement list.
 * Validator already confirmed structure; here we trust it.
 */
export function parseStatements(argv: readonly string[]): Statement[] {
  const statements: Statement[] = [];
  let currentPipeline: string[][] = [];
  let currentSegment: string[] = [];

  const flushSegment = () => {
    if (currentSegment.length > 0) {
      currentPipeline.push(currentSegment);
      currentSegment = [];
    }
  };
  const flushStatement = (connector: Connector | null) => {
    flushSegment();
    if (currentPipeline.length > 0) {
      statements.push({ pipeline: currentPipeline, connector });
      currentPipeline = [];
    }
  };

  for (const tok of argv) {
    if (tok === "|") {
      flushSegment();
    } else if (tok === ";" || tok === "&&" || tok === "||") {
      flushStatement(tok);
    } else {
      currentSegment.push(tok);
    }
  }
  flushStatement(null);
  return statements;
}

// ─── pipeline runner ─────────────────────────────────────────────────────────

interface PipelineResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
}

function runPipeline(
  pipeline: string[][],
  stdinStr: string | undefined,
  cwd: string | undefined,
  timeoutMs: number,
  outputCap: number
): Promise<PipelineResult> {
  return new Promise((resolve) => {
    const children: ChildProcess[] = [];
    let truncated = false;
    let timedOut = false;

    // Spawn all stages
    for (let i = 0; i < pipeline.length; i++) {
      const argv = pipeline[i];
      const [cmd, ...args] = argv;
      const isFirst = i === 0;
      const isLast = i === pipeline.length - 1;
      const child = spawn(cmd, args, {
        cwd,
        stdio: [
          isFirst ? "pipe" : "pipe", // stdin (piped from prev or from stdinStr)
          "pipe",
          "pipe",
        ],
        env: process.env,
      });
      children.push(child);

      // Wire previous stdout → this stdin
      if (!isFirst) {
        const prev = children[i - 1];
        if (prev.stdout && child.stdin) {
          prev.stdout.pipe(child.stdin);
        }
      }

      // Don't collect stdout from non-last stages (it's piped onward)
      if (!isLast && child.stdout) {
        // resume in case nothing is reading — pipe() handles it, noop
      }
    }

    // Feed stdin to first stage
    const first = children[0];
    if (stdinStr !== undefined && first.stdin) {
      Readable.from([stdinStr]).pipe(first.stdin);
    } else if (first.stdin) {
      first.stdin.end();
    }

    // Collect output from last stage
    const last = children[children.length - 1];
    let out = Buffer.alloc(0);
    const errBufs: Buffer[][] = children.map(() => []);

    const appendCapped = (cur: Buffer, chunk: Buffer): Buffer => {
      if (cur.length >= outputCap) {
        truncated = true;
        return cur;
      }
      const room = outputCap - cur.length;
      if (chunk.length > room) {
        truncated = true;
        return Buffer.concat([cur, chunk.subarray(0, room)]);
      }
      return Buffer.concat([cur, chunk]);
    };

    last.stdout?.on("data", (c: Buffer) => {
      out = appendCapped(out, c);
    });

    // Collect stderr from every stage
    children.forEach((c, i) => {
      c.stderr?.on("data", (chunk: Buffer) => errBufs[i].push(chunk));
    });

    // Timeout
    const killTimer = setTimeout(() => {
      timedOut = true;
      for (const c of children) {
        try {
          c.kill("SIGKILL");
        } catch {}
      }
    }, timeoutMs);

    // Wait for last to exit (upstream stages will exit when their pipe closes)
    const spawnErrors: string[] = [];
    children.forEach((c, i) => {
      c.on("error", (e) => {
        spawnErrors.push(`[stage ${i} spawn error] ${e.message}`);
      });
    });

    last.on("close", (code) => {
      clearTimeout(killTimer);
      // Make sure upstream stages are done before resolving
      const pending = children.slice(0, -1).filter((c) => c.exitCode === null);
      if (pending.length === 0) {
        finish(code);
      } else {
        let remaining = pending.length;
        for (const c of pending) {
          c.on("close", () => {
            remaining--;
            if (remaining === 0) finish(code);
          });
        }
        // Safety: don't hang forever waiting for upstream
        setTimeout(() => finish(code), 500).unref();
      }
    });

    const finish = (code: number | null) => {
      const stderrStr =
        errBufs.map((bufs) => Buffer.concat(bufs).toString("utf8")).join("") +
        (spawnErrors.length ? "\n" + spawnErrors.join("\n") : "");
      resolve({
        stdout: out,
        stderr: Buffer.from(stderrStr, "utf8"),
        exitCode: code,
        truncated,
        timedOut,
      });
    };
  });
}

// ─── statement orchestrator ──────────────────────────────────────────────────

export async function execPipeline(
  argv: readonly string[],
  opts: ExecOptions
): Promise<ExecResult> {
  const start = Date.now();
  const statements = parseStatements(argv);
  if (statements.length === 0) {
    return {
      stdout: "",
      stderr: "",
      status: 1,
      execution_time: 0,
      timed_out: false,
      truncated: false,
      error: "Empty command",
    };
  }

  // Only feed stdin to the first statement's first stage.
  let stdinForNext: string | undefined = opts.stdin;

  let aggOut = Buffer.alloc(0);
  let aggErr = Buffer.alloc(0);
  let lastExit: number | null = null;
  let anyTruncated = false;
  let anyTimedOut = false;
  let skipNext = false;

  const remainingTimeout = () => Math.max(100, opts.timeoutMs - (Date.now() - start));

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];

    if (skipNext) {
      // Propagate connector logic: decide again AFTER this statement
      skipNext = false;
      // skip body but re-evaluate connector for the NEXT iteration
      // (i.e., treat this statement as if it didn't run; carry lastExit forward)
      applyConnectorDecision(stmt.connector, lastExit, (skip) => (skipNext = skip));
      continue;
    }

    const pr = await runPipeline(
      stmt.pipeline,
      stdinForNext,
      opts.cwd,
      remainingTimeout(),
      opts.outputCapBytes
    );
    stdinForNext = undefined; // only the very first statement gets user stdin

    aggOut = concatCapped(aggOut, pr.stdout, opts.outputCapBytes, (t) => {
      if (t) anyTruncated = true;
    });
    aggErr = concatCapped(aggErr, pr.stderr, opts.outputCapBytes, (t) => {
      if (t) anyTruncated = true;
    });
    if (pr.truncated) anyTruncated = true;
    if (pr.timedOut) anyTimedOut = true;
    lastExit = pr.exitCode;

    if (anyTimedOut) break;

    applyConnectorDecision(stmt.connector, lastExit, (skip) => (skipNext = skip));
  }

  return {
    stdout: aggOut.toString("utf8"),
    stderr: aggErr.toString("utf8"),
    status: lastExit,
    execution_time: (Date.now() - start) / 1000,
    timed_out: anyTimedOut,
    truncated: anyTruncated,
  };
}

function applyConnectorDecision(
  connector: Connector | null,
  lastExit: number | null,
  setSkip: (skip: boolean) => void
): void {
  if (connector === null) return;
  if (connector === ";") {
    setSkip(false);
  } else if (connector === "&&") {
    setSkip(lastExit !== 0);
  } else if (connector === "||") {
    setSkip(lastExit === 0);
  }
}

function concatCapped(
  cur: Buffer,
  add: Buffer,
  cap: number,
  onTrunc: (t: boolean) => void
): Buffer {
  if (cur.length >= cap) {
    onTrunc(true);
    return cur;
  }
  const room = cap - cur.length;
  if (add.length > room) {
    onTrunc(true);
    return Buffer.concat([cur, add.subarray(0, room)]);
  }
  return Buffer.concat([cur, add]);
}
