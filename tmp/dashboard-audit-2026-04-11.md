# ThreadsOS ダッシュボード監査レポート

**監査日**: 2026-04-11
**対象**: ThreadsOS ダッシュボード（初心者向け販売アプリとしての適格性）

---

## 総評

### 現在のダッシュボードの本質的な問題

現在の実装は**「初心者が見るAI組織の運用画面」として、かなり高い水準で設計されている**。ただし、いくつかの構造的な問題が残っている:

1. **homeセクションの情報密度が高すぎる**: `getDashboardHome`が返すデータは、確認待ち・初期設定・ハートビート・止まり・今日の成果・AIの活動・ファネル・フローを全部1つのセクションに詰め込んでいる。初心者はどこから見ればいいか迷う
2. **右パネル（detail）の初期状態が「押してみて」任せ**: 初回表示時にdetailBodyは「まずは〜を押してみて」という誘導だけ。初心者は何を押すべきかわからない
3. **「例外対応/詳細データ」のボタン名が初心者には怖い**: 「例外対応」という言葉は初心者に「触ったらまずいのでは」と思わせる

### 良い点

- 全文言が日本語で統一、`humanizeInternalText`による英語内部表現→日本語変換が徹底されている（`dashboard-query/index.ts:202-246`）
- 「あなたの確認待ち」が画面2番目のセクションとして配置されている（`index.html:65-69`）
- 「ふだんは空」「通常は触らなくていい」等の文言で初心者の不安を減らす設計（`index.ts:1956`, `index.html:109`）
- IntersectionObserver + sectionVisibilityによる可視セクション限定更新（`index.html:295-298`）
- request-cache.tsのAsyncLocalStorageベースの同一リクエスト内メモ化が重複クエリを防いでいる
- Threads→note導線をfunnelセクションとして1本の流れで可視化（`getDashboardFunnel`）
- セットアップチェックリストで「最初にやる4つ」を明示（`index.ts:2058-2151`）

### 初心者向けとして弱い点

- homeセクション内に7つの子コンポーネント（フロー・確認待ち・健康度・設定チェック・ハートビート・ファネルプレビュー・止まり）が同居しており、視覚的優先順位が曖昧
- 詳細パネルの「承認/見送り」ボタンに確認ダイアログがなく、初心者が誤操作する可能性
- Timelineセクションの「すべて/管理者のみ」フィルタは初心者には意味がわかりにくい

### 最優先で直すべき点

1. homeセクションの「いまの全体フロー」と「あなたの確認待ち」のどちらが最優先かの視覚的順序
2. 右パネルの初期状態を「確認待ちの1件目」の自動表示にする
3. 承認/見送りアクションに確認ステップを入れる

---

## 要件別監査結果

### 要件1
- **要件**: トップ画面だけで「今なにが起きているか」が分かる
- **判定**: 実装済み
- **根拠**: `getDashboardHome`が`currentFlow`（`index.ts:2268-2286`）を返し、homeHtml内で「いまの全体フロー」として`nowRunning`・`stoppedReason`・`funnelBottleneck`・`nextHumanAction`・`nextAiAction`の5項目を一目で表示。`hero.title`が`healthHeadline`（「Threadsは稼働中、noteは停滞、要確認が3件」形式）を直接表示
- **不足点**: 情報量が多い。初心者はcurrentFlowとheroのどちらを先に見ればいいか迷う可能性
- **該当ファイル**: `index.html:230-248`, `dashboard-query/index.ts:2268-2286`
- **該当関数**: `getDashboardHome().currentFlow`, `homeHtml()`

### 要件2
- **要件**: ユーザーが最初に「自分が今なにを判断すればよいか」を理解できる
- **判定**: 実装済み
- **根拠**: homeHtmlの先頭位置に確認待ちブロック（`index.html:233-243`）があり、`awaitingConfirmation.count`と`urgentCount`を表示。さらに独立セクション「先に見てほしいこと」（`index.html:65-69`）がinboxHtmlで詳細カードを展開
- **不足点**: homeセクション内とinboxセクションの両方に確認待ちが出るため、「どっちを見ればいいの」が発生しうる
- **該当ファイル**: `index.html:233-243, 65-69`, `dashboard-query/index.ts:2209-2225`
- **該当関数**: `getDashboardHome().awaitingConfirmation`, `getDashboardInbox()`, `homeHtml()`, `inboxHtml()`

