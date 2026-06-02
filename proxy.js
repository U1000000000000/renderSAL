const express = require("express");
const http = require("http");
const { createProxyMiddleware, responseInterceptor } = require("http-proxy-middleware");

const app = express();
const PORT = process.env.PORT || 10000;

// ─── Request Logging ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  console.log(`[proxy] HTTP REQ: ${req.method} ${req.url} - Headers: ${JSON.stringify(req.headers)}`);
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
    services: [
      { name: "instacrave", path: "/instacrave" },
      { name: "birddrop",   path: "/birddrop"   },
      { name: "lila",       path: "/lila"       },
      { name: "pollrabbit", path: "/pollrabbit" },
      { name: "cuber",      path: "/cuber"      },
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
];

// Keep references to proxy middlewares for WebSocket upgrade handling
const proxyMiddlewares = [];

for (const svc of services) {
  let proxyOptions = {
    target: `http://127.0.0.1:${svc.port}`,
    changeOrigin: true,
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
      }
    }
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
  console.log(`[proxy] WS UPGRADE ATTEMPT: ${req.url}`);
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    
    // Find which service this WebSocket upgrade belongs to
    const match = proxyMiddlewares.find((m) => pathname.startsWith(m.path));
    if (match) {
      console.log(`[proxy] Match found for WS upgrade: ${match.path}`);
      match.proxy.upgrade(req, socket, head);
    } else {
      console.log(`[proxy] No match for WS upgrade: ${req.url}, destroying socket`);
      socket.destroy();
    }
  } catch (err) {
    console.error(`[proxy] URL parsing error for WS upgrade:`, err);
    socket.destroy();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy listening on port ${PORT}`);
});
