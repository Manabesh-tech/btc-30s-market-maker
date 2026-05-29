# BTC 30s Live Mid Model Walk-Forward Report

Best family: **skew_plus_vol**

## Feature Families
- `skew`: imb_top5_notional, imb_top5_size, imb_top10_notional, imb_top10_size, signed_persist_05, signed_persist_06, microprice_dev_bps
- `momentum`: ret_3s_bps, ret_10s_bps
- `vol`: spread_bps, vol_10s_bps, thin_depth, ret_abs_3s, ret_abs_10s
- `mean_reversion`: mr_gap_bps, mr_snap_bps
- `confirmation`: book_momo_agree, book_micro_agree, persist_agree_05

## Walk-Forward Results
### skew_only
- Mean trade-weighted accuracy: `55.51%`
- Mean logloss: `0.68307`
- Mean Brier: `0.24492`
- 21->22: weighted acc `55.52%`, logloss `0.68282`, rows `12838`, trades `14678`
- 21-22->25: weighted acc `56.78%`, logloss `0.68009`, rows `14460`, trades `17984`
- 21-25->26: weighted acc `54.24%`, logloss `0.6863`, rows `18514`, trades `22138`

### skew_plus_momentum
- Mean trade-weighted accuracy: `55.62%`
- Mean logloss: `0.68296`
- Mean Brier: `0.24487`
- 21->22: weighted acc `55.63%`, logloss `0.68315`, rows `12838`, trades `14678`
- 21-22->25: weighted acc `56.79%`, logloss `0.67984`, rows `14460`, trades `17984`
- 21-25->26: weighted acc `54.44%`, logloss `0.6859`, rows `18514`, trades `22138`

### skew_plus_vol
- Mean trade-weighted accuracy: `55.66%`
- Mean logloss: `0.68359`
- Mean Brier: `0.24497`
- 21->22: weighted acc `55.68%`, logloss `0.68345`, rows `12838`, trades `14678`
- 21-22->25: weighted acc `56.94%`, logloss `0.67949`, rows `14460`, trades `17984`
- 21-25->26: weighted acc `54.37%`, logloss `0.68784`, rows `18514`, trades `22138`

### skew_plus_mean_reversion
- Mean trade-weighted accuracy: `55.61%`
- Mean logloss: `0.68296`
- Mean Brier: `0.24487`
- 21->22: weighted acc `55.62%`, logloss `0.68316`, rows `12838`, trades `14678`
- 21-22->25: weighted acc `56.79%`, logloss `0.67984`, rows `14460`, trades `17984`
- 21-25->26: weighted acc `54.42%`, logloss `0.68589`, rows `18514`, trades `22138`

### core_no_confirmation
- Mean trade-weighted accuracy: `55.61%`
- Mean logloss: `0.68348`
- Mean Brier: `0.24492`
- 21->22: weighted acc `55.49%`, logloss `0.6837`, rows `12838`, trades `14678`
- 21-22->25: weighted acc `56.9%`, logloss `0.67924`, rows `14460`, trades `17984`
- 21-25->26: weighted acc `54.43%`, logloss `0.68749`, rows `18514`, trades `22138`

### core_with_confirmation
- Mean trade-weighted accuracy: `55.57%`
- Mean logloss: `0.68355`
- Mean Brier: `0.24497`
- 21->22: weighted acc `55.52%`, logloss `0.6839`, rows `12838`, trades `14678`
- 21-22->25: weighted acc `56.93%`, logloss `0.67911`, rows `14460`, trades `17984`
- 21-25->26: weighted acc `54.27%`, logloss `0.68764`, rows `18514`, trades `22138`

## Best Model Deployment Parameters
- Feature set: `skew_plus_vol`
- Full-sample weighted accuracy: `55.3%`
- Full-sample logloss: `0.68349`
- Full-sample Brier: `0.24521`

## Recommended Training Policy
- Cadence: `daily Singapore morning retrain`
- Freeze coefficients between retrains; do not self-train every second.
- Use rolling walk-forward promotion only if challenger beats champion on weighted accuracy, logloss, and Brier.
- Keep confirmation features switchable so flow-like confirmation can be enabled later without changing the training scaffold.

## Notes
- This report is built on trade-time seconds from the cached Tardis/orderbook feature export.
- Flow confirmation is left as a switchable feature family, not forced on by default.
