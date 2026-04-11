# Dashboard Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ThreadsOS Dashboard の全面リライト - タブ化レイアウト、日本語化、データフォーマット改善、UX向上

**Architecture:** 単一HTMLファイル (`src/dashboard/public/index.html`) のリライト。CSS Grid + タブ切替JSで縦積み14,000px問題を解消。HTMX構成はそのまま維持。APIルート (`src/dashboard/routes.ts`) は変更なし。

**Tech Stack:** HTML, Tailwind CDN, HTMX, vanilla JS

---

## File Structure

- **Modify:** `src/dashboard/public/index.html` (911行 → 全面リライト)
- **No change:** `src/dashboard/routes.ts` (APIはそのまま)

---

### Task 1: CSS - タブレイアウト基盤 + grid-overlay問題修正

**Files:**
- Modify: `src/dashboard/public/index.html:1-499` (style section)

- [ ] **Step 1: タブ表示制御CSSを追加**

既存の `.workspace-content` のCSS（`display: flex; flex-direction: column;`）の後に以下を追加:

```css
/* Tab system */
.tab-panel { display: none; }
.tab-panel.active { display: flex; flex-direction: column; gap: 1.5rem; }
.sidebar-link.active {
  background: rgba(14,165,233,.12);
  border-color: rgba(14,165,233,.32);
  box-shadow: 0 10px 28px rgba(14,165,233,.1);
}
```

- [ ] **Step 2: grid-overlayのmask修正**

`.grid-overlay` のCSSに `z-index: 0;` を明示追加（スクロール時の描画問題を防止）:

```css
.grid-overlay {
  /* 既存のまま + 追加 */
  z-index: 0;
}
```

- [ ] **Step 3: .workspace-content のflex-direction削除**

`.workspace-content` から `display: flex; flex-direction: column; gap: 1.5rem;` を削除。タブ内の各 `.tab-panel.active` が flex column を担うため不要。

```css
.workspace-content {
  max-width: 1440px;
  margin: 0 auto;
  padding: 1.5rem;
  position: relative;
  z-index: 1;
}
```

- [ ] **Step 4: レビュー/エージェント用の折りたたみCSS追加**

```css
.collapsible-list > :nth-child(n+6) { display: none; }
.collapsible-list.expanded > :nth-child(n+6) { display: flex; }
.json-formatted { font-size: .82rem; line-height: 1.7; }
.json-formatted dt { color: #6f8199; font-weight: 600; }
.json-formatted dd { color: #10253d; margin-bottom: .35rem; }
```

- [ ] **Step 5: 確認 - ブラウザリロードしてCSS構文エラーがないことを確認**

---

### Task 2: HTML - サイドバー日本語化 + タブ切替構造

**Files:**
- Modify: `src/dashboard/public/index.html:500-560` (sidebar + main structure)

- [ ] **Step 1: サイドバーnavを日本語化してタブトリガーに変更**

`<nav class="sidebar-nav">` ブロックを以下に置換:

```html
<nav class="sidebar-nav">
  <a href="#" data-tab="overview" class="sidebar-link active" onclick="switchTab('overview');return false"><strong>概要</strong></a>
  <a href="#" data-tab="approvals" class="sidebar-link" onclick="switchTab('approvals');return false"><strong>承認管理</strong></a>
  <a href="#" data-tab="operations" class="sidebar-link" onclick="switchTab('operations');return false"><strong>運用状況</strong></a>
  <a href="#" data-tab="telemetry" class="sidebar-link" onclick="switchTab('telemetry');return false"><strong>テレメトリ</strong></a>
</nav>
```

- [ ] **Step 2: Quick Jumpセクションを削除**

sidebar-card の Quick Jump `<div>` 全体（Summary/Queue/Ops/Logs リンク）を削除。ナビと重複するため不要。

- [ ] **Step 3: main内のsectionをタブパネルで囲む**

`<main class="workspace-content">` 直下の各 `<section class="dashboard-cluster">` を `<div class="tab-panel" id="tab-xxx">` でラップ。

```html
<main class="workspace-content">
  <div class="tab-panel active" id="tab-overview">
    <section class="dashboard-cluster">
      <!-- Overview + Budget Watch 既存内容 -->
    </section>
  </div>

  <div class="tab-panel" id="tab-approvals">
    <section class="dashboard-cluster">
      <!-- Approvals 既存内容 -->
    </section>
  </div>

  <div class="tab-panel" id="tab-operations">
    <section class="dashboard-cluster">
      <!-- Operations + Control Panel 既存内容 -->
    </section>
  </div>

  <div class="tab-panel" id="tab-telemetry">
    <section class="dashboard-cluster">
      <!-- Telemetry 既存内容 -->
    </section>
  </div>
</main>
```

