# P1-A POC 結果レポート

- 日付: 2026-04-13T13:10:01.048Z
- サンプル数: 30
- バッチサイズ: 5
- 対象: thread-post-audit (単発版 vs バッチ版)

## 結果サマリ

| 指標 | 実測値 | 合格ライン | 判定 |
|---|---|---|---|
| verdict 一致率 | 86.7% | ≥ 90% | ❌ |
| severity 一致率 | 83.3% | ≥ 85% | ❌ |
| score 絶対差 中央値 | 1 | ≤ 1 | ✅ |
| reasons 項目数差 平均 | 0.47 | ≤ 1 | ✅ |
| suggestions 項目数差 平均 | 0.57 | ≤ 1 | ✅ |

## 総合判定: **不合格 (要再設計)**

## verdict 分布

| verdict | 単発 | バッチ |
|---|---:|---:|
| pass | 10 | 12 |
| revise | 20 | 18 |
| reject | 0 | 0 |
| human_review | 0 | 0 |

## severity 分布

| severity | 単発 | バッチ |
|---|---:|---:|
| low | 10 | 12 |
| medium | 20 | 17 |
| high | 0 | 1 |

## ドラフト別詳細

| draftId | 単発 verdict | バッチ verdict | V一致 | 単発 sev | バッチ sev | S一致 | scoreDiff |
|---|---|---|---|---|---|---|---|
| 2136a4db... | revise | revise | ✅ | medium | medium | ✅ | 0 |
| 5f8d68c1... | pass | pass | ✅ | low | low | ✅ | 1 |
| 82e9f447... | pass | pass | ✅ | low | low | ✅ | 0 |
| 8956c477... | revise | revise | ✅ | medium | medium | ✅ | 1 |
| 7270f700... | pass | pass | ✅ | low | low | ✅ | 1 |
| 8bc542b3... | pass | pass | ✅ | low | low | ✅ | 0 |
| 68cb4bc3... | revise | revise | ✅ | medium | medium | ✅ | 0 |
| 5755696c... | revise | revise | ✅ | medium | medium | ✅ | 0 |
| 0451f380... | revise | revise | ✅ | medium | medium | ✅ | 0 |
| 83072356... | revise | pass | ❌ | medium | low | ❌ | 2 |
| fa594ec0... | revise | revise | ✅ | medium | medium | ✅ | 0 |
| aa7f33f9... | revise | revise | ✅ | medium | medium | ✅ | 1 |
| 4155b9cb... | revise | revise | ✅ | medium | medium | ✅ | 1 |
| 29a7e7fa... | revise | pass | ❌ | medium | low | ❌ | 1 |
| 7a0a8857... | revise | revise | ✅ | medium | medium | ✅ | 0 |
| a105199a... | revise | revise | ✅ | medium | medium | ✅ | 0 |
| 6c93ebf8... | revise | revise | ✅ | medium | medium | ✅ | 0 |
| edbf3ee4... | revise | pass | ❌ | medium | low | ❌ | 2 |
| 19700c22... | pass | pass | ✅ | low | low | ✅ | 0 |
| 80543106... | revise | revise | ✅ | medium | medium | ✅ | 0 |
| a8c53931... | revise | revise | ✅ | medium | medium | ✅ | 0 |
| b0615a6b... | revise | revise | ✅ | medium | medium | ✅ | 1 |
| 4de700d7... | pass | pass | ✅ | low | low | ✅ | 0 |
| 27300b32... | pass | revise | ❌ | low | medium | ❌ | 1 |
| 66181e07... | revise | revise | ✅ | medium | high | ❌ | 2 |
| 2fa0f240... | pass | pass | ✅ | low | low | ✅ | 1 |
| fa25f7ff... | revise | revise | ✅ | medium | medium | ✅ | 1 |
| 3835da62... | pass | pass | ✅ | low | low | ✅ | 1 |
| 8b60a0e3... | revise | revise | ✅ | medium | medium | ✅ | 1 |
| 41a5d31d... | pass | pass | ✅ | low | low | ✅ | 1 |

## 次アクション

- P1-A バッチ化を一時停止
- runDailyThreadsPlan() を単発版に戻す検討
- 不一致ケースを「バッチサイズ」「プロンプト設計」「JSON形式」の3観点で切り分け

## 生データ

サンプルdraftId一覧: 2136a4db-d4e5-41c2-ba24-4bd38ca5849a, 5f8d68c1-a621-4cd9-8f50-641a0fba40c0, 82e9f447-2148-40f3-8618-9b65d50b238c, 8956c477-3580-45b7-a0f1-7ee47610c920, 7270f700-adbd-47a4-86ba-1b7ad0501967, 8bc542b3-9341-4df0-bf17-4fd2de3c2ee0, 68cb4bc3-4c08-4b92-b4ef-3ba4c7b580a6, 5755696c-97d0-4c57-bc96-aba3f3b634de, 0451f380-e2e0-43d0-9bd7-e898c2a9d1a2, 83072356-b81d-4742-b8ba-11d448a3ee38, fa594ec0-e8e6-4ec3-b672-07e37ddfcda7, aa7f33f9-bfa3-4266-a3e9-4776ecf23e7a, 4155b9cb-d0dc-4bd0-82c5-8e251869c31a, 29a7e7fa-2ffc-41ca-959b-60ec7ccc21b8, 7a0a8857-5565-4e58-8e64-a5d3e0d5dd63, a105199a-034e-45cf-94ed-c98dfbca6e2e, 6c93ebf8-0a8b-423e-9b73-61a8992c567c, edbf3ee4-c60e-4f64-96eb-4b73de42b78c, 19700c22-dc16-4727-bada-a1bfa3550c19, 80543106-1a51-488b-a945-c2fe8901236c, a8c53931-a7ce-4b33-844b-6e6a6332d970, b0615a6b-a89b-4bd4-b854-5c28596ddc7e, 4de700d7-1cce-4adb-bc87-7779c2fb8a86, 27300b32-47ff-4931-b128-636a75c344de, 66181e07-05c1-4659-a95c-ddef1b47c8f7, 2fa0f240-1018-4614-b265-8f79925ff0ba, fa25f7ff-393f-41b9-95f7-dfef8d5c7190, 3835da62-bbf1-4c85-aefb-dfa2cab57e07, 8b60a0e3-8586-4df0-8035-ab9bcda856dc, 41a5d31d-3c14-4054-b634-ffdeeb4b9d73
