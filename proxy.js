const express = require("express");
const http = require("http");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
const PORT = process.env.PORT || 10000;

// ─── Health check (UptimeRobot pings this) ───────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Root — quick index so you know what's running ───────────────────────────
app.get("/", (req, res) => {
  res.json({
    message: "Render wrapper running",
    services: [
      { name: "instacrave", path: "/instacrave" },
      { name: "birddrop",   path: "/birddrop"   },
      { name: "lila",   path: "/lila"   },
      { name: "pollrabbit",   path: "/pollrabbit"   },
      { name: "cuber",   path: "/cuber"   },
    ],
  });
});

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

  // ─── ADD NEW PROJECTS HERE ─────────────────────────────────────────────────
  // { path: "/newproject", port: 3006 },
  // ───────────────────────────────────────────────────────────────────────────
];

// Keep references to proxy middlewares for WebSocket upgrade handling
const proxyMiddlewares = [];

for (const svc of services) {
  const proxy = createProxyMiddleware({
    target: `http://127.0.0.1:${svc.port}`,
    changeOrigin: true,
    pathRewrite: (path, req) => {
      const newPath = path.replace(new RegExp(`^${svc.path}`), "");
      return newPath === "" ? "/" : newPath;
    },
    // WebSocket support — BirdDrop and Lila need this
    ws: true,
    onError: (err, req, res) => {
      console.error(`[proxy] ${svc.path} error:`, err.message);
      if (res.writeHead) {
        res.writeHead(502);
        res.end(`Service ${svc.path} is unavailable`);
      }
    },
  });

  app.use(svc.path, proxy);
  proxyMiddlewares.push({ path: svc.path, proxy });
}

// ─── Start ────────────────────────────────────────────────────────────────────
// Use http.createServer so we can manually handle WebSocket upgrade events.
// Express's app.listen() doesn't expose the raw 'upgrade' event to
// http-proxy-middleware, so WebSocket connections would fail silently.
const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  // Find which service this WebSocket upgrade belongs to
  const match = proxyMiddlewares.find((m) => req.url.startsWith(m.path));
  if (match) {
    match.proxy.upgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy listening on port ${PORT}`);
});
