## Permanent deployment options

The local tunnel link is only temporary. For a permanent boss-shareable URL, deploy the hosted runtime:

- runtime: [scripts/hosted-market-maker-runtime.mjs](C:/Users/manab/Documents/Codex/2026-05-22/https-surf-metabaseapp-com-question-8849/scripts/hosted-market-maker-runtime.mjs)
- health endpoint: `/health`
- live state endpoint: `/api/state`
- live SSE endpoint: `/events`

### Fastest option: Render

This repo already includes:

- [render.yaml](C:/Users/manab/Documents/Codex/2026-05-22/https-surf-metabaseapp-com-question-8849/render.yaml)
- [Dockerfile](C:/Users/manab/Documents/Codex/2026-05-22/https-surf-metabaseapp-com-question-8849/Dockerfile)

Steps:

1. Push this folder to a GitHub repo.
2. In Render, create a new Web Service from that repo.
3. Render will detect `render.yaml` and deploy automatically.
4. Share the Render URL with your boss.

### VPS option

This repo already includes:

- [ecosystem.config.cjs](C:/Users/manab/Documents/Codex/2026-05-22/https-surf-metabaseapp-com-question-8849/ecosystem.config.cjs)

On the server:

```bash
git clone <repo>
cd <repo>
npm ci
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Then put Nginx or Caddy in front and attach a domain.

### Railway / Fly

The same Dockerfile works there too. Point the platform at:

```text
npm run hosted
```

or deploy the Dockerfile directly.

### What I still need to finish the real public link for you

One of:

- a Render account/repo connection
- a Railway account
- a VPS IP + SSH credentials

Once I have any one of those, I can finish the permanent deployment steps. 
