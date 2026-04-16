# ThreadsOS ダッシュボード監査レポート

**監査日**: 2026-04-11
**対象**: `src/dashboard/public/index.html`, `src/dashboard/routes.ts`, `src/services/dashboard-query/index.ts`
**監査基準**: 初心者向け販売アプリとしての適切性 + 15要件の充足度

---

## 総評

### 現在のダッシュボードの本質的な問題

情報設計は「ストーリー型」で良い方向に進んでいるが、homeSection が詰め込みすぎで初心者が最初の1画面で迷子になる。ユーザーの「最初の行動」へのフォーカスが、homeSection の長さとinboxSectionの位置（2番目）によって弱まっている。また、バックエンドで `getSummary()` が各APIから再帰的に呼ばれ、1サイクルで5回以上重複実行される構造上の問題がある。

### 良い点

- 情報設計が「機能別（agents/logs/KPI）」ではなく「意味別・ストーリー別」に構成されている
- 文言がほぼ全面的に日本語化され、内部英語テームが `humanizeInternalText()` で自動変換される
- KPI/ログ/予算が「例外対応と詳細データ」として隠され、初心者の認知負荷を下げている
- 右サイドバーの詳細パネル（sticky）で一覧→詳細のスクロール往復を解消している
- setup checklistで「最初に必要な4つ」が明示されている
- ファネルセクションでThreads→note導線が1本の流れとして可視化されている

### 初心者向けとして弱い点

- homeSectionが巨大（hero + checklist + heartbeat + funnelPreview + todayResults + stoppedItems + aiActivityの7ブロック）で、初心者が何を見ればいいか迷う
- 「あなたの確認待ち」がhomeの下にあり、最初に目に入らない
- 8セクション全てが1ページにスクロール配置で、ナビゲーション/TOCがない
- 「AIの判断」「管理者の行動履歴」は中上級者向けだが、メインフローに混在
- モバイルで右サイドバーが使えない（xl breakpointでsticky）

### 最優先で直すべき点

1. **「あなたの確認待ち」をhomeの上またはhomeの最上部に移動**
2. **homeSectionのコンテンツ量を削減し、核心だけに絞る**
3. **バックエンドの`getSummary()`重複呼び出しを解消**

---

## 要件別監査結果

### 要件1

- **要件**: トップ画面だけで「今なにが起きているか」が分かる
- **判定**: 実装済み
- **根拠**: `homeSection` がページ最上部に配置。`getDashboardHome()` が返す `hero`（health/healthHeadline）、`setupChecklist`（4点の進捗）、`heartbeatLoop`（前回/次回時刻）、`todayResults`（投稿数・note公開数・止まり数・AI実行回数の4枚カード）、`stoppedItems`、`aiActivity` が一画面に集約されている。hero.titleは `"Threadsは稼働中、noteは稼働中、大きな確認待ちはなし"` のような自然文を生成。
- **不足点**: 情報密度が高すぎて「一目で」把握するには多い。hero + setupChecklist + heartbeatLoop + funnelPreview + todayResults + stoppedItems + aiActivityの7ブロックが1セクションに入っている。
- **該当ファイル**: `src/dashboard/public/index.html:52-57`, `src/services/dashboard-query/index.ts:1938-2244`
- **該当関数/API/描画箇所**: `homeHtml()` (index.html:209), `/api/dashboard/home` (routes.ts:11-13)

---

### 要件2

- **要件**: ユーザーが最初に「自分が今なにを判断すればよいか」を理解できる
- **判定**: 一部実装
- **根拠**: `inboxSection` が2番目に配置（index.html:59-63）。ラベルは「あなたの確認待ち」「先に見てほしいこと」で適切。`getDashboardInbox()` は proposals/reviews/stalls を統合し、`requiresDecision` フラグと `requestedDecision` テキストを提供。詳細パネルでは承認/却下ボタンまで表示（index.html:241）。
- **不足点**: `awaitingConfirmation` データは `getDashboardHome()` レスポンスに含まれるが、`homeHtml()` 内では stoppedItems + todayResults の間に埋もれており、最上部に確認待ち件数を明示する要素がない。homeSection自体が長大で、inboxSectionが画面下にプッシュされる。初心者が「まず何をする？」に辿り着くまでにスクロールが必要。
- **該当ファイル**: `src/dashboard/public/index.html:59-63`, `src/services/dashboard-query/index.ts:1798-1936`
- **該当関数/API/描画箇所**: `inboxHtml()` (index.html:234), `getDashboardInbox()`, `getDashboardHome().awaitingConfirmation` (index.ts:2186-2200)

