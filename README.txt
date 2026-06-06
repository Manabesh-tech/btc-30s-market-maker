Developer handoff package created on 2026-06-06.

Core deploy files:
- chainlink_product_suite_final_models.json
- turbo_product_suite_final_models.json
- server.mjs
- package.json
- render.yaml
- Dockerfile
- index.html
- live_chainlink_product_suite_console.js
- live_chainlink_product_suite_console.html

Docs:
- dev_handoff_edge_skew_streaming.md
- chainlink_developer_handoff.md
- chainlink_production_monitor_spec.md

Builder/reference:
- build_chainlink_final_config.py
- build_turbo_final_config.py

Source of truth:
- chainlink_product_suite_final_models.json
- turbo_product_suite_final_models.json

Hosted runtime:
- GET /api/runtime returns the shared hosted control state
- POST /api/runtime updates model, pair, product, edge, alpha, and payout-floor controls
- POST /api/runtime/reset restores defaults
- runtime state is saved to runtime_settings.json while the service is alive
- default hosted edge is 7%
- Render env vars are supported for secrets: CHAINLINK_API_KEY, CHAINLINK_USER_SECRET, TURBO_DB_HOST, TURBO_DB_PORT, TURBO_DB_NAME, TURBO_DB_USER, TURBO_DB_PASSWORD, TURBO_DB_SSLMODE
- optional RUNTIME_STATE_PATH lets you store hosted runtime settings on an attached disk, for example /var/data/runtime_settings.json