- [ ] **Step 4: topbar の日本語化**

```html
<div class="topbar-kicker">ThreadsOS</div>
<div class="topbar-title">自動運用ダッシュボード</div>
```

`30s refresh` チップ → `30秒更新`、`最終更新` はそのまま

---

### Task 3: HTML - 各セクションのラベル日本語化

**Files:**
- Modify: `src/dashboard/public/index.html:547-636` (section headers)

- [ ] **Step 1: Overview セクション**

| Before | After |
|--------|-------|
| `<div class="cluster-header">Overview</div>` | `<div class="cluster-header">概要</div>` |
| `System Summary` | `システム概要` |
| `Budget Watch` | `予算監視` |

- [ ] **Step 2: Approvals セクション**

| Before | After |
|--------|-------|
| `<div class="cluster-header">Approvals</div>` | `<div class="cluster-header">承認管理</div>` |
| `Proposals` / `承認待ちの提案` | そのまま |
| `Human Reviews` / `レビュー待ち` | そのまま |
| `Proposal Detail` / `提案の詳細` | そのまま |

- [ ] **Step 3: Operations セクション**

| Before | After |
|--------|-------|
| `<div class="cluster-header">Operations Floor</div>` | `<div class="cluster-header">運用状況</div>` |
| `Departments` → `部署一覧` |
| `Agents` → `エージェント一覧` |
| `Department Detail` → `部署の詳細` |
| `Agent Detail` → `エージェントの詳細` |
| `Control Panel` → `操作パネル` |

- [ ] **Step 4: Telemetry セクション**

| Before | After |
|--------|-------|
| `<div class="cluster-header">Telemetry</div>` | `<div class="cluster-header">テレメトリ</div>` |
| `KPI Snapshots` → `KPI スナップショット` |
| `Execution Logs` → `実行ログ` |

- [ ] **Step 5: Control Panel内のフォームラベル**

| Before | After |
|--------|-------|
| `ディレクティブ追加` | そのまま |
| `scope` placeholder | `スコープ (例: global)` |
| `department (任意)` | `部署名 (任意)` |
| `agentId (担当者指示時)` | `エージェントID (担当者指示時)` |
| `全体` option | そのまま |
| `次回HB重点` option | そのまま |
| `担当者指示` option | そのまま |

---

### Task 4: JS - renderSummary の改善 (Focus重複削除 + 日本語化)

**Files:**
- Modify: `src/dashboard/public/index.html` renderSummary 関数 (line ~653)

- [ ] **Step 1: Focus パネルの重複削除**

`renderSummary` 関数内のグリッド (`grid-template-columns: [1.2fr_0.8fr]`) の左側パネル（Focus セクション）を削除。テーマ情報はmetric-cardsで既に表示されているため重複。

右側のSignalsパネルだけ残し、 `grid-template-columns` を `1fr` に変更。

- [ ] **Step 2: render関数内の英語ラベルを日本語化**

renderSummary 内の変換:
| Before | After |
|--------|-------|
| `Focus` | 削除（重複のため） |
| `Signals` | `シグナル` |
| `重要アラート` | そのまま |
| `Recent Decisions` | `最近の判断` |
| `担当者サマリー` | そのまま |
| `Budget Preview` | `予算概要` |
| `Tokens` | `トークン` |
| `Calls` | `呼び出し` |

- [ ] **Step 3: metric-card のラベル修正**

cardsの配列:
```js
const cards = [
  ["テーマ", currentTheme, currentPolicy],
  ["状態", s.systemStatus ?? s.status ?? s.mode ?? "normal", s.updatedAt ? `更新 ${fd(s.updatedAt)}` : "更新時刻なし"],
  ["次回HB", nextHeartbeat?.nextAt ?? s.nextHeartbeatAt ?? s.nextRunAt ?? "未設定", nextHeartbeat?.jobName ? `${escapeHtml(String(nextHeartbeat.jobName))} を監視中` : "次回予定を待機中"],
  ["アラート", importantAlerts.length, importantAlerts.length ? "要対応あり" : "アラートなし"],
];
```

---

### Task 5: JS - renderProposals の改善 (JSONフォーマット + 承認済みフィルタ)

**Files:**
- Modify: `src/dashboard/public/index.html` renderProposals 関数 (line ~703)

- [ ] **Step 1: 承認済みproposalをフィルタ**

関数の冒頭で未承認のみフィルタ:
```js
function renderProposals(rawList) {
  const list = rawList.filter(p => p.status !== 'approved' && p.status !== 'rejected');
  if (!list.length) return '<p class="text-slate-400">承認待ちの提案はありません。</p>';
  // ... rest
}
```

