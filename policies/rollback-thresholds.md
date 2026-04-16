---
{
  "id": "rollback-thresholds",
  "kind": "policy",
  "name": "rollback-thresholds",
  "scope": "rollback",
  "summary": "rollback 判定の閾値を policy として外部化する (spec §10 / §20 準拠)",
  "rules": [
    "閾値はコードに固定値で焼き込まない",
    "週次で policy drift review により再調整可能",
    "CTR, purchase rate, revenue per view, complaint signal を deterministic に評価する"
  ],
  "thresholds": {
    "ctrDropRatio": 0.7,
    "purchaseRateDropRatio": 0.6,
    "revenuePerViewDropRatio": 0.6,
    "complaintSpikeCount": 3,
    "complaintWindowHours": 24
  }
}
---
# rollback-thresholds

`src/services/rollback/index.ts` が参照する閾値の policy。

## 各閾値の意味

- **ctrDropRatio**: 直近 funnel snapshot の profile_transition_rate が前回の何倍未満なら rollback トリガーとするか
- **purchaseRateDropRatio**: 同上、purchase rate (purchases / noteViews) について
- **revenuePerViewDropRatio**: 同上、revenue per view について
- **complaintSpikeCount**: complaint 系 anomaly_event が何件以上で rollback トリガーとするか
- **complaintWindowHours**: complaint カウントの集計窓 (時間)

## 調整方針

1週ごとの policy drift review (`weekly-strategy-refresh.ts`) で過去の rollback 履歴と
誤検知率を見て閾値を再調整する。急変更は禁止 (1回あたり ±10% を上限とする)。
