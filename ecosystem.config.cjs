// pm2 process file: the API and the worker (one codebase, two processes). The dashboard is on Vercel.
//   pm2 start ecosystem.config.cjs && pm2 save && pm2 startup     (first time)
//   pm2 reload ecosystem.config.cjs --update-env                  (after a deploy; deploy/deploy.sh does it)
// The API and worker read the repo-root .env through Node's --env-file.
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
  ],
};