### 要件3
- **要件**: 各部署が「何をしているか」「なぜそれをしているか」が分かる
- **判定**: 実装済み
- **根拠**: storyboardHtmlが各チームのカードを表示（`index.html:270`）。各チームに`purpose`（役割）、`nowDoing`（いまやっていること）、`basedOn`（根拠）が含まれる。右パネルの詳細表示で「いま何をしているか」「何を根拠に動いているか」「次にどこへつなぐか」の3項目を展開（`index.html:277`）
- **不足点**: なし。十分に初心者向けの文言
- **該当ファイル**: `index.html:270, 277`, `dashboard-query/index.ts:2290-2400`
- **該当関数**: `getDashboardStoryboard()`, `storyboardHtml()`, `renderDetail()`

### 要件4
- **要件**: AIが「何を見て」「どう判断して」「何を実行したか」が読める
- **判定**: 実装済み
- **根拠**: decisionsHtmlが判断フィードを表示（`index.html:272`）。右パネルでdecision選択時に「見た情報」(`seenInformation`)→「判断」(`judgment`)→「実行内容」(`execution`)→「期待している結果」(`expectedResult`)の4段階を明示（`index.html:278`）。`getDashboardDecisions`（`index.ts:2499`）が`seenInformation`を`detailLinesFromValue`で分解・日本語化
- **不足点**: なし
- **該当ファイル**: `index.html:272, 278`, `dashboard-query/index.ts:2499+`
- **該当関数**: `getDashboardDecisions()`, `decisionsHtml()`, `renderDetail()`

### 要件5
- **要件**: 管理者が「何を承認・却下・停止・再開・指示したか」が追える
- **判定**: 実装済み
- **根拠**: timelineHtmlが時系列イベントを表示（`index.html:273`）。TimelineKind型に`approval`, `rejection`, `pause`, `resume`, `directive`が定義されている（`index.ts:1243-1249`）。「管理者のみ」フィルタで管理者操作だけ抽出可能。`humanEventCount`を表示。右パネルでtimeline選択時に「何が起きたか」「補足」を展開（`index.html:279`）
- **不足点**: 管理者操作履歴の「理由」フィールド（なぜその判断をしたか）はnoteに依存しており、指示送信時にnoteを省略すると追跡不能になる
- **該当ファイル**: `index.html:273, 279`, `dashboard-query/index.ts:1619-1634, 2570+`
- **該当関数**: `getDashboardTimeline()`, `timelineHtml()`, `renderDetail()`

### 要件6
- **要件**: Threadsとnoteが別々ではなく、集客→収益化導線として見える
- **判定**: 実装済み
- **根拠**: funnelセクション（`index.html:79-84`）で「集客から収益化までの現在地」を表示。`getDashboardFunnel`が4ステージ（テーマ軸→Threads集客→橋渡し→note収益化）を1本の導線として構成（`index.ts:1735-1817`）。homeHtml内にも`funnelPreview`で「Threads→noteの流れ」プレビューが入っている（`index.html:266`）
- **不足点**: なし。設計意図が明確
- **該当ファイル**: `index.html:79-84, 266, 271`, `dashboard-query/index.ts:1658-1819`
- **該当関数**: `getDashboardFunnel()`, `funnelHtml()`, `homeHtml()` funnelPreview部分

### 要件7
- **要件**: 監視UIではなく、AI組織の運用フローが見える
- **判定**: 実装済み
- **根拠**: storyboardセクション（`index.html:72-77`）の見出しが「どのチームが、何をつないでいるか」。各チーム間の受け渡しが`handoffTo`で明示。CSSで疑似的なフロー矢印（`.absolute -top-4 left-5 h-4 w-[2px] bg-gradient-to-b`、`index.html:270`のstoryboardHtml内）を表示。currentFlowで全体の流れを1文で要約
- **不足点**: フロー矢印が1チーム→次チームの縦方向のみで、分岐（外部リサーチ→Threads + note同時送り）が視覚化されていない
- **該当ファイル**: `index.html:72-77, 270`, `dashboard-query/index.ts:2307-2353`
- **該当関数**: `getDashboardStoryboard()`, `storyboardHtml()`

### 要件8
- **要件**: 初心者でも理解できる文言になっている
- **判定**: 実装済み
- **根拠**: `humanizeInternalText`（`index.ts:197-246`）が英語の内部用語を日本語に変換。セクションタイトルが「今日の運用状況」「先に見てほしいこと」「AIチームの流れ」「AIの判断」等の日本語。setupChecklistのnextStepが「ジャンルか主テーマを1つ入れると回り始める」等のかみ砕いた文言。inboxで「ふだんはここは空」。ボタンが「承認する」「見送る」で専門用語なし
- **不足点**: 一部に「ファネル」「ハートビート」「ワークストリーム」等のカタカナ技術用語が残っている（ユーザー文言レベルでは「定期チェック」と訳されているが、JS変数名の文脈で漏れる可能性あり）
- **該当ファイル**: `dashboard-query/index.ts:197-246, 1251-1283`
- **該当関数**: `humanizeInternalText()`, `humanizePolicyText()`, `metricDisplayName()`