- [ ] **Step 2: JSON文字列をフォーマットする共通ヘルパー追加**

scriptタグ冒頭（escapeHtml等の後）に追加:
```js
function fmtJson(v) {
  if (v == null || v === '') return '-';
  try {
    const obj = typeof v === 'string' ? JSON.parse(v) : v;
    if (typeof obj !== 'object') return escapeHtml(String(v));
    return '<dl class="json-formatted">' +
      Object.entries(obj).map(([k, val]) =>
        `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(val))}</dd>`
      ).join('') + '</dl>';
  } catch { return escapeHtml(String(v)); }
}
```

- [ ] **Step 3: Evidence / Expected Effect に fmtJson 適用**

renderProposals 内で:
- `${escapeHtml(String(p.evidence))}` → `${fmtJson(p.evidence)}`
- `${escapeHtml(String(p.expectedEffect))}` → `${fmtJson(p.expectedEffect)}`
- `${escapeHtml(String(p.description))}` → `${fmtJson(p.description)}`

- [ ] **Step 4: 英語ラベルを日本語化**

| Before | After |
|--------|-------|
| `Reason` | `理由` |
| `Expected Effect` | `期待効果` |
| `Evidence` | `根拠データ` |
| `Reviewer Note` | `レビューアメモ` |
| `Created` | `作成` |
| `Reviewed` | `レビュー` |
| `Executed` | `実行` |

---

### Task 6: JS - renderReviews の改善 (折りたたみ + 一括操作)

**Files:**
- Modify: `src/dashboard/public/index.html` renderReviews 関数 (line ~701)

- [ ] **Step 1: 5件以上の場合は折りたたみ + 展開ボタン**

```js
function renderReviews(list) {
  if (!list.length) return '<p class="text-slate-400">保留中のレビューはありません。</p>';
  const collapsed = list.length > 5;
  return `
    <div class="space-y-2 mb-3">
      <div class="flex items-center justify-between">
        <span class="text-sm text-slate-500">${list.length}件の保留</span>
        <div class="flex gap-2">
          <button type="button" onclick="batchReviews('approve')" class="ghost-button text-xs bg-emerald-500/15 hover:bg-emerald-500/22 text-emerald-100 px-3 py-2 rounded-xl border border-emerald-400/20 font-semibold">一括承認</button>
          <button type="button" onclick="batchReviews('reject')" class="ghost-button text-xs bg-rose-500/15 hover:bg-rose-500/22 text-rose-100 px-3 py-2 rounded-xl border border-rose-400/20 font-semibold">一括差し戻し</button>
        </div>
      </div>
    </div>
    <div class="space-y-3 collapsible-list${collapsed ? '' : ' expanded'}" id="reviews-list">
      ${list.map(rv => `<div class="bg-slate-950/70 border border-white/8 rounded-2xl p-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between" data-review-id="${escapeHtml(String(rv.id))}">
        <div class="space-y-1">
          <div class="content-row">
            <span class="chip chip-neutral">${escapeHtml(String(rv.itemType))}</span>
            <span class="${st(rv.status)}">${escapeHtml(String(rv.status ?? "pending"))}</span>
          </div>
          <div class="text-sm text-slate-200">${escapeHtml(String(rv.reason))}</div>
          <div class="text-xs text-slate-500">${fd(rv.createdAt, "-")}</div>
        </div>
        <div class="flex gap-2">
          <button type="button" hx-post="/api/dashboard/reviews/${encodeURIComponent(rv.id)}/approve" hx-target="#reviews-content" hx-swap="innerHTML" hx-vals='{}' class="ghost-button text-xs bg-emerald-500/15 hover:bg-emerald-500/22 text-emerald-100 px-3 py-2 rounded-xl border border-emerald-400/20 font-semibold">承認</button>
          <button type="button" hx-post="/api/dashboard/reviews/${encodeURIComponent(rv.id)}/reject" hx-target="#reviews-content" hx-swap="innerHTML" hx-vals='{}' class="ghost-button text-xs bg-rose-500/15 hover:bg-rose-500/22 text-rose-100 px-3 py-2 rounded-xl border border-rose-400/20 font-semibold">差し戻し</button>
        </div>
      </div>`).join('')}
    </div>
    ${collapsed ? `<button type="button" onclick="document.getElementById('reviews-list').classList.toggle('expanded');this.textContent=this.textContent==='すべて表示'?'折りたたむ':'すべて表示'" class="ghost-button text-xs bg-slate-800/80 px-3 py-2 rounded-xl mt-3 border border-white/6">すべて表示</button>` : ''}`;
}
```

