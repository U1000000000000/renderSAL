const express = require("express");
const http = require("http");
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

// ─── Request Logging (concise) ────────────────────────────────────────────────
app.use((req, res, next) => {
  console.log(`[proxy] ${req.method} ${req.url}`);
  next();
});

// ─── Health check (UptimeRobot pings this) ───────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── WebSocket Upstream/Downstream Sync & Agent Config ───────────────────────
// CRITICAL: By default, http-proxy uses http.globalAgent (keepAlive: true in modern Node).
// When a WebSocket disconnects, http-proxy ends the upstream socket but does not destroy it.
// This causes zombie keep-alive sockets to accumulate in http.globalAgent, permanently
// breaking or hanging all subsequent WebSocket upgrade attempts (e.g. second try fails).
// We set agent: false to guarantee a fresh, unpooled TCP socket for every connection,
// actively destroy both upstream and downstream sockets on any disconnect/error,
// and enforce kernel-level TCP keep-alive to prevent silent firewall/NAT drops over days.

function handleProxyReqWs(proxyReq, req, socket) {
  if (socket && socket.setKeepAlive) {
    socket.setKeepAlive(true, 15000);
  }

  function cleanupProxyReq() {
    if (!proxyReq.destroyed) proxyReq.destroy();
  }
  socket.on('error', cleanupProxyReq);
  socket.on('close', cleanupProxyReq);

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    if (proxySocket && proxySocket.setKeepAlive) {
      proxySocket.setKeepAlive(true, 15000);
    }

    function cleanupUpstream() {
      if (!proxySocket.destroyed) proxySocket.destroy();
    }
    function cleanupDownstream() {
      if (!socket.destroyed) socket.destroy();
    }

    socket.on('error', cleanupUpstream);
    socket.on('close', cleanupUpstream);

    proxySocket.on('error', cleanupDownstream);
    proxySocket.on('close', cleanupDownstream);
  });
}

// ─── Root — quick index so you know what's running ───────────────────────────
app.get("/", (req, res) => {
  res.json({
    message: "Render wrapper running",
    services: [
      { name: "instacrave", path: "/instacrave" },
      { name: "birddrop",   path: "/birddrop"   },
      { name: "lila",       path: "/lila"       },
      { name: "pollrabbit", path: "/pollrabbit" },
      { name: "cuber",      path: "/cuber"      },
    ],
  });
});

// ─── Socket.IO direct route (instacrave) ─────────────────────────────────────
// Socket.IO clients connect to the origin and always send requests to /socket.io/
// by default. This route forwards those directly to instacrave (port 3001)
// WITHOUT path rewriting — the backend Socket.IO server expects /socket.io/.
//
// This MUST be registered before the generic service routes so /socket.io/
// doesn't fall through to the catch-all 404.
const socketIoProxy = createProxyMiddleware({
  target: "http://127.0.0.1:3001",
  changeOrigin: true,
  ws: true,
  agent: false, // Prevent globalAgent socket pooling corruption
  // No pathRewrite — keep /socket.io/ as-is for the backend
  logLevel: "warn",
  onError: (err, req, res) => {
    console.error("[proxy] Socket.IO proxy error:", err.message);
    if (res && res.writeHead) {
      res.writeHead(502);
      res.end("Socket.IO service unavailable");
    } else if (res && res.destroy) {
      // For WebSockets, 'res' is the socket
      res.destroy();
    }
  },
  onProxyReqWs: handleProxyReqWs,
});
app.use("/socket.io", socketIoProxy);

// ─── Service routes ───────────────────────────────────────────────────────────
// Each service gets its own path prefix.
// Requests to /instacrave/anything → forwarded to localhost:3001/anything
// The pathRewrite strips the prefix so your apps don't need to know about it.

const services = [
  { path: "/instacrave", port: 3001 },
  { path: "/birddrop",   port: 3002 },
  { path: "/lila",       port: 3003 },
  { path: "/pollrabbit", port: 3004 },
  { path: "/cuber",      port: 3005 },
];

// Keep references to proxy middlewares for WebSocket upgrade handling
const proxyMiddlewares = [];

// Socket.IO proxy is first in the list for upgrade matching
proxyMiddlewares.push({ path: "/socket.io", proxy: socketIoProxy });