---

### 要件3

- **要件**: 各部署が「何をしているか」「なぜそれをしているか」が分かる
- **判定**: 実装済み
- **根拠**: `storyboardSection`（index.html:66-71）が5チーム（管理・指揮系統、外部リサーチ部署、競合リサーチ分析部署、Threads運用部署、note運用部署）を流れで表示。各チームカードに `purpose`（役割）、`nowDoing`（いま何をしているか）、`basedOn`（根拠）、`handoffTo`（次につなぐ先）を表示。`getDashboardStoryboard()` (index.ts:2246-2414) が `blueprints` で各チームの定義を持ち、`signals.inputs/outputs` から根拠と成果を取得。
- **不足点**: なし。要件を十分に満たしている。
- **該当ファイル**: `src/services/dashboard-query/index.ts:2263-2309`, `src/dashboard/public/index.html:66-71`
- **該当関数/API/描画箇所**: `storyboardHtml()` (index.html:235), `getDashboardStoryboard()`, `/api/dashboard/storyboard`

---

### 要件4

- **要件**: AIが「何を見て」「どう判断して」「何を実行したか」が読める
- **判定**: 実装済み
- **根拠**: `decisionsSection`（index.html:80-84）がAIの判断フィードを表示。`getDashboardDecisions()` (index.ts:2416-2485) が `proposals` と `optimizationDecisions` を統合し、各判断に `seenInformation`（見た情報）、`judgment`（判断理由）、`execution`（実行内容）、`expectedResult`（期待結果）を生成。詳細パネル（index.html:243）で「見た情報」「判断」「実行内容」「期待している結果」の4セクションを表示。
- **不足点**: なし。
- **該当ファイル**: `src/services/dashboard-query/index.ts:2416-2485`, `src/dashboard/public/index.html:80-84`
- **該当関数/API/描画箇所**: `decisionsHtml()` (index.html:237), `getDashboardDecisions()`, renderDetail decision分岐 (index.html:243)

---

### 要件5

- **要件**: 管理者が「何を承認・却下・停止・再開・指示したか」が追える
- **判定**: 実装済み
- **根拠**: `timelineSection`（index.html:86-90）が混合タイムラインを表示。`getDashboardTimeline()` (index.ts:2487-2703) が systemControls（pause/resume）、humanInputs（directives）、proposalEvents（approval/rejection）、humanReviewItems、scheduledJobRuns、optimizationDecisions を全て時系列マージ。各イベントに `actorType` ("human"/"ai"/"system") と `kind` (approval/rejection/pause/resume/directive等) を付与。`recordProposalEvent()` (index.ts:23-43) が承認・却下時に履歴を記録。
- **不足点**: フィルタ機能がなく、管理者アクションだけを抽出できない（AI/system/humanが混在）。
- **該当ファイル**: `src/services/dashboard-query/index.ts:2487-2703`, `src/dashboard/public/index.html:86-90`
- **該当関数/API/描画箇所**: `timelineHtml()` (index.html:238), `getDashboardTimeline()`, `recordProposalEvent()` (index.ts:23-43)

---

### 要件6

- **要件**: Threadsとnoteが別々ではなく、集客→収益化導線として見える
- **判定**: 実装済み
- **根拠**: `funnelSection`（index.html:73-78）が「集客から収益化までの現在地」として4ステージ（テーマ軸→Threadsでの集客→Threadsからnoteへの橋渡し→noteでの収益化）を一本の流れで表示。`getDashboardFunnel()` (index.ts:1635-1796) が `stages` 配列で theme/threads/bridge/note を構成。homeSection内にも `funnelPreview`（Threads側/note側/いまの詰まり）を埋め込み。
- **不足点**: なし。
- **該当ファイル**: `src/services/dashboard-query/index.ts:1635-1796`, `src/dashboard/public/index.html:73-78`
- **該当関数/API/描画箇所**: `funnelHtml()` (index.html:236), `getDashboardFunnel()`, funnelPreview in homeHtml (index.html:231)

---

### 要件7