### 要件9
- **要件**: 一覧→詳細の導線が見やすい
- **判定**: 一部実装
- **根拠**: 右サイドパネル（`index.html:168-175`）が`xl:sticky xl:top-5`で固定表示。各カードに`data-select-kind`/`data-select-id`属性をつけ、クリックで右パネルに詳細展開。`.sel`クラスでhover/activeのスタイル遷移。`choose()`→`renderDetail()`で種類別の詳細HTMLを生成
- **不足点**: 初期状態で右パネルが「押してみて」だけのため、初心者は一覧→詳細の導線があることに気づかない。モバイル幅（`xl`未満）では右パネルがメインの下に回り込み、タップ後にスクロールしないと詳細が見えない
- **該当ファイル**: `index.html:168-175, 200, 275-281`
- **該当関数**: `choose()`, `renderDetail()`, CSS `.sel`, `.sel.active`

### 要件10
- **要件**: 「あなたの確認待ち」が最優先で見える
- **判定**: 一部実装
- **根拠**: homeHtml内の先頭位置に確認待ちブロック（`index.html:233-243`）があり、inboxセクションも画面2番目（`index.html:65-69`）に配置。ただしhomeセクション内ではcurrentFlowブロック（`index.html:230`）が確認待ちより先に描画されている
- **不足点**: homeHtml内で`currentFlow`が`awaitingConfirmation`より上に来ている。コード上`${d.currentFlow?...:""}` → その後に確認待ちブロックの順序。初心者が見る第一情報がフロー状況であり、確認待ちではない
- **該当ファイル**: `index.html:230-243`
- **該当関数**: `homeHtml()` の描画順序

### 要件11
- **要件**: KPI / ログ / 予算 / 詳細データが主役になりすぎていない
- **判定**: 実装済み
- **根拠**: KPI・ログ・予算は「例外対応 / 詳細データを開く」ボタン（`index.html:111`）の裏に隠されており、デフォルトではhidden。`state.detailedOpen`がfalseの初期状態では描画もfetchもされない（`loadDetailed`は`detailedOpen`チェック）。主画面はhome・inbox・storyboard・funnel・decisions・timelineの6セクションで構成
- **不足点**: なし。設計意図通り
- **該当ファイル**: `index.html:104-165, 289`
- **該当関数**: `loadDetailed()`, `renderDetailed()`, `toggleDetailed`イベント

### 要件12
- **要件**: summaryなどのデータ取得が重複しすぎていない
- **判定**: 実装済み
- **根拠**: `request-cache.ts`の`memoizeDashboardQuery`でAsyncLocalStorage内のMapに結果をキャッシュ。`withDashboardQueryCache`がroutes.tsの各エンドポイントでラップ（`routes.ts:6`）。`getSummary`は`memoizeDashboardQuery("getSummary", [], getSummaryImpl)`を使い、同一リクエスト内で複数回呼ばれても1回しか実行されない。`getDashboardHome`が内部で`getSummary`・`getDashboardInbox`・`getDashboardFunnel`を呼んでも、それぞれ1回だけ計算される
- **不足点**: フロントのrefreshAllは6つのAPIを並列fetchする（`index.html:216`）。各APIが内部で`getSummary()`を共有するが、リクエストが別なのでキャッシュは共有されない。つまりサーバー側で`getSummaryImpl`が1回のrefreshAllあたり最大6回実行される可能性がある
- **該当ファイル**: `request-cache.ts:1-38`, `routes.ts:6`, `dashboard-query/index.ts:72, 1232`
- **該当関数**: `withDashboardQueryCache()`, `memoizeDashboardQuery()`, `getSummary()`

### 要件13
- **要件**: 非表示タブや不要箇所の自動更新が抑えられている
- **判定**: 実装済み
- **根拠**: `sectionVisibility`オブジェクト（`index.html:295`）とIntersectionObserverでセクションごとの可視性を追跡。`refreshAll`で`!force && sectionVisibility[name] === false`なら該当セクションのfetchをスキップ（`index.html:216`）。詳細データ（KPI・ログ）は`detailedOpen`がtrueかつボタン押下時のみ取得。`document.hidden`時はrefreshAllがスキップ、visibilitychange時に復帰
- **不足点**: 15秒intervalのsetInterval（`index.html:299`）はforce=falseなので可視セクションのみ更新だが、homeとinboxはほぼ常に可視なので60秒intervalに対して15秒ごとにリトライチェックが走る。負荷は低いが無駄
- **該当ファイル**: `index.html:295-300`
- **該当関数**: `refreshAll()`, `load()`, `sectionVisibility`, IntersectionObserver

