/**
 * PM2 ecosystem 設定
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs    # 起動
 *   pm2 save                          # 自動起動設定を保存
 *   pm2 startup                       # OS 起動時に pm2 を自動起動
 *   pm2 logs threadsos-1h             # ログ確認
 *   pm2 stop threadsos-1h             # 停止
 */

module.exports = {
  apps: [
    {
      name: "threadsos-15m",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/jobs/tier-15m.ts",
      cwd: __dirname,
      interpreter: "node",
      cron_restart: "*/15 * * * *",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Tokyo",
      },
      out_file: "logs/tier-15m-out.log",
      error_file: "logs/tier-15m-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
      max_size: "10M",
      retain: 7,
    },
    {
      name: "threadsos-1h",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/jobs/tier-1h.ts",
      cwd: __dirname,
      interpreter: "node",
      cron_restart: "0 * * * *",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Tokyo",
      },
      out_file: "logs/tier-1h-out.log",
      error_file: "logs/tier-1h-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
      max_size: "10M",
      retain: 7,
    },
    {
      name: "threadsos-1d",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/jobs/tier-1d.ts",
      cwd: __dirname,
      interpreter: "node",
      cron_restart: "10 2 * * *",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Tokyo",
      },
      out_file: "logs/tier-1d-out.log",
      error_file: "logs/tier-1d-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
      max_size: "10M",
      retain: 7,
    },
    {
      name: "threadsos-1w",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/jobs/tier-1w.ts",
      cwd: __dirname,
      interpreter: "node",
      cron_restart: "20 3 * * 1",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Tokyo",
      },
      out_file: "logs/tier-1w-out.log",
      error_file: "logs/tier-1w-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
      max_size: "10M",
      retain: 7,
    },
    {
      name: "llm-worker",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/jobs/llm-heartbeat-worker.ts",
      cwd: __dirname,
      interpreter: "node",
      // 常時起動（DBをポーリングしてLLMタスクを処理）
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Tokyo",
      },
      out_file: "logs/llm-worker-out.log",
      error_file: "logs/llm-worker-error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
      max_size: "10M",
      retain: 7,
    },
  ],
};
