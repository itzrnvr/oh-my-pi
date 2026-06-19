#!/usr/bin/env bun
/**
 * OMP API Trace — One-command setup
 *
 * Usage:
 *   bun tools/trace.ts [ompd args...]
 *
 * This:
 *   1. Starts a trace server on port 7777
 *   2. Opens the viewer in your browser
 *   3. Runs ompd with PI_REQ_DEBUG=1
 *   4. Traces appear in real-time in the viewer
 *
 * Example:
 *   bun tools/trace.ts
 *   bun tools/trace.ts --resume 019ebdb0-3611-7000-93a7-4a869f7c4c8f
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

const PORT = 7777;
const TOOLS_DIR = import.meta.dir;
const VIEWER_PATH = path.join(TOOLS_DIR, "api-trace-viewer.html");

// ── Find trace files ──
const TRACE_GLOB = /^rr-session-(\d+)\.json$/;
const knownFiles = new Map<string, { mtime: number; data: unknown }>();
const sseClients = new Set<ReadableStreamDefaultController>();

function isLlmApiRequest(url: string): boolean {
  if (!url) return false;
  const u = url.toLowerCase();
  if (u.includes("/v1/messages")) return true;
  if (u.includes("/chat/completions")) return true;
  if (u.includes("/v1/responses")) return true;
  if (u.includes("/v1/completions") && !u.includes("/chat/")) return true;
  if ((u.includes("/v1beta/") || u.includes("/v1/")) &&
      (u.includes(":generateContent") || u.includes(":streamGenerateContent"))) return true;
  return false;
}

function scanDir(dir: string) {
  try {
    for (const file of fs.readdirSync(dir)) {
      const match = file.match(TRACE_GLOB);
      if (!match) continue;
      const fullPath = path.join(dir, file);
      try {
        const stat = fs.statSync(fullPath);
        const existing = knownFiles.get(fullPath);
        if (existing && existing.mtime >= stat.mtimeMs) continue;
        const content = fs.readFileSync(fullPath, "utf-8");
        const data = JSON.parse(content);
        // Only process LLM API requests
        if (!isLlmApiRequest(data.url)) continue;
        knownFiles.set(fullPath, { mtime: stat.mtimeMs, data });
        broadcast({ type: "trace", file, data, dir });
      } catch {}
    }
  } catch {}
}

function broadcast(event: unknown) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const ctrl of sseClients) {
    try { ctrl.enqueue(new TextEncoder().encode(payload)); }
    catch { sseClients.delete(ctrl); }
  }
}

// ── HTTP Server ──
const viewerHtml = fs.readFileSync(VIEWER_PATH, "utf-8");

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    // SSE endpoint
    if (url.pathname === "/events") {
      const stream = new ReadableStream({
        start(ctrl) {
          sseClients.add(ctrl);
          // Send existing traces
          for (const [_, { data }] of knownFiles) {
            ctrl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "trace", data })}\n\n`));
          }
          ctrl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "connected", traceCount: knownFiles.size })}\n\n`));
        },
        cancel() { sseClients.delete(ctrl); },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" },
      });
    }

    // API endpoint
    if (url.pathname === "/api/traces") {
      return Response.json(Array.from(knownFiles.values()).map(v => v.data), {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    // Serve viewer
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(viewerHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`\n  📡 Trace server running at http://localhost:${PORT}\n`);

// ── Open browser ──
const openCmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
spawn(openCmd, [`http://localhost:${PORT}`], { shell: true, stdio: "ignore" });

// ── Scan for existing traces ──
scanDir(process.cwd());

// ── Start ompd ──
const ompdArgs = process.argv.slice(2);
console.log(`  Starting: ompd ${ompdArgs.join(" ")}\n`);

const ompd = spawn("ompd", ompdArgs, {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, PI_REQ_DEBUG: "1" },
});

// ── Poll for new traces ──
const pollInterval = setInterval(() => {
  scanDir(process.cwd());
}, 500);

// ── Cleanup ──
ompd.on("exit", (code) => {
  clearInterval(pollInterval);
  // Final scan to catch any last traces
  scanDir(process.cwd());
  console.log(`\n  Done. View traces at http://localhost:${PORT}\n`);
  server.stop();
  process.exit(code ?? 0);
});

process.on("SIGINT", () => {
  ompd.kill("SIGINT");
});
