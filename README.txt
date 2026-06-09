Advanced deployment package prepared on 9 June 2026.

This folder is the latest curated advanced handoff for devs.

Advanced additions in this version:
- server-side rolling history cache for seamless warm-up on hosted pages
- client-side history preload from server on page open
- latest unified dashboard with both Chainlink and Turbo families
- latest Turbo ETH 30s and 1m short-tenor fills

Source-of-truth model files:
- chainlink_product_suite_final_models.json
- chainlink_model2_smoothed_mr_models.json
- chainlink_model3_fixed_window_models.json
- turbo_product_suite_final_models.json

Main runtime files:
- live_chainlink_product_suite_console.html
- live_chainlink_product_suite_console.js
- server.mjs

Deployment support files:
- Dockerfile
- package.json
- render.yaml
- runtime_settings.json

Reference / explanation:
- product_suite_full_deployment_guide_20260609.docx
- product_suite_full_deployment_guide_20260609.pdf

Builder references:
- build_chainlink_final_config.py
- build_turbo_final_config.py
