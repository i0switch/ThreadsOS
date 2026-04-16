# Progress

## Phase 1: コア土台 (完了 2026-03-28)
- [x] プロジェクト初期化 (package.json, tsconfig, biome, vitest)
- [x] ディレクトリ構成 (src/, docs/, prompts/, data/, .claude/, tests/)
- [x] 型定義・設定 (zod環境変数スキーマ、ドメインモデル14エンティティ)
- [x] SQLite + drizzle (15テーブル定義、マイグレーション)
- [x] ロギング・エラーハンドリング・ジョブ基盤 (pino, AppError, runJob)
- [x] README

## Phase 2: Threads運用OS (完了 2026-03-28)
- [x] Adapters実装 (ThreadsGraphApiClient, ClaudeLlmClient, FileSystemStorageClient)
- [x] DryRun対応 (DryRunThreadsApiClient, DryRunLlmClient)
- [x] ジャンル候補管理 (TopicSelectionService)
- [x] 競合・市場トピック調査 (ResearchService)
- [x] 投稿案生成 (PostGenerationService - LLM連携、5本一括生成)
- [x] 投稿監査 (PostAuditService - 9基準監査、auditor / quarantine 連携)
- [x] 返信取得・自動分類 (EngagementAnalysisService - LLM分類)
- [x] 安全な返信のみ自動送信 (safe_auto_reply判定)
- [x] エンゲージメント解析 (analyzePostPerformance)
- [x] 改善提案生成 (ImprovementInsight)
- [x] Orchestration (5パイプライン統合)
- [x] Jobs中身実装 (5ジョブ、すべてdry-run対応)
- [x] CLI (setup / input / note-login)
- テスト: 5ファイル13テスト全パス

## Phase 3: note運用OS (完了 2026-03-28)
- [x] note-research adapter (NoteResearchClientImpl - 公開ページHTML取得、DryRun対応)
- [x] noteネタ候補生成 (NoteGenerationService.createIdea)
- [x] noteタイトル案生成 (generateTitleCandidates - LLM連携、5候補)
- [x] 構成生成 (generateOutline - LLM連携)
- [x] 本文ドラフト生成 (generateDraft - LLM連携、CTA自動生成)
- [x] note監査 (NoteAuditService - 9基準、auditor / quarantine 連携)
- [x] 公開候補キュー (content slots / proposal flow 連携)
- [x] note競合調査 (ResearchService.saveCompetitorSnapshot / getRecentSnapshots)
- [x] 手動公開フローチェックリスト生成 (generateChecklist)
- [x] nightly-note-pipeline ジョブ実装 (Orchestration統合)
- テスト: 6ファイル16テスト全パス

## Phase 4: Claude Code運用基盤
- [x] .claude/agents/ (6エージェント: strategist, researcher, copywriter, auditor, analyst, ops)
- [x] .claude/skills/ (9スキル + delegate-check)
- [x] .claude/scripts/ (4フックスクリプト: secret-read-guard, bash-guard, post-edit-check, save-runlog)
- [x] .claude/settings.json.example
- [x] prompts/scheduled/ (5プロンプトテンプレート)
- [x] docs/ (architecture, progress, assumptions, runbook, risk-register, operating-model)
