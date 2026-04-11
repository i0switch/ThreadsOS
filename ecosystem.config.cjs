/**
 * PM2 ecosystem 設定
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs    # 起動
 *   pm2 save                          # 自動起動設定を保存
 *   pm2 startup                       # OS 起動時に pm2 を自動起動
 *   pm2 logs threads-heartbeat        # ログ確認
 *   pm2 stop threads-heartbeat        # 停止
 */

module.exports = {
  apps: [
    {
      name: "threads-heartbeat",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/jobs/hourly-heartbeat.ts",
      cwd: __dirname,
      interpreter: "node",
      // 毎時 0 分に起動（cron_restart は停止→再起動なので、1回実行 + 次回まで待機）
      cron_restart: "0 * * * *",
      // 1 回実行したら自動停止（cron で再起動されるのを待つ）
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Tokyo",
      },
      // ログ設定
      out_file: "logs/heartbeat-out.log",
      error_file: "logs/heartbeat-error.log",
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
