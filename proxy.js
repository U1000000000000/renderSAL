const express = require("express");
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

for (const svc of services) {
  app.use(
    svc.path,
    createProxyMiddleware({
      target: `http://localhost:${svc.port}`,
      changeOrigin: true,
      pathRewrite: { [`^${svc.path}`]: "" },
      // WebSocket support — BirdDrop needs this
      ws: true,
      on: {
        error: (err, req, res) => {
          console.error(`[proxy] ${svc.path} error:`, err.message);
          if (res.writeHead) {
            res.writeHead(502);
            res.end(`Service ${svc.path} is unavailable`);
          }
        },
      },
    })
  );
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy listening on port ${PORT}`);
});