### 要件14
- **要件**: 現在の情報設計が「機能別」ではなく「意味別・ストーリー別」に近い
- **判定**: 実装済み
- **根拠**: セクション構成が「今日の運用状況」→「先に見てほしいこと」→「AIチームの流れ」→「集客→収益化導線」→「AIの判断」→「管理者の時系列」→「今日の成果」→「例外対応」。これは機能別（Threads管理 / note管理 / 設定）ではなく、ユーザーの関心順序（全体把握→判断→チーム→導線→判断根拠→履歴→成果→裏面）で並んでいる
- **不足点**: 「AIの判断」と「管理者の時系列」はそれぞれdecisionsとtimelineという機能的分割の名残。ストーリーとしては「誰が何を決めたか」で統合した方がわかりやすい可能性
- **該当ファイル**: `index.html:57-166`
- **該当関数**: セクション配置全体

### 要件15
- **要件**: ダッシュボードが初心者向け販売アプリとして十分に直感的か
- **判定**: 一部実装
- **根拠**: 文言・導線・情報優先順位はかなり整っている。しかし以下の3点で「販売アプリ」としてはまだ弱い:
  1. **「いくら稼げているか」が一目でわからない**: noteの売上はhome内のtodayResults 4つのうちの1つに埋もれている。販売アプリなら売上が最も目立つべき
  2. **購入者やリード数が見えない**: funnelの「橋渡し」ステージにThreads→note遷移の実数がない
  3. **「次に何をすれば売上が上がるか」の示唆がない**: 現在は「止まり」や「確認待ち」の対処が中心で、成長のための次の一手が弱い
- **不足点**: 上記3点
- **該当ファイル**: `index.html:267`（todayResults）, `dashboard-query/index.ts:2226-2254`
- **該当関数**: `getDashboardHome().todayResults`, `getDashboardFunnel().stages`

---

## 情報設計の問題まとめ

### 情報の優先順位
- homeセクション内で`currentFlow`が`awaitingConfirmation`より上。販売アプリとしては「売上」→「確認待ち」→「全体フロー」の順が自然
- todayResultsの4つのカードが等しい大きさで、売上だけ特別に目立つ設計になっていない

### 導線
- 右パネルへの誘導が「押してみて」のテキストのみで、初回ユーザーが迷う
- モバイルでは右パネルがメイン下に回り込み、一覧→詳細がスクロール量大

### 文言
- 全体的に日本語化は高品質。「ハートビート」という語は「定期チェック」に置き換え済み。一部「ファネル」がURL/API名(`/api/dashboard/funnel`)として残る程度で、UI文言には出ていない

### 自動更新
- IntersectionObserver + sectionVisibility + document.hiddenの3重ガードは適切
- 詳細データは手動更新のみでよい設計
- 15秒intervalはsources設定の60/90秒intervalと二重になっているが、`load()`内のタイムスタンプチェックで実質的に無駄なfetchは発生しない

### API構造
- 6つの専用API（home/inbox/storyboard/decisions/timeline/funnel）+ summary/kpi/logsの分離は適切
- ただし6つのAPIがそれぞれ内部で`getSummary`を呼ぶため、サーバー側でsummary計算が最大6回/refreshに走る。リクエスト間のキャッシュ層がない

### 初心者理解の阻害要因
1. homeの情報密度（7コンポーネント同居）
2. 右パネルの初期状態の空っぽさ
3. 「例外対応」というラベルの心理的ハードル
4. 承認/見送りの確認ステップ不在

---

## 監査結果集計

| 判定 | 件数 |
|------|------|
| 実装済み | **10件** |
| 一部実装 | **3件** |
| 実装はあるが要件ズレ | **0件** |
| 未実装 | **0件** |

---

## 次フェーズで直すべき優先順位

### 最優先
1. **homeセクション内の描画順序変更**: `currentFlow`より`awaitingConfirmation`を上にする。さらに売上サマリーを最上部に追加
2. **右パネルの初期自動選択**: 確認待ちがあればその1件目、なければfunnel概要を初期表示
3. **承認/見送りアクションに確認ダイアログ追加**: 初心者の誤操作防止

### 次点
4. **getSummary のリクエスト間キャッシュ**: 6 API並列時にsummary計算が重複する問題の解消（TTL 5-10秒程度のグローバルキャッシュ）
5. **売上を独立した目立つ表示に**: todayResultsの4カードの中で売上だけを大きく/色付きで表示
6. **「例外対応」→「裏面データ」等の文言変更**: 初心者が怖がらないラベルに

### 後回しでよいもの
7. storyboardのフロー矢印を分岐対応にする（視覚的改善だが機能には影響しない）
8. 「AIの判断」と「管理者の時系列」の統合検討
9. 15秒intervalの最適化（実害はほぼない）
10. モバイル幅での右パネル導線改善（ユーザー層がPC中心なら後回し）