for (const svc of services) {
  let proxyOptions = {
    target: `http://127.0.0.1:${svc.port}`,
    changeOrigin: true,
    agent: false, // Prevent globalAgent socket pooling corruption
    pathRewrite: (path, req) => {
      const newPath = path.replace(new RegExp(`^${svc.path}`), "");
      return newPath === "" ? "/" : newPath;
    },
    ws: true,
    onError: (err, req, res) => {
      console.error(`[proxy] ${svc.path} error:`, err.message);
      if (res && res.writeHead) {
        res.writeHead(502);
        res.end(`Service ${svc.path} is unavailable`);
      } else if (res && res.destroy) {
        // For WebSockets, 'res' is the socket
        res.destroy();
      }
    },
    onProxyReqWs: handleProxyReqWs
  };

  if (svc.path === "/pollrabbit") {
    proxyOptions.selfHandleResponse = true;
    proxyOptions.onProxyReq = (proxyReq, req, res) => {
      proxyReq.removeHeader('accept-encoding');
      proxyReq.removeHeader('if-none-match');
      proxyReq.removeHeader('if-modified-since');
    };
    proxyOptions.onProxyRes = responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
      if (proxyRes.headers.location && proxyRes.headers.location.startsWith('/')) {
        res.setHeader('location', svc.path + proxyRes.headers.location);
      }
      
      const contentType = proxyRes.headers['content-type'];
      
      if (contentType && contentType.includes('application/json')) {
        let response = responseBuffer.toString('utf8');
        try {
          const json = JSON.parse(response);
          if (json.redirect && json.redirect.startsWith('/')) {
            json.redirect = `${svc.path}${json.redirect}`;
            return Buffer.from(JSON.stringify(json));
          }
        } catch (e) {}
        return responseBuffer;
      }

      if (contentType && (contentType.includes('text/html') || contentType.includes('application/javascript'))) {
        let response = responseBuffer.toString('utf8');
        
        const regexAttr = /(href|src|action|data-poll-url)=["']\/([^"']*)["']/g;
        response = response.replace(regexAttr, (match, attr, path) => {
          if (path.startsWith(svc.path.substring(1))) return match;
          return `${attr}="${svc.path}/${path}"`;
        });
        
        const regexJs = /(fetch\(|redirect:\s*)["']\/([^"']*)["']/g;
        response = response.replace(regexJs, (match, prefix, path) => {
          if (path.startsWith(svc.path.substring(1))) return match;
          return `${prefix}"${svc.path}/${path}"`;
        });
        
        return Buffer.from(response);
      }
      return responseBuffer;
    });
  }

  const proxy = createProxyMiddleware(proxyOptions);
  app.use(svc.path, proxy);
  proxyMiddlewares.push({ path: svc.path, proxy });
}

app.get('/debug-logs', (req, res) => {
  res.json(memLogs);
});



// Catch-all to see what is slipping past the proxies
app.use((req, res) => {
  res.status(404).send(`PROXY CATCH-ALL: Cannot ${req.method} ${req.url}`);
});

// ─── Start ────────────────────────────────────────────────────────────────────
// Use http.createServer so we can manually handle WebSocket upgrade events.
// Express's app.listen() doesn't expose the raw 'upgrade' event to
// http-proxy-middleware, so WebSocket connections would fail silently.
const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  console.log(`[proxy] WS UPGRADE: ${req.url}`);

  // Prevent unhandled socket errors from crashing the proxy
  socket.on("error", (err) => {
    console.error(`[proxy] WS socket error during upgrade:`, err.message);
  });

  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    
    // Find which service this WebSocket upgrade belongs to.
    // proxyMiddlewares is ordered: /socket.io first, then /instacrave, /birddrop, etc.
    const match = proxyMiddlewares.find((m) => pathname.startsWith(m.path));
    if (match) {
      // CRITICAL: http-proxy-middleware's upgrade() does NOT apply pathRewrite.
      // We must manually rewrite req.url before forwarding, otherwise the
      // backend receives the full prefixed path (e.g. /birddrop/ws instead of /ws)
      // and the WebSocket server silently drops data or rejects the connection.
      //
      // Exception: /socket.io does NOT need rewriting — it maps 1:1 to the backend.
      if (match.path !== "/socket.io") {
        req.url = req.url.replace(new RegExp(`^${match.path}`), "") || "/";
      }
      console.log(`[proxy] WS upgrade → ${match.path} (rewritten url: ${req.url})`);
      match.proxy.upgrade(req, socket, head);
    } else {
      console.log(`[proxy] No match for WS upgrade: ${req.url}`);
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  } catch (err) {
    console.error(`[proxy] URL parsing error for WS upgrade:`, err);
    socket.destroy();
  }
});

// Guard against uncaught errors on the server
server.on("error", (err) => {
  console.error("[proxy] Server error:", err.message);
});

// ─── Process-level crash protection ──────────────────────────────────────────
// Without these, ANY unhandled error from http-proxy internals will crash the
// entire proxy process, killing ALL active WebSocket connections for ALL services.
process.on("uncaughtException", (err) => {
  console.error("[proxy] UNCAUGHT EXCEPTION (kept alive):", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("[proxy] UNHANDLED REJECTION (kept alive):", reason);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy listening on port ${PORT}`);
});
