# OMP API Trace Viewer

A standalone HTML tool for inspecting the exact API requests/responses sent by omp.

## Quick Start

### Option 1: Slash Command (Recommended)

Just run:
```
/trace
```

This starts the trace server and opens the viewer in your browser.

Then restart omp with tracing enabled:
```bash
PI_REQ_DEBUG=1 ompd
```

### Option 2: One-Command Launcher

```bash
tools\trace.cmd
# or
bun tools/trace.ts
```

This starts everything automatically: trace server, browser, and ompd with tracing.

### Option 3: Manual

1. Start omp with `PI_REQ_DEBUG=1`
2. Open `tools/api-trace-viewer.html` in your browser
3. Drag & drop `rr-session-*.json` files into the viewer

## Features

- **Dark mode** — clean, modern dark UI
- **Real-time updates** — click ▶ Live to see traces as they happen
- **Expandable sections** — click to drill into headers, messages, tools, body
- **Thinking block highlighting** — purple markers for reasoning content
- **Message timeline** — all messages with roles and content
- **SSE event viewer** — parsed server-sent events with syntax highlighting
- **Copy to clipboard** — one-click copy for any section or all traces
- **Search/filter** — filter by URL, method, model, or content
- **Stats bar** — quick overview of OK/Error/Pending counts

## How It Works

```
/trace  (or tools\trace.cmd)
    │
    ├── Starts trace server on port 7777
    ├── Opens browser → http://localhost:7777
    │
PI_REQ_DEBUG=1 ompd
    │
    └── omp writes rr-session-*.json files
            │
            └── Server detects new files every 500ms
                    │
                    └── Pushes to viewer via SSE (real-time)
```

## Files

```
tools/
├── api-trace-viewer.html   # The viewer (standalone, no dependencies)
├── trace.cmd               # One-command launcher (Windows)
├── trace.ts                # One-command launcher (cross-platform)
├── trace-server.ts         # Standalone server (if you want just the server)
└── README.md               # This file
```

## Sharing Traces

To share a trace for debugging:

1. Load the traces in the viewer
2. Click **📤 Copy All** (or copy individual sections)
3. Paste into chat/email/etc.

The JSON format is self-contained and can be loaded back into the viewer by anyone.
