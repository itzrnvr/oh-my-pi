#!/usr/bin/env bun
/**
 * OMP API Trace Server
 *
 * Watches for rr-session-*.json trace files and serves them to the
 * api-trace-viewer.html via SSE (Server-Sent Events) for real-time updates.
 *
 * Usage:
 *   1. Start omp with PI_REQ_DEBUG=1:
 *      PI_REQ_DEBUG=1 ompd
 *
 *   2. Start this server (from the same directory as the trace files):
 *      bun tools/trace-server.ts
 *
 *   3. Open the viewer:
 *      http://localhost:7777
 *
 * The viewer will automatically connect and receive new traces as they appear.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const PORT = Number.parseInt(process.argv[2] || "7777", 10);
const TRACE_GLOB = /^rr-session-(\d+)\.json$/;
const POLL_INTERVAL = 500; // ms

// Accept trace directory as 3rd arg, or use CWD
const traceDir = process.argv[3] || process.cwd();
const viewerPath = path.join(import.meta.dir, "api-trace-viewer.html");

// ── State ──
const knownFiles = new Map<string, { mtime: number; data: unknown }>();
const clients = new Set<ReadableStreamDefaultController>();

// ── Filter: only LLM API requests ──
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

// ── Scan for trace files ──
function scanTraces() {
  try {
    const files = fs.readdirSync(traceDir);
    for (const file of files) {
      const match = file.match(TRACE_GLOB);
      if (!match) continue;
      const fullPath = path.join(traceDir, file);
      try {
        const stat = fs.statSync(fullPath);
        const existing = knownFiles.get(file);
        if (existing && existing.mtime >= stat.mtimeMs) continue;
        const content = fs.readFileSync(fullPath, "utf-8");
        const data = JSON.parse(content);
        // Only process LLM API requests
        if (!isLlmApiRequest(data.url)) continue;
        knownFiles.set(file, { mtime: stat.mtimeMs, data });
        broadcast({ type: "trace", file, data });
      } catch {}
    }
  } catch {}
}

// ── SSE broadcast ──
function broadcast(event: unknown) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const controller of clients) {
    try {
      controller.enqueue(new TextEncoder().encode(payload));
    } catch {
      clients.delete(controller);
    }
  }
}

// ── Watch loop ──
setInterval(scanTraces, POLL_INTERVAL);

// ── HTTP Server ──
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // SSE endpoint for live updates
    if (url.pathname === "/events") {
      const stream = new ReadableStream({
        start(controller) {
          clients.add(controller);
          // Send current traces immediately
          for (const [file, { data }] of knownFiles) {
            const payload = `data: ${JSON.stringify({ type: "trace", file, data })}\n\n`;
            controller.enqueue(new TextEncoder().encode(payload));
          }
          // Send initial "connected" event
          const hello = `data: ${JSON.stringify({ type: "connected", traceCount: knownFiles.size })}\n\n`;
          controller.enqueue(new TextEncoder().encode(hello));
        },
        cancel(controller) {
          clients.delete(controller);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // API endpoint to get all traces as JSON
    if (url.pathname === "/api/traces") {
      const allTraces = Array.from(knownFiles.values()).map(v => v.data);
      return Response.json(allTraces, {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    // Serve the viewer HTML
    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        let html = fs.readFileSync(viewerPath, "utf-8");
        // Inject live mode script before </body>
        const liveScript = `
<script>
// ── Live Mode ──
let liveMode = false;
let evtSource = null;
let liveTraces = [];

function toggleLiveMode() {
  liveMode = !liveMode;
  const btn = document.getElementById('liveBtn');
  if (liveMode) {
    btn.textContent = '⏸ Pause';
    btn.classList.add('primary');
    connectLive();
  } else {
    btn.textContent = '▶ Live';
    btn.classList.remove('primary');
    disconnectLive();
  }
}

function connectLive() {
  if (evtSource) evtSource.close();
  evtSource = new EventSource('/events');
  evtSource.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'connected') {
      console.log('[live] Connected, received', msg.traceCount, 'traces');
    } else if (msg.type === 'trace') {
      // Check if we already have this trace
      const existing = traces.find(t => t.sessionId === msg.data.id);
      if (existing) {
        // Update response if we got one
        if (msg.data.response && !existing.response) {
          existing.response = msg.data.response;
          renderTraces();
        }
      } else {
        addTrace(msg.data);
      }
    }
  };
  evtSource.onerror = () => {
    console.log('[live] Connection lost, reconnecting...');
    setTimeout(connectLive, 2000);
  };
}

function disconnectLive() {
  if (evtSource) { evtSource.close(); evtSource = null; }
}

// Add live button to header
const headerActions = document.querySelector('.header-actions');
if (headerActions) {
  const liveBtn = document.createElement('button');
  liveBtn.id = 'liveBtn';
  liveBtn.className = 'btn';
  liveBtn.textContent = '▶ Live';
  liveBtn.onclick = toggleLiveMode;
  headerActions.insertBefore(liveBtn, headerActions.firstChild);
}
</script>`;
        html = html.replace('</body>', liveScript + '\n</body>');
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      } catch (e) {
        return new Response(`Error loading viewer: ${e}`, { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`
┌─────────────────────────────────────────────┐
│  OMP API Trace Server                       │
├─────────────────────────────────────────────┤
│  Viewer:  http://localhost:${PORT}             │
│  SSE:     http://localhost:${PORT}/events      │
│  API:     http://localhost:${PORT}/api/traces  │
│  Watching: ${traceDir}
└─────────────────────────────────────────────┘

Start omp with PI_REQ_DEBUG=1 to capture traces:
  PI_REQ_DEBUG=1 ompd
`);

// Initial scan
scanTraces();