- **要件**: 監視UIではなく、AI組織の運用フローが見える
- **判定**: 実装済み
- **根拠**: storyboardSection（index.html:235）で5チームが縦に接続線（`.absolute -top-4` のグラデーション線）でつながり、受け渡しフローを視覚化。各チームに「役割」「根拠」「次につなぐ先」を明示。ラベルは「AIチームの流れ」「どのチームが、何をつないでいるか」。ステータスは「稼働中」「注意」「停滞」「待機中」の4値で運用状態を表現。
- **不足点**: 接続線がCSSの絶対位置divのみで、フローチャート的な視覚的ガイダンスとしては弱い。
- **該当ファイル**: `src/dashboard/public/index.html:235`, `src/services/dashboard-query/index.ts:2263-2309`
- **該当関数/API/描画箇所**: `storyboardHtml()`, `getDashboardStoryboard()`

---

### 要件8

- **要件**: 初心者でも理解できる文言になっている
- **判定**: 実装済み
- **根拠**: UI文言が全面日本語化。`humanizeInternalText()` (index.ts:192-241) が35のRegExパターンで英語内部用語を日本語に変換（例: "Auto-published 3 threads posts" → "Threads投稿を3件自動公開"）。ステータスラベルは「稼働中/注意/停滞/待機中」。セクションヘッダーに「最初にやるのは4つだけ」「通常はここを開かなくていい」等の案内文。`setupStatusLabel()` で「完了/確認中/未設定」。`DEPARTMENT_DISPLAY_NAMES` で部署名を日本語化。
- **不足点**: 「ハートビート」「ファネル」「導線」等のカタカナ専門用語がそのまま使われている箇所がある。完全初心者にはやや不親切。ただし説明文がカバーしている部分が多い。
- **該当ファイル**: `src/services/dashboard-query/index.ts:192-241`, `src/services/dashboard-query/index.ts:99-106`
- **該当関数/API/描画箇所**: `humanizeInternalText()`, `humanizePolicyText()`, `operationalStatusLabel()`, `storyboardStatusLabel()`, `setupStatusLabel()`

---

### 要件9

- **要件**: 一覧→詳細の導線が見やすい
- **判定**: 実装済み
- **根拠**: 右サイドバー（index.html:157-164）が `xl:sticky xl:top-5` で固定。全リスト項目が `<button data-select-kind data-select-id>` で統一的にクリック可能。`choose()` (index.html:189) で選択、`renderDetail()` (index.html:240) で6種類（inbox/team/decision/timeline/funnel-stage/funnel）の詳細表示を分岐。選択中は `.active` クラスでハイライト（border-color + box-shadow変化）。
- **不足点**: xl（1280px）以下の画面幅ではstickyが効かず、詳細パネルがメイン下部に落ちる。モバイルでは一覧→詳細の導線が実質壊れる。
- **該当ファイル**: `src/dashboard/public/index.html:157-164`, `src/dashboard/public/index.html:240-247`
- **該当関数/API/描画箇所**: `renderDetail()`, `choose()`, `selected()`, `get()`

---

### 要件10

- **要件**: 「あなたの確認待ち」が最優先で見える
- **判定**: 一部実装
- **根拠**: `inboxSection` は2番目のセクション（index.html:59-63）で、ラベルは「あなたの確認待ち」「先に見てほしいこと」。`getDashboardInbox()` はmode="exception_only"で「通常は空」設計。確認待ちゼロ時は「いまは人の確認待ちがない」と表示。
- **不足点**: homeSectionが1番目で、setupChecklist + heartbeat + funnelPreview + todayResults + stoppedItems + aiActivityの6ブロックを含む長大セクション。inboxSectionはスクロールしないと見えない。`getDashboardHome().awaitingConfirmation` は API上は存在するが、`homeHtml()` 内で件数バッジやアラートバナーとして最上部に表示されていない。todayResults に「いま止まりがある数」はあるが、「あなたの確認待ち X件」という直接的な表示はhome最上部にない。
- **該当ファイル**: `src/dashboard/public/index.html:52-63`, `src/services/dashboard-query/index.ts:2186-2200`
- **該当関数/API/描画箇所**: `inboxHtml()`, `getDashboardHome().awaitingConfirmation` (未描画), `homeHtml()` 内に awaitingConfirmation の描画なし

---

### 要件11

