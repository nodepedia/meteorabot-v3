// OPTIONAL: Runner Alert worker, meant for a separate VPS.
// pm2 start ecosystem.runner.config.cjs
const path = require("path");

module.exports = {
  apps: [
    {
      name: "meteorabot-runner",
      script: "src/worker-runner.js",
      cwd: path.resolve(__dirname),
      watch: false,
      max_memory_restart: "500M",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      autorestart: true,
      error_file: "./logs/runner-error.log",
      out_file: "./logs/runner-out.log",
    },
  ],
};
