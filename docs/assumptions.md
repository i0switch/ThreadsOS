# Assumptions

このファイルには、実装中に判明した仮定や不明点を記録します。

## Phase 1
- Threads API のアクセストークンは環境変数で渡す想定
- SQLite のDBファイルは data/threads-note-os.db に配置
- LLM API は Claude API を想定するが、インターフェースで抽象化
- biome を lint に採用（eslint より設定が軽い）
