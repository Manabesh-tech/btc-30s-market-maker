## Hosted 30s market-maker runtime

If you want this to keep running when your laptop is closed, the quote engine and trade monitor must run on a server, not inside the browser tab.

### What to host

Run:

```powershell
node scripts/hosted-market-maker-runtime.mjs
```

This starts a background web service that:

- polls Binance Futures top-10 BTCUSDT depth every `2s`
- computes the fitted `30s` quote server-side
- listens to Turboflow public realtime trades
- routes flow by best payout
- tracks counterfactual stream PnL continuously
- exposes live state over:
  - `/api/state`
  - `/events`
  - `/`

### Best deployment options

Use any always-on host:

- small VPS
- Railway / Render / Fly.io
- your own cloud VM

The key requirement is:

- **the Node process must stay running**

### Recommended production shape

1. Run this process on a VPS in Singapore or nearby.
2. Put Nginx or Caddy in front of it.
3. Serve it over HTTPS.
4. Use `pm2` or `systemd` to auto-restart it.

### Example with pm2

```powershell
npm install -g pm2
pm2 start scripts/hosted-market-maker-runtime.mjs --name hosted-mm
pm2 save
pm2 startup
```

### Important limitation

This hosted runtime already solves:

- your laptop closing
- browser tab closing
- quote engine stopping locally

But it is still a **server-side prototype**. If you want the current big HTML console to become the hosted front-end too, the next step is to point that page at this backend instead of running pricing logic in-browser.
