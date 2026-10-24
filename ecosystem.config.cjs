const path = require("path");

const baseConfig = {
  cwd: path.resolve(__dirname),
  watch: false,
  max_memory_restart: "500M",
  log_date_format: "YYYY-MM-DD HH:mm:ss Z",
  merge_logs: true,
  autorestart: true,
};

module.exports = {
  apps: [
    {
      ...baseConfig,
      name: "meteorabot-entry",
      script: "src/worker-entry.js",
      error_file: "./logs/entry-error.log",
      out_file: "./logs/entry-out.log",
    },
    {
      ...baseConfig,
      name: "meteorabot-exit",
      script: "src/worker-exit.js",
      error_file: "./logs/exit-error.log",
      out_file: "./logs/exit-out.log",
    },
    {
      ...baseConfig,
      name: "meteorabot-wallet",
      script: "src/worker-wallet.js",
      error_file: "./logs/wallet-error.log",
      out_file: "./logs/wallet-out.log",
    },
  ],
};
