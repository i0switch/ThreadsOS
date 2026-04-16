---
{
  "id": "rate-budget",
  "kind": "policy",
  "name": "rate-budget",
  "scope": "runners_and_platforms",
  "summary": "runner ごとの予算と投稿レートを deterministic に制御する",
  "rules": [
    "日次上限と heartbeat 窓上限を守る",
    "緊急予算は通常運転と分離する",
    "予算超過時は degrade する"
  ],
  "thresholds": {
    "degradedAt": 0.8,
    "emergencyAt": 0.95,
    "tokensPerHeartbeat": 50000,
    "callsPerHeartbeat": 30,
    "deptTokensPerHeartbeat": 10000,
    "deptCallsPerHeartbeat": 10
  },
  "publishCaps": {
    "maxPostsPerHour": 10,
    "maxRepliesPerHour": 30
  }
}
---
# rate-budget

投稿数、runner 呼び出し、token 使用量は DB 上の budget governor を唯一の基準にする。

## publishCaps

1時間窓あたりの投稿/返信の上限は policy で定義する。env の MAX_POSTS_PER_HOUR /
MAX_REPLIES_PER_HOUR はオペレーター指定値で、policy の上限より大きい値を指定した
場合は contract compiler が起動時に警告し、実行時は min(env, policyCap) を使う。
