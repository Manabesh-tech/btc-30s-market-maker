module.exports = {
  apps: [
    {
      name: "btc-30s-market-maker",
      script: "scripts/hosted-market-maker-runtime.mjs",
      interpreter: "node",
      env: {
        PORT: "8787",
        QUOTE_CADENCE_MS: "2000",
        PLATFORM_WS_URL: "wss://apis.turboflow.xyz/realtime",
      },
    },
  ],
};
