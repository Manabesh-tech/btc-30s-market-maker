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
COPY turbo_product_suite_final_models.json ./
COPY README.txt ./
COPY runtime_settings.json ./

ENV PORT=8787
EXPOSE 8787

CMD ["npm", "run", "start"]