- [ ] **Step 2: batchReviews JS関数を追加**

```js
async function batchReviews(action) {
  const items = document.querySelectorAll('#reviews-list [data-review-id]');
  for (const item of items) {
    const id = item.dataset.reviewId;
    await fetch(`/api/dashboard/reviews/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
  }
  htmx.trigger('#reviews-content', 'htmx:load');
  htmx.ajax('GET', '/api/dashboard/reviews?status=pending', '#reviews-content');
}
```

---

### Task 7: JS - renderKpi のJSONフォーマット改善 + 日本語化

**Files:**
- Modify: `src/dashboard/public/index.html` renderKpi 関数 (line ~707)

- [ ] **Step 1: Metrics列をフォーマット**

`${escapeHtml(String(typeof r.metrics === 'object' ? JSON.stringify(r.metrics) : r.metrics))}` を `${fmtJson(r.metrics)}` に置換。

- [ ] **Step 2: テーブルヘッダー日本語化**

| Before | After |
|--------|-------|
| `Channel` | `チャネル` |
| `Period` | `期間` |
| `Key` | `キー` |
| `Metrics` | `指標` |
| `Date` | `日時` |

---

### Task 8: JS - renderAgents の改善 (ステータス別サマリー)

**Files:**
- Modify: `src/dashboard/public/index.html` renderAgents 関数 (line ~699)

- [ ] **Step 1: ステータスサマリーを先頭に追加 + 5件超は折りたたみ**

```js
function renderAgents(list) {
  if (!list.length) return '<p class="text-slate-400">エージェントがまだ登録されていません。</p>';
  const byStatus = {};
  list.forEach(a => { const s = a.status ?? 'idle'; byStatus[s] = (byStatus[s] ?? 0) + 1; });
  const collapsed = list.length > 5;
  return `
    <div class="flex flex-wrap gap-2 mb-4">
      <span class="chip chip-neutral">全 ${list.length} エージェント</span>
      ${Object.entries(byStatus).map(([s, c]) => `<span class="${st(s)}">${escapeHtml(s)}: ${c}</span>`).join('')}
    </div>
    <div class="stack-list collapsible-list${collapsed ? '' : ' expanded'}" id="agents-list">
      ${list.map(ae => `<article class="stack-card"><!-- 既存のカード内容そのまま --></article>`).join('')}
    </div>
    ${collapsed ? `<button type="button" onclick="document.getElementById('agents-list').classList.toggle('expanded');this.textContent=this.textContent==='すべて表示'?'折りたたむ':'すべて表示'" class="ghost-button text-xs bg-slate-800/80 px-3 py-2 rounded-xl mt-3 border border-white/6">すべて表示</button>` : ''}`;
}
```

- [ ] **Step 2: エージェントカード内のラベル日本語化**

| Before | After |
|--------|-------|
| `Current Task` | `現在タスク` |
| `Last Completed` | `最終完了` |
| `Tokens` | `トークン` |
| `Calls` | `呼び出し` |
| `Last active` | `最終稼働` |

---

### Task 9: JS - renderLogs の日本語化

**Files:**
- Modify: `src/dashboard/public/index.html` renderLogs 関数 (line ~705)

- [ ] **Step 1: テーブルヘッダー日本語化**

| Before | After |
|--------|-------|
| `Job` | `ジョブ` |
| `Status` | `状態` |
| `Started` | `開始` |
| `Finished` | `終了` |
| `Summary` | `概要` |

- [ ] **Step 2: ページネーションボタン日本語化**

| Before | After |
|--------|-------|
| `Prev` | `前へ` |
| `Next` | `次へ` |
| `Page X / Y` | `${data.page} / ${totalPages} ページ` |

- [ ] **Step 3: Summary列のtruncate解除**

`max-w-xs truncate` を `max-w-md` に変更し、長文は3行で切る:
```css
/* Task 1のCSSに追加 */
.log-summary { max-width: 28rem; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
```

---

### Task 10: JS - renderDepartments + renderProposalDetail + renderDepartmentDetail の日本語化

**Files:**
- Modify: `src/dashboard/public/index.html` (lines ~697, ~709-800)

- [ ] **Step 1: renderDepartments のラベル**

| Before | After |
|--------|-------|
| `Latest Summary` | `最新結果` |
| `Recent Phase` | `直近フェーズ` |
| `Last Run` | `最終実行` |
| `Active Agents` | `稼働中` |

- [ ] **Step 2: renderProposalDetail のラベル**

| Before | After |
|--------|-------|
| `Proposal Detail` | `提案の詳細` |
| `Description` | `説明` |
| `Reason / Effect` | `理由 / 効果` |
| `History` | `履歴` |
| `Related Controls` | `関連操作` |

- [ ] **Step 3: renderDepartmentDetail のラベル**

| Before | After |
|--------|-------|
| `Department Detail` | `部署の詳細` |
| `Inputs` | `入力` |
| `Outputs` | `出力` |
| `Blockers` | `停滞事項` |
| `Questions / Priority` | `確認事項 / 優先タスク` |
| `Pause / Resume` | `停止 / 再開` |

---

### Task 11: JS - タブ切替関数 + HTMX連携

**Files:**
- Modify: `src/dashboard/public/index.html` script section

- [ ] **Step 1: switchTab関数を追加**

scriptタグ冒頭（ヘルパー関数群の後）に追加:

```js
function switchTab(tabId) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sidebar-link').forEach(l => l.classList.remove('active'));
  const panel = document.getElementById('tab-' + tabId);
  if (panel) panel.classList.add('active');
  const link = document.querySelector(`[data-tab="${tabId}"]`);
  if (link) link.classList.add('active');
  window.scrollTo(0, 0);
}
```

- [ ] **Step 2: HTMX afterSwap イベントでレンダー関数を呼び出す設定確認**

既存の `htmx:afterSwap` リスナー（またはhx-on属性）がHTMXレスポンスを正しくレンダリングすることを確認。現在の仕組み:
- `hx-get="/api/dashboard/summary"` → サーバーがJSONを返す → HTMXが`#summary-content`にセット

