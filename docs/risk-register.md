# Risk Register

| リスク | 影響度 | 対策 |
|---|---|---|
| Threads API レート制限 | 中 | リトライ + バックオフ |
| note 非公式API依存 | 高 | research_only モードで回避 |
| 自動返信による炎上 | 高 | safe判定 + human review |
| LLM による誤情報生成 | 高 | 監査パイプライン + human review |
| DB破損 | 中 | バックアップ + 冪等ジョブ |
| API トークン漏洩 | 高 | .env を gitignore + permissions.deny |