- **要件**: KPI/ログ/予算/詳細データが主役になりすぎていない
- **判定**: 実装済み
- **根拠**: 「例外対応と詳細データ」セクション（index.html:98-154）がデフォルトで `class="hidden"` 。トグルボタン「例外対応 / 詳細データを開く」でのみ表示。説明文は「停止、再開、手動メモ、KPI、実行ログは例外時だけ触る。通常運用ではここを開かなくていい。」。`loadDetailed()` (index.html:252) は `state.detailedOpen` が true の時のみ発火。KPIテーブルとログテーブルは開いた時だけ読み込み。
- **不足点**: なし。裏面データの隠蔽は適切に実装されている。
- **該当ファイル**: `src/dashboard/public/index.html:98-154`, `src/dashboard/public/index.html:252`
- **該当関数/API/描画箇所**: `renderDetailed()`, `loadDetailed()`, `toggleDetailed` event listener (index.html:254)

---

### 要件12

- **要件**: summaryなどのデータ取得が重複しすぎていない
- **判定**: 実装はあるが要件ズレ
- **根拠**: クライアント側は6つのエンドポイント（home/inbox/storyboard/decisions/timeline/funnel）を個別フェッチし、per-source throttling で重複リクエストを抑制（sources config, index.html:171）。なお、バックエンドにはこれら6つに加え `/api/dashboard/summary` エンドポイントも存在する（routes.ts:6-8、計7エンドポイント）。バックエンド側で `getSummary()` が各関数から再帰的に呼ばれる:
  - `getDashboardHome()` → `getSummary()` + `getDashboardInbox()` → `getSummary()` + `getDashboardFunnel()` → `getSummary()` = **3回**
  - `getDashboardStoryboard()` → `getSummary()` = 1回
  - `getDashboardTimeline()` → `getDashboardInbox()` → `getSummary()` = 1回
  - 1サイクルで `getSummary()` が **5回** 実行される
  - `getDepartments()` も storyboard + inbox + timeline から合計3回呼ばれる
  - `getDepartmentDetail()` は storyboard(5回) + funnel(2回) = **7回**
- **不足点**: バックエンド側でキャッシュや共有メカニズムがなく、同一リクエストサイクル内でも重複クエリが走る。SQLiteローカルアクセスなので速度影響は限定的だが、構造上の無駄。
- **該当ファイル**: `src/services/dashboard-query/index.ts` (各export function)
- **該当関数/API/描画箇所**: `getDashboardHome()`:1938 → `getSummary()`:591 + `getDashboardInbox()`:1798 + `getDashboardFunnel()`:1635 の呼び出しチェーン

---

### 要件13

- **要件**: 非表示タブや不要箇所の自動更新が抑えられている
- **判定**: 一部実装
- **根拠**: 詳細セクション（KPI/logs/budget）は完全にlazy-load: `renderDetailed()` は `!state.detailedOpen` で即return（index.html:249）。`loadDetailed()` も `!state.detailedOpen` でearly return。ヘッダーに「可視セクションだけ更新」チップ表示。各sourceに interval throttle あり（60s/90s）。
- **不足点**: メインの6セクション（home/inbox/storyboard/decisions/timeline/funnel）は全てスクロール位置に関係なく常にポーリング。IntersectionObserver等による「ビューポート外セクションのフェッチ抑制」は未実装。15秒間隔の `setInterval(refreshAll, 15000)` が常時動作し、各sourceの interval を超えたものを逐次フェッチする。
- **該当ファイル**: `src/dashboard/public/index.html:171`, `src/dashboard/public/index.html:260`
- **該当関数/API/描画箇所**: `load()` (index.html:195), `refreshAll()`, `renderDetailed()`, `setInterval(()=>refreshAll(false),15000)`

---

### 要件14

- **要件**: 現在の情報設計が「機能別」ではなく「意味別・ストーリー別」に近い
- **判定**: 実装済み
- **根拠**: セクション構成がストーリーフローになっている:
  1. 「今日の運用状況」（全体像）
  2. 「先に見てほしいこと」（ユーザーアクション）
  3. 「どのチームが、何をつないでいるか」（AI組織フロー）
  4. 「集客から収益化までの現在地」（ビジネス導線）
  5. 「何を見て、どう決めたか」（AI判断の透明性）
  6. 「AIと管理者の時系列」（全行動追跡）
  7. 「AIが今日やったこと」（成果）
  8. 「ふだんは触らない裏面データ」（例外対応）

  これは「agents一覧」「logs一覧」「KPI一覧」「settings」のような機能別分割ではなく、ユーザーの認知フローに沿った意味別配置。
- **不足点**: なし。
- **該当ファイル**: `src/dashboard/public/index.html:52-154`
- **該当関数/API/描画箇所**: 各セクションの `<section>` タグとラベル構成

---

### 要件15

