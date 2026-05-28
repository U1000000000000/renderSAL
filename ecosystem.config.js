// ─── Environment Group Helper ─────────────────────────────────────────────────
// On Render's dashboard, prefix every env var with the service name:
//
//   INSTACRAVE_MONGODB_URI=mongodb+srv://...
//   INSTACRAVE_ACCESS_TOKEN_SECRET=mySecretKey
//   LILA_FRONTEND_URL=https://lilakreis.vercel.app
//   LILA_MONGODB_URL=mongodb+srv://...
//   POLLRABBIT_MONGODB_URI=mongodb+srv://...
//   BIRDDROP_ALLOWED_ORIGINS=https://birddrop.vercel.app
//
// This function strips the prefix and returns clean env vars for each process:
//   INSTACRAVE_MONGODB_URI → MONGODB_URI (only visible to instacrave)
//
// Vars without any service prefix are ignored — no accidental leaks.
// The `overrides` object (PORT, NODE_ENV) always takes highest priority.
// ──────────────────────────────────────────────────────────────────────────────

function getServiceEnv(serviceName, overrides = {}) {
  const env = {};
  const prefix = serviceName.toUpperCase() + "_";

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(prefix)) {
      // Strip prefix: INSTACRAVE_MONGODB_URI → MONGODB_URI
      env[key.slice(prefix.length)] = value;
    }
  }

  // Overrides (PORT, NODE_ENV) take highest priority
  return { ...env, ...overrides };
}

module.exports = {
  apps: [
    {
      name: "instacrave",
      script: "server.js",
      cwd: "./instacrave/backend",
      max_memory_restart: "120M",
      env: getServiceEnv("INSTACRAVE", { PORT: 3001, NODE_ENV: "production" }),
    },
    {
      name: "birddrop",
      script: "server.js",
      cwd: "./birddrop/backend",
      max_memory_restart: "100M",
      env: getServiceEnv("BIRDDROP", { PORT: 3002, NODE_ENV: "production" }),
    },
    {
      name: "lila",
      script: "main.py",
      cwd: "./lila/server",
      interpreter: require("path").resolve("./lila/server/.venv/bin/python"),
      max_memory_restart: "100M",
      env: getServiceEnv("LILA", { PORT: 3003, NODE_ENV: "production" }),
    },
    {
      name: "pollrabbit",
      script: "app.js",
      cwd: "./pollrabbit",
      max_memory_restart: "100M",
      env: getServiceEnv("POLLRABBIT", { PORT: 3004, NODE_ENV: "production" }),
    },
    {
      name: "cuber",
      script: "index.js",
      cwd: "./cuber",
      max_memory_restart: "100M",
      env: getServiceEnv("CUBER", { PORT: 3005, NODE_ENV: "production" }),
    },

    // ─── ADD NEW PROJECTS HERE ───────────────────────────────────────────────
    // {
    //   name: "newproject",
    //   script: "index.js",
    //   cwd: "./newproject",
    //   max_memory_restart: "100M",
    //   env: getServiceEnv("NEWPROJECT", { PORT: 3006, NODE_ENV: "production" }),
    // },
    // ─────────────────────────────────────────────────────────────────────────
  ],
};

