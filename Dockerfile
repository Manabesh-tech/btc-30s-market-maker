FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-psycopg2 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY server.mjs ./
COPY index.html ./
COPY live_chainlink_product_suite_console.html ./
COPY live_chainlink_product_suite_console.js ./
COPY chainlink_product_suite_final_models.json ./
COPY chainlink_model2_smoothed_mr_models.json ./
COPY chainlink_model3_fixed_window_models.json ./
COPY turbo_product_suite_final_models.json ./
COPY live_mid_model_30s_best_trade_model.json ./
COPY pool_alpha_proxy_last8h.json ./
COPY runtime_settings.json ./
COPY README.txt ./

ENV PORT=8787
EXPOSE 8787

CMD ["npm", "run", "start"]