**重要:** HTMXはデフォルトでHTMLレスポンスを期待する。JSONが返る場合、`htmx:beforeSwap` でインターセプトしてrender関数を呼ぶ仕組みが必要。既存コードにこの仕組みがあるか確認し、なければ以下を追加:

```js
document.addEventListener('htmx:beforeSwap', function(evt) {
  const target = evt.detail.target;
  const text = evt.detail.xhr.responseText;
  let data;
  try { data = JSON.parse(text); } catch { return; }

  if (target.id === 'summary-content') { evt.detail.serverResponse = renderSummary(data); }
  else if (target.id === 'budget-content') { evt.detail.serverResponse = renderBudget(data); }
  else if (target.id === 'departments-content') { evt.detail.serverResponse = renderDepartments(Array.isArray(data) ? data : data.departments ?? []); }
  else if (target.id === 'agents-content') { evt.detail.serverResponse = renderAgents(Array.isArray(data) ? data : data.agents ?? []); }
  else if (target.id === 'proposals-content') { evt.detail.serverResponse = renderProposals(Array.isArray(data) ? data : data.proposals ?? []); }
  else if (target.id === 'reviews-content') { evt.detail.serverResponse = renderReviews(Array.isArray(data) ? data : data.reviews ?? []); }
  else if (target.id === 'kpi-content') { evt.detail.serverResponse = renderKpi(Array.isArray(data) ? data : data.snapshots ?? []); }
  else if (target.id === 'logs-content') { evt.detail.serverResponse = renderLogs(data); }
  else if (target.id === 'proposal-detail-content') { evt.detail.serverResponse = renderProposalDetail(data); }
  else if (target.id === 'department-detail-content') { evt.detail.serverResponse = renderDepartmentDetail(data); }
  else if (target.id === 'agent-detail-content') { evt.detail.serverResponse = renderAgentDetail(data); }
});
```

- [ ] **Step 3: 最終更新の表示更新**

既存の `last-updated` 更新処理を確認し、以下のイベントリスナーがあることを確認:

```js
document.addEventListener('htmx:afterSwap', function() {
  document.getElementById('last-updated').textContent = new Date().toLocaleTimeString('ja-JP');
});
```

---

### Task 12: 最終確認 + コミット

- [ ] **Step 1: ブラウザで http://127.0.0.1:3000/ を開き、以下を確認**

1. タブ切替が正しく動作する（概要→承認管理→運用状況→テレメトリ）
2. 日本語ラベルが全箇所に適用されている
3. Proposalsの Evidence/Expected Effect が JSON ではなくキー・バリュー形式で表示される
4. KPI の Metrics 列がフォーマットされている
5. Human Reviews が5件で折りたたまれ「すべて表示」ボタンがある
6. Agents にステータスサマリーが表示され、5件超は折りたたまれている
7. 承認済みProposalが表示されていない
8. Focus セクションの重複が削除されている

- [ ] **Step 2: コミット**

```bash
git add src/dashboard/public/index.html
git commit -m "feat: ダッシュボード全面リライト - タブ化・日本語化・UX改善"
```
