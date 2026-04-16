---
{
  "id": "pricing",
  "kind": "policy",
  "name": "pricing",
  "scope": "note",
  "summary": "価格変更は CV と売上の両方を見て段階的に行う",
  "rules": [
    "急激な価格変更をしない",
    "価格変更後は canary を通す",
    "CV 急落時は rollback する"
  ],
  "thresholds": {
    "maxSingleStepPercent": 20,
    "priceTiers": [490, 690, 980, 1480, 1980],
    "freeThresholdChars": 3000,
    "paidTierChars": [5000, 8000],
    "targetConversionRate": 0.025,
    "priceUpConversionRate": 0.04,
    "priceUpPurchases": 3,
    "priceUpRevenueYen": 3000,
    "priceDownMinViews": 150,
    "priceDownMaxPurchases": 1,
    "priceDownMaxConversionRate": 0.01,
    "priceDownFreeChars": 4500
  }
}
---
# pricing

価格は売上だけでなく購入率と苦情シグナルを見る。急変更は禁止。