- **要件**: ダッシュボードが初心者向け販売アプリとして十分に直感的か
- **判定**: 一部実装
- **根拠**: 良い要素: 日本語文言、「かんたん表示」モード、setup checklist「最初に必要な4つ」、各セクションに説明文、KPI隠蔽、右サイドバー詳細。
- **不足点**:
  - 1ページに8セクションが縦スクロールで並び、ナビゲーション/TOCがない
  - homeSection単体が7ブロックを含み情報過多
  - 「AIの判断」「管理者の行動履歴」は初心者が日常触る必要がないが、メインフロー上にある
  - 右サイドバーがxl(1280px)以下で機能しない（スマホ/タブレットで詳細パネルがページ最下部に移動）
  - progressive disclosure が詳細セクションの1段階のみ。中間層（AIの判断・タイムライン等）の段階的開示がない
  - 「ハートビート」「ファネル」等のカタカナ専門用語が初心者に不親切
- **該当ファイル**: `src/dashboard/public/index.html` 全体
- **該当関数/API/描画箇所**: ページ構成全体、homeSectionの密度、xl breakpoint (index.html:50)

---

## 情報設計の問題まとめ

### 情報の優先順位

- homeSection（全体状況）が最上位だが、ユーザーが「今すぐ判断すべきこと」が1番目ではない
- `awaitingConfirmation` がAPI上は存在するが homeHtml に描画されていない
- stoppedItems と awaitingConfirmation の関係が曖昧（止まり ≠ 確認待ち）

### 導線

- 一覧→詳細は右サイドバーで解決済み（xl以上）
- xl未満で詳細パネルが最下部に落ちる問題が未対処
- セクション間のジャンプ/ナビゲーションがない
- inboxの承認/却下ボタンは詳細パネル経由でのみアクセス可能

### 文言

- 大半が適切な日本語。`humanizeInternalText()` の変換パターンも充実
- 「ハートビート」「ファネル」「導線」等の専門語が残存

### 自動更新

- 詳細セクション: 適切にlazy-load
- メイン6セクション: 常時ポーリング（IntersectionObserver未使用）
- 15秒インターバル + 60-90秒sourceスロットリングの2段構え

### API構造

- 集約API（home/inbox/storyboard/decisions/timeline/funnel）でクライアント側の呼び出しは効率的
- バックエンド側で `getSummary()` が5回、`getDepartmentDetail()` が7回重複呼び出し
- 結果キャッシュなし（リクエスト内memoization未実装）

### 初心者理解の阻害要因

1. homeの情報密度が高すぎる
2. 「あなたが今すべきこと」が最上位にない
3. ナビゲーションなしの長いスクロール
4. モバイルで詳細パネルが使えない
5. 中級セクション（判断・タイムライン）がメインフローに混在

---

## 監査結果集計

| 判定 | 件数 |
|------|------|
| 実装済み | 9件 |
| 一部実装 | 4件 |
| 実装はあるが要件ズレ | 1件 |
| 未実装 | 0件 |

**内訳**

- 実装済み: 要件1, 3, 4, 5, 6, 7, 8, 11, 14
- 一部実装: 要件2, 10, 13, 15
- 実装はあるが要件ズレ: 要件12
- 未実装: なし

---

## 次フェーズで直すべき優先順位

### 最優先

1. **要件10**: 「あなたの確認待ち」を最上位に移動。homeHtml最上部に `awaitingConfirmation` 件数バッジを描画するか、inboxSectionをhomeSectionの上に配置
2. **要件2**: homeSection内にユーザーの「今やるべきこと」を1行で出す（例: 「確認待ち2件 / 止まり1件」のバナー）
3. **要件12**: `getSummary()` のリクエスト内memoization実装。1リクエスト中は結果を再利用する仕組み

### 次点

4. **要件15**: homeSection のコンテンツ削減・段階的開示（例: setupChecklist + heartbeat + funnelPreview は折りたたみ可能に）
5. **要件13**: メイン6セクションにIntersectionObserver導入、ビューポート外はフェッチ抑制
6. **要件9**: xl未満での詳細パネル表示方法改善（モーダルかドロワー）

### 後回しでよいもの

7. 要件5の管理者アクションフィルタ機能
8. 要件8の専門用語（ハートビート/ファネル）のさらなる平易化
9. セクション間ナビゲーション/TOC追加
10. 「AIの判断」「管理者の行動履歴」を中上級者向けとして折りたたみ化
