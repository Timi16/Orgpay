// pm2 process file: the API and the worker (one codebase, two processes) and the dashboard.
//   pm2 start ecosystem.config.cjs && pm2 save && pm2 startup     (first time)
//   pm2 reload ecosystem.config.cjs --update-env                  (after a deploy; deploy/deploy.sh does it)
// The API and worker read the repo-root .env through Node's --env-file. The dashboard's settings
// (NEXT_PUBLIC_API_URL, NEXT_PUBLIC_SITE_URL) are baked in at build time from apps/web/.env.production.
const path = require("node:path");

const api = {
  cwd: path.join(__dirname, "apps/api"),
  node_args: "--max-old-space-size=256 --env-file=../../.env",
  exec_mode: "fork",
  instances: 1,
  autorestart: true,
  max_memory_restart: "320M",
  exp_backoff_restart_delay: 1000,
  env: { NODE_ENV: "production" },
  time: true,
};

module.exports = {
  apps: [
    {
      ...api,
      name: "orgpay-api",
      script: "dist/server.js",
      // SIGTERM: stop accepting, finish in-flight requests, disconnect.
      kill_timeout: 15000,
    },
    {
      ...api,
      // Run exactly ONE worker: it settles open transactions and must not race itself.
      name: "orgpay-worker",
      script: "dist/worker.js",
      // SIGTERM: finish the current settle (it holds a row lock), then exit.
      kill_timeout: 70000,
    },
    {
      name: "orgpay-web",
      cwd: path.join(__dirname, "apps/web"),
      script: "node_modules/next/dist/bin/next",
      // Loopback only: Caddy is the one way in.
      args: "start -H 127.0.0.1 -p 3400",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "400M",
      exp_backoff_restart_delay: 1000,
      env: { NODE_ENV: "production" },
      time: true,
    },
  ],
};
