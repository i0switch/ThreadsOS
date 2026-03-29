# Review Findings

実施日: 2026-03-28
対象: `C:\Users\i0swi\Desktop\ThreadsOS`

## Finding 1

### [P1] post-publish-followup が成功扱いのまま何もしていない

対象: `src/services/orchestration/index.ts:98-105`

`post-publish-followup` ジョブは本番実行時でも返信取得や分類を一切行わず、固定文字列を返して終了する。
そのためジョブ履歴上は `completed` になり、運用側はフォローアップが正常に回ったと誤認する。

少なくとも以下のどれかが必要:

- 対象投稿の取得
- `fetchAndClassifyReplies` の実呼び出し
- 未実装時は成功扱いではなく失敗扱いにする分岐

## Finding 2

### [P2] 同じ draft を再監査すると unique 制約で落ちる

対象: `src/services/post-audit/index.ts:42-50`

`thread_post_audits.draft_id` は一意なのに、`auditDraft` は既存監査の有無を見ずに毎回 `insert` している。
再監査フローやリトライ時に SQLite の unique constraint violation でジョブ全体が失敗する。

対応案:

- `upsert` にする
- 既存レコードを更新する
- 監査の再実行を許可しないなら明示的にガードする

## Finding 3

### [P2] note 監査も再実行で同じく落ちる

対象: `src/services/note-audit/index.ts:65-74`

`note_audits.draft_id` も一意なのに、こちらも再監査時に無条件 `insert` している。
記事監査は書き直し後に複数回走らせやすいので、実運用で踏みやすい障害になっている。

あわせて `human_review_items` の重複作成も起こりうるため、監査レコード更新とレビューアイテム重複防止をセットで吸収した方が安全。

## Finding 4

### [P2] Threads プロフィール画像 URL が常に欠落する

対象: `src/adapters/threads-api/index.ts:135-138`

`/me?fields=id,username,threads_profile_picture_url` のレスポンスは snake_case だが、戻り値型では `threadsProfilePictureUrl` をそのまま期待している。
変換していないため、このメソッド利用側ではプロフィール画像 URL が `undefined` になる。

対応案:

- APIレスポンスを snake_case で受ける
- 戻り値を camelCase に変換して返す

## メモ

- 実行検証は環境側の `EPERM: lstat 'C:\\Users\\i0swi\\Desktop'` により完了できなかった
- [tests/server.test.ts](C:/Users/i0swi/Desktop/ThreadsOS/tests/server.test.ts) は実サーバー本体ではなく、その場で作った Fastify を検証していてテストギャップがある
