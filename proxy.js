const express = require("express");
const http = require("http");
const net = require("net");
const { createProxyMiddleware, responseInterceptor } = require("http-proxy-middleware");

const memLogs = [];
const origLog = console.log;
const origErr = console.error;
console.log = (...args) => {
  const line = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  memLogs.push(`[LOG] ${line}`);
  if (memLogs.length > 500) memLogs.shift();
  origLog(...args);
};
console.error = (...args) => {
  const line = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  memLogs.push(`[ERR] ${line}`);
  if (memLogs.length > 500) memLogs.shift();
  origErr(...args);
};

const app = express();
const PORT = process.env.PORT || 10000;

// ─── Service port map (single source of truth) ──────────────────────────────
const SERVICE_PORTS = {
  instacrave: 3001,
  birddrop: 3002,
  lila: 3003,
  pollrabbit: 3004,
  cuber: 3005,
};

// ─── Request Logging (concise) ────────────────────────────────────────────────
app.use((req, res, next) => {
  console.log(`[proxy] ${req.method} ${req.url}`);
  next();
});

// ─── Health check (UptimeRobot pings this) ───────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Root — quick index so you know what's running ───────────────────────────
app.get("/", (req, res) => {
  res.json({
    message: "Render wrapper running",
    services: Object.keys(SERVICE_PORTS).map(name => ({ name, path: `/${name}` })),
  });
});

// ─── Socket.IO direct route (instacrave) ─────────────────────────────────────
// Socket.IO clients connect to the origin and always send requests to /socket.io/
// by default. This route forwards those directly to instacrave (port 3001)
// WITHOUT path rewriting — the backend Socket.IO server expects /socket.io/.
const socketIoProxy = createProxyMiddleware({
  target: "http://127.0.0.1:3001",
  changeOrigin: true,
  ws: true,
  agent: false,
  logLevel: "warn",
  onError: (err, req, res) => {
    console.error("[proxy] Socket.IO proxy error:", err.message);
    if (res && res.writeHead) {
      res.writeHead(502);
      res.end("Socket.IO service unavailable");
    } else if (res && res.destroy) {
      res.destroy();
    }
  },
});
app.use("/socket.io", socketIoProxy);

// ─── HTTP-only service routes ────────────────────────────────────────────────
// These proxy HTTP requests (REST API calls, static files, etc.) for each service.
// WebSocket upgrades are handled separately below via raw TCP pipe — NOT through
// http-proxy-middleware — because HPM's internal stream piping silently drops
// WebSocket data frames after hours of uptime.
for (const [name, port] of Object.entries(SERVICE_PORTS)) {
  const svcPath = `/${name}`;

  let proxyOptions = {
    target: `http://127.0.0.1:${port}`,
    changeOrigin: true,
    agent: false,
    pathRewrite: (path) => {
      const newPath = path.replace(new RegExp(`^${svcPath}`), "");
      return newPath === "" ? "/" : newPath;
    },
    ws: false, // CRITICAL: disable HPM WebSocket handling — we do it ourselves
    onError: (err, req, res) => {
      console.error(`[proxy] ${svcPath} error:`, err.message);
      if (res && res.writeHead) {
        res.writeHead(502);
        res.end(`Service ${svcPath} is unavailable`);
      } else if (res && res.destroy) {
        res.destroy();
      }
    },
  };

  // ── Pollrabbit response rewriting ────────────────────────────────────────
  if (name === "pollrabbit") {
    proxyOptions.selfHandleResponse = true;
    proxyOptions.onProxyReq = (proxyReq) => {
      proxyReq.removeHeader('accept-encoding');
      proxyReq.removeHeader('if-none-match');
      proxyReq.removeHeader('if-modified-since');
    };
    proxyOptions.onProxyRes = responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
      if (proxyRes.headers.location && proxyRes.headers.location.startsWith('/')) {
        res.setHeader('location', svcPath + proxyRes.headers.location);
      }
      
      const contentType = proxyRes.headers['content-type'];
      
      if (contentType && contentType.includes('application/json')) {
        let response = responseBuffer.toString('utf8');
        try {
          const json = JSON.parse(response);
          if (json.redirect && json.redirect.startsWith('/')) {
            json.redirect = `${svcPath}${json.redirect}`;
            return Buffer.from(JSON.stringify(json));
          }
        } catch (e) {}
        return responseBuffer;
      }

      if (contentType && (contentType.includes('text/html') || contentType.includes('application/javascript'))) {
        let response = responseBuffer.toString('utf8');
        
        const regexAttr = /(href|src|action|data-poll-url)=["']\/([^"']*)["']/g;
        response = response.replace(regexAttr, (match, attr, path) => {
          if (path.startsWith(svcPath.substring(1))) return match;
          return `${attr}="${svcPath}/${path}"`;
        });
        
        const regexJs = /(fetch\(|redirect:\s*)["']\/([^"']*)["']/g;
        response = response.replace(regexJs, (match, prefix, path) => {
          if (path.startsWith(svcPath.substring(1))) return match;
          return `${prefix}"${svcPath}/${path}"`;
        });
        
        return Buffer.from(response);
      }
      return responseBuffer;
    });
  }

  app.use(svcPath, createProxyMiddleware(proxyOptions));
}

app.get('/debug-logs', (req, res) => {
  res.json(memLogs);
});

