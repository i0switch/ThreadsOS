# note-login — note.com セッション取得スキル（Playwright storageState方式）

ユーザーが「noteにログインして」「note login」などと言ったら実行する。

## 目的
Claude in Chrome で note.com にログインし、Playwright storageState（セッションJSON）を
`data/note-storage-state.json` に保存する。

## 手順

### Step 1: data/ ディレクトリ確認
```
data/ ディレクトリが存在しない場合は作成する
```

### Step 2: .env の NOTE_STORAGE_STATE_PATH 確認
`.env` の `NOTE_STORAGE_STATE_PATH` の値を確認する（デフォルト: `data/note-storage-state.json`）

### Step 3: ブラウザで note.com を開く
`mcp__claude-in-chrome__navigate` で以下を開く:
```
https://note.com/login
```

### Step 4: ユーザーに手動ログインを依頼
```
note.com のログインページを開きました。
メールアドレスとパスワードを入力してログインしてください。
ログイン完了後「完了」と教えてください。
```

### Step 5: セッション情報を取得してstorageState形式で保存
ログイン完了後、`mcp__claude-in-chrome__javascript_tool` で実行:

```javascript
// セッション情報を取得
const cookies = document.cookie;
const localStorageData = {};
for (let i = 0; i < localStorage.length; i++) {
  const key = localStorage.key(i);
  localStorageData[key] = localStorage.getItem(key);
}
JSON.stringify({ cookies, localStorageData, origin: window.location.origin });
```

取得したセッション情報を Playwright storageState 形式のJSONに変換して保存:

```json
{
  "cookies": [
    {
      "name": "note_gke_https",
      "value": "<取得した値>",
      "domain": ".note.com",
      "path": "/",
      "httpOnly": true,
      "secure": true,
      "sameSite": "None"
    }
  ],
  "origins": [
    {
      "origin": "https://note.com",
      "localStorage": []
    }
  ]
}
```

Write ツールで `data/note-storage-state.json` に保存する。

### Step 6: 完了報告
```
note.com のセッションを data/note-storage-state.json に保存しました。
NOTE_MODE=browser_assisted で自動投稿が使えます。
セッションの有効期限が切れたら再度このスキルを実行してください。
```

## 注意事項
- `data/note-storage-state.json` は `.gitignore` に含まれていること（秘密情報）
- セッションは定期的に期限切れになる。エラー時は再実行
- Playwright の `NotePlaywrightRunner` がこのファイルを自動的にロードする
