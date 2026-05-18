# Community Slab Lab

A non-commercial, community-built fan tool for NFT holders. Drop in a token id and get a community-graded slab card with PNG / GIF / GLB / WebM exports — all rendered in your browser.

**Live:** https://community-slab-lab.vercel.app
&nbsp;&nbsp;_(the previous URL `doodles-slab-lab.vercel.app` still redirects here)_

## What it does

Fetches publicly available on-chain NFT metadata and artwork from IPFS (5-gateway race for sub-second loads), renders a 1200×1680 community-style trading card, and exports the card or a 3D iridescent slab in five formats:

| Export | Format | Typical size | Render time |
|---|---|---|---|
| Card | PNG | ~170 KB | ~310 ms |
| Slab | PNG | ~350 KB | ~315 ms |
| Slab | GIF (30f loop) | ~1.6 MB | ~1.5 s |
| Slab | GLB (3D model) | ~325 KB | ~310 ms |
| Slab | WebM (video) | ~900 KB | ~3 s |

Everything happens client-side — no server, no upload, no tracking.

## Stack

- Vanilla HTML / CSS / JS — no build step, no framework
- Three.js loaded via `<script type="importmap">` (ES module CDN imports)
- `gif.js` for GIF encoding (worker fetched as Blob to avoid CORS)
- `MediaRecorder` + `canvas.captureStream()` for WebM
- `GLTFExporter` from `three/addons` for GLB
- IPFS fetched via `Promise.any` racing 5 gateways (Pinata, dweb.link, nft.storage, w3s.link, ipfs.io)

## Run locally

```bash
python3 -m http.server 8765
# open http://localhost:8765
```

Any static file server works — the app is fully client-side.

## Deploy

Hosted on Vercel with automatic deploys on push to `main`. Manual deploy:

```bash
vercel deploy --prod --yes
```

## Legal / non-affiliation

This project is an **independent, non-commercial fan tool** built by a member of the NFT community for other holders. It only renders publicly available on-chain token metadata into a decorative card frame for personal use.

**It is NOT affiliated with, endorsed by, or sponsored by:**

- Doodles LLC
- PSA (Professional Sports Authenticator)
- Burnt Toast (the original Doodles artist)
- The Pokémon Company

All trademarks, names, logos and artwork are the property of their respective owners. No claim of ownership over any collection's intellectual property is made or implied. If you are a rights-holder and have concerns about this project, please open an issue and the project will respond promptly.