// Catch-all to see what is slipping past the proxies
app.use((req, res) => {
  res.status(404).send(`PROXY CATCH-ALL: Cannot ${req.method} ${req.url}`);
});

// ─── Start ────────────────────────────────────────────────────────────────────
const server = http.createServer(app);

// ═══════════════════════════════════════════════════════════════════════════════
// RAW TCP PIPE FOR WEBSOCKET UPGRADES
// ═══════════════════════════════════════════════════════════════════════════════
// WHY: http-proxy-middleware (and the underlying node-http-proxy) silently drops
// WebSocket data frames after hours of uptime. The root cause is buried deep in
// HPM's internal stream management — it uses http.request() to establish the
// upstream connection, which goes through Node's HTTP agent and stream machinery.
// Over time, this machinery accumulates half-closed sockets, aborted requests,
// and stale internal state that causes data frames to be silently swallowed.
//
// The fix: bypass HPM entirely for WebSocket upgrades. Instead, we open a raw
// TCP socket to the backend and pipe the two sockets together directly. This is
// the exact same approach used by nginx, HAProxy, and every other production
// reverse proxy. It has zero moving parts — just two TCP sockets piped together.
//
// Socket.IO (Instacrave) is excluded because it needs HPM's polling-to-WS upgrade
// flow, and Socket.IO has its own heartbeat/reconnection that keeps it stable.
// ═══════════════════════════════════════════════════════════════════════════════

server.on("upgrade", (req, clientSocket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  console.log(`[proxy] WS UPGRADE: ${pathname}`);

  // ── Socket.IO (Instacrave) — delegate to HPM ────────────────────────────
  // Socket.IO needs HPM because it starts with HTTP long-polling before
  // upgrading to WebSocket, and HPM manages that state machine correctly.
  if (pathname.startsWith("/socket.io")) {
    clientSocket.on("error", (err) => {
      console.error(`[proxy] Socket.IO WS socket error:`, err.message);
    });
    socketIoProxy.upgrade(req, clientSocket, head);
    return;
  }

  // ── Raw WebSocket services (Birddrop, Lila, etc.) — raw TCP pipe ───────
  // Find which service this belongs to
  let matchedService = null;
  let matchedPort = null;
  for (const [name, port] of Object.entries(SERVICE_PORTS)) {
    if (pathname.startsWith(`/${name}`)) {
      matchedService = name;
      matchedPort = port;
      break;
    }
  }

  if (!matchedService) {
    console.log(`[proxy] No service match for WS: ${pathname}`);
    clientSocket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  // Rewrite the URL: strip the service prefix
  // e.g., /birddrop/ws?foo=bar → /ws?foo=bar
  const rewrittenPath = req.url.replace(new RegExp(`^/${matchedService}`), "") || "/";
  console.log(`[proxy] WS pipe → ${matchedService}:${matchedPort} (path: ${rewrittenPath})`);

  // Open a raw TCP connection to the backend
  const backendSocket = net.connect(matchedPort, "127.0.0.1", () => {
    // Reconstruct the HTTP upgrade request with the rewritten path
    const headers = [`GET ${rewrittenPath} HTTP/1.1`];
    for (const [key, value] of Object.entries(req.headers)) {
      // Forward all headers except Host (rewrite to localhost)
      if (key.toLowerCase() === 'host') {
        headers.push(`Host: 127.0.0.1:${matchedPort}`);
      } else {
        headers.push(`${key}: ${value}`);
      }
    }
    headers.push("", ""); // Terminate headers with \r\n\r\n
    
    backendSocket.write(headers.join("\r\n"));
    
    // Forward any buffered data from the initial upgrade request
    if (head && head.length > 0) {
      backendSocket.write(head);
    }

    // Pipe the two sockets together — this is the entire WebSocket proxy.
    // No buffering, no intermediate processing, no HPM state machine.
    // Just raw bytes flowing in both directions until one side closes.
    backendSocket.pipe(clientSocket);
    clientSocket.pipe(backendSocket);
  });

  // ── Cleanup: ensure both sockets die together ──────────────────────────
  // This prevents zombie sockets from accumulating over days of uptime.
  function cleanupAll() {
    if (!backendSocket.destroyed) backendSocket.destroy();
    if (!clientSocket.destroyed) clientSocket.destroy();
  }

  clientSocket.on("error", (err) => {
    console.error(`[proxy] WS client socket error (${matchedService}):`, err.message);
    cleanupAll();
  });
  clientSocket.on("close", cleanupAll);

  backendSocket.on("error", (err) => {
    console.error(`[proxy] WS backend socket error (${matchedService}):`, err.message);
    cleanupAll();
  });
  backendSocket.on("close", cleanupAll);

  // TCP keep-alive to prevent silent firewall/NAT drops
  clientSocket.setKeepAlive(true, 15000);
  backendSocket.setKeepAlive(true, 15000);

  // Timeout: if a socket is completely idle for 5 minutes, kill it.
  // This catches edge cases where a mobile client goes to sleep without
  // sending a close frame.
  clientSocket.setTimeout(300000, cleanupAll);
  backendSocket.setTimeout(300000, cleanupAll);
});

// Guard against uncaught errors on the server
server.on("error", (err) => {
  console.error("[proxy] Server error:", err.message);
});

// ─── Process-level crash protection ──────────────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("[proxy] UNCAUGHT EXCEPTION (kept alive):", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("[proxy] UNHANDLED REJECTION (kept alive):", reason);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy listening on port ${PORT}`);
});
