/* Doodles Slab Lab — PSA-style 3D graded slab
 * Three.js renders a black plastic encapsulation case with a red-bordered
 * cert label window and the Doodle card visible through the plastic.
 * Rotating animation reveals foil/holo reflections (env map + clearcoat).
 *
 * The same Three.js scene drives:
 *   - the live on-screen preview (looping rotation)
 *   - Slab PNG  (one frame, hi-res, at a flattering angle)
 *   - Slab GIF  (frames around a full rotation)
 *   - Slab WebM (MediaRecorder on canvas.captureStream)
 *   - Slab GLB  (GLTFExporter of the whole scene incl. card texture)
 * Card PNG is rendered separately as a flat trading-card image (no slab).
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

// ============================================================================
// Config
// ============================================================================
const DOODLES = {
  contract: "0x8a90CAb2b38dba80c64b7734e58Ee1dB38B8992e",
  metadataCID: "QmPMc4tcBsMqLRuCQtPmPe84bpSjrC3Ky7t3JWuHXYB4aS",
  maxId: 9999,
  gateways: [
    "https://gateway.pinata.cloud/ipfs",
    "https://dweb.link/ipfs",
    "https://nftstorage.link/ipfs",
    "https://w3s.link/ipfs",
    "https://ipfs.io/ipfs",
  ],
};

const GIFJS_URL    = "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.js";
const GIFJS_WORKER = "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js";

// Slab geometry — 5:7 ratio like a trading card
const SLAB_W = 1.0;
const SLAB_H = 1.4;
const SLAB_D = 0.05;

// Texture resolution — high enough that the card text is sharp on hi-res displays
const TEX_W = 1024;
const TEX_H = Math.round(TEX_W * SLAB_H / SLAB_W); // 1434

// ============================================================================
// DOM refs
// ============================================================================
const $ = (id) => document.getElementById(id);
const canvas       = $("slabCanvas");
const tokenInput   = $("tokenInput");
const slabIt       = $("slabIt");
const randomBtn    = $("randomSlab");
const exportBtns   = document.querySelectorAll(".btn[data-export]");
const stageLoading = $("stageLoading");
const loadingLabel = $("loadingLabel");
const stageToast   = $("stageToast");
const dockError    = $("dockError");
const footerYear   = $("footerYear");
footerYear.textContent = new Date().getFullYear();

// ============================================================================
// State
// ============================================================================
const cache = new Map();
/** @type {{id:string, metadata:any, imageURL:string, image:HTMLImageElement}|null} */
let current = null;
let errorTimer = null, toastTimer = null;

// ============================================================================
// UI helpers
// ============================================================================
function showError(msg, sticky = false) {
  clearTimeout(errorTimer);
  if (!msg) { dockError.hidden = true; dockError.textContent = ""; return; }
  dockError.hidden = false;
  dockError.textContent = msg;
  if (!sticky) errorTimer = setTimeout(() => showError(""), 4500);
}
function showToast(msg, ms = 1800) {
  clearTimeout(toastTimer);
  stageToast.textContent = msg;
  stageToast.hidden = false;
  toastTimer = setTimeout(() => (stageToast.hidden = true), ms);
}
function setLoading(on, label) {
  if (label) loadingLabel.textContent = label;
  stageLoading.hidden = !on;
}
function setBusy(on) {
  [slabIt, randomBtn, ...exportBtns].forEach((b) => (b.disabled = !!on));
}
function certFor(id) {
  const seed = ((Number(id) + 1) * 2654435761) >>> 0;
  return String(10_000_000 + (seed % 89_999_999));
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function canvasToBlob(c, type = "image/png", quality) {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob null"))), type, quality);
  });
}

// ============================================================================
// IPFS — parallel gateway race
// ============================================================================
async function raceMetadata(tokenId) {
  const ctrls = DOODLES.gateways.map(() => new AbortController());
  const tasks = DOODLES.gateways.map((gw, i) =>
    fetch(`${gw}/${DOODLES.metadataCID}/${tokenId}`, { signal: ctrls[i].signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { gw, data: await r.json() };
      })
  );
  let winner;
  try { winner = await Promise.any(tasks); }
  catch { throw new Error("All IPFS gateways failed (metadata)"); }
  DOODLES.gateways.forEach((gw, i) => { if (gw !== winner.gw) ctrls[i].abort(); });
  return winner;
}

function raceImage(imageCID, preferredGw) {
  const ordered = [preferredGw, ...DOODLES.gateways.filter((g) => g !== preferredGw)];
  const urls = ordered.map((gw) => `${gw}/${imageCID}`);
  return new Promise((resolve, reject) => {
    const imgs = urls.map(() => { const img = new Image(); img.crossOrigin = "anonymous"; return img; });
    let resolved = false, errored = 0;
    urls.forEach((u, i) => {
      imgs[i].addEventListener("load", () => {
        if (resolved) return;
        resolved = true;
        imgs.forEach((other, j) => { if (j !== i) other.src = ""; });
        resolve({ image: imgs[i], url: u });
      });
      imgs[i].addEventListener("error", () => {
        errored++;
        if (errored === urls.length && !resolved) reject(new Error("All IPFS gateways failed (image)"));
      });
      imgs[i].src = u;
    });
  });
}

async function fetchDoodle(id) {
  const tokenId = String(id);
  if (cache.has(tokenId)) return cache.get(tokenId);
  const t0 = performance.now();
  const meta = await raceMetadata(tokenId);
  const imageCID = String(meta.data.image || "").replace(/^ipfs:\/\//, "");
  if (!imageCID) throw new Error("Metadata missing image field");
  const { image, url: imageURL } = await raceImage(imageCID, meta.gw);
  const t1 = performance.now();
  const entry = { id: tokenId, metadata: meta.data, imageURL, image, gw: meta.gw, loadMs: Math.round(t1 - t0) };
  cache.set(tokenId, entry);
  return entry;
}

// ============================================================================
// Canvas drawing — the full slab FRONT as a single texture
// ============================================================================
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Render the entire slab FRONT to a canvas. This canvas becomes the texture
 * for the +Z face of the slab mesh.
 *
 * Layout (referenced from real PSA graded NFT slabs):
 *   [black plastic case]
 *   ┌──────────────────────┐
 *   │ ┌──────────────────┐ │  <- red-bordered cert label (~7% from top)
 *   │ │ 2026 DOODLES™ #X │ │
 *   │ │ DOODLES OFFICIAL │ │
 *   │ │ ART RARE, JPEG   │ │  GEM MT
 *   │ └──────────────────┘ │  10
 *   │ ┌──────────────────┐ │
 *   │ │ DOODLES       ✿  │ │  <- card (cream) header
 *   │ │                  │ │
 *   │ │   [DOODLE IMG]   │ │
 *   │ │                  │ │
 *   │ │ DOODLES #X       │ │
 *   │ │ FACE   HAIR      │ │  <- traits in 2 cols
 *   │ │ skull  bowlcut   │ │
 *   │ │ ...              │ │
 *   │ └──────────────────┘ │
 *   └──────────────────────┘
 */
function drawSlabFront(canvas, entry) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  // --- Black plastic background (the slab case) ---
  ctx.fillStyle = "#0b0b0d";
  ctx.fillRect(0, 0, W, H);

  // Subtle highlight at the top (fake light reflection on glossy plastic)
  const topShine = ctx.createLinearGradient(0, 0, 0, H * 0.35);
  topShine.addColorStop(0, "rgba(255,255,255,0.08)");
  topShine.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = topShine;
  ctx.fillRect(0, 0, W, H * 0.35);

  // ===== Cert label window =====
  // Thinner black frame so the card fills more of the slab
  const PAD = Math.round(W * 0.028);
  const certX = PAD, certY = Math.round(H * 0.022);
  const certW = W - PAD * 2;
  const certH = Math.round(H * 0.095); // a touch taller so text breathes

  // PSA red border ring
  ctx.fillStyle = "#c8102e";
  roundRectPath(ctx, certX - 5, certY - 5, certW + 10, certH + 10, 5);
  ctx.fill();
  // Off-white interior
  ctx.fillStyle = "#f4efe2";
  roundRectPath(ctx, certX, certY, certW, certH, 2);
  ctx.fill();

  // Cert text — monospace, much bigger so it's readable when downscaled
  const fontMono = "JetBrains Mono, Menlo, Consolas, monospace";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#111";

  // Layout: 3 left-side lines + 3 right-side blocks (id / GEM MT / 10)
  const padInner = Math.round(certH * 0.12);
  const lineH = Math.round(certH * 0.30);
  const leftSize = Math.round(certH * 0.22);
  ctx.font = `700 ${leftSize}px ${fontMono}`;
  ctx.textAlign = "left";
  const tx = certX + padInner * 1.5;
  let ty = certY + padInner + leftSize;
  ctx.fillText(`${new Date().getFullYear()} DOODLES™`, tx, ty);
  ty += lineH;
  ctx.fillText("DOODLES OFFICIAL", tx, ty);
  ty += lineH;
  ctx.fillText("ART RARE, JPEG", tx, ty);

  // Right block
  ctx.textAlign = "right";
  const rx = certX + certW - padInner * 1.5;
  const idText = "#" + (entry ? entry.id : "----");
  const idSize = Math.round(certH * 0.26);
  ctx.font = `700 ${idSize}px ${fontMono}`;
  ctx.fillText(idText, rx, certY + padInner + idSize);
  const gemSize = Math.round(certH * 0.20);
  ctx.font = `700 ${gemSize}px ${fontMono}`;
  ctx.fillText("GEM MT", rx, certY + padInner + idSize + Math.round(certH * 0.26));
  const gradeSize = Math.round(certH * 0.46);
  ctx.font = `800 ${gradeSize}px ${fontMono}`;
  ctx.fillText("10", rx, certY + certH - padInner * 0.4);

  // ===== Card window (cream paper) — fills almost everything below cert =====
  const cardX = PAD, cardY = certY + certH + Math.round(H * 0.014);
  const cardW = W - PAD * 2;
  const cardH = H - cardY - PAD;
  drawCardContent(ctx, cardX, cardY, cardW, cardH, entry);

  // ============== HOLOGRAPHIC FOIL — multi-layer, baked into texture ==============
  // The card itself is in the rectangle [cardX, cardY, cardX+cardW, cardY+cardH].
  // We apply STRONG foil to the black plastic frame around the card, and a
  // subtler tint over the card so the whole slab feels like it's encased in
  // iridescent plastic — but the doodle stays readable.

  // Build a path covering only the BLACK PLASTIC frame (slab minus card minus cert label).
  // evenodd fill rule turns the inner rects into holes — foil only on the outer plastic.
  const frameRegion = new Path2D();
  frameRegion.rect(0, 0, W, H);
  frameRegion.rect(cardX, cardY, cardW, cardH);                 // hole: card
  frameRegion.rect(certX - 6, certY - 6, certW + 12, certH + 12); // hole: cert label (incl. red border)

  // ── LAYER 1: STRONG rainbow band across the whole slab (diagonal) ──
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  const rainbow = ctx.createLinearGradient(W * -0.1, H * -0.1, W * 1.1, H * 1.1);
  rainbow.addColorStop(0.00, "rgba(255, 60,140,0.55)"); // hot pink
  rainbow.addColorStop(0.18, "rgba(255,150, 60,0.50)"); // orange
  rainbow.addColorStop(0.34, "rgba(255,230, 80,0.45)"); // gold
  rainbow.addColorStop(0.50, "rgba(100,255,160,0.50)"); // mint green
  rainbow.addColorStop(0.66, "rgba( 60,200,255,0.55)"); // cyan
  rainbow.addColorStop(0.82, "rgba(180,100,255,0.55)"); // violet
  rainbow.addColorStop(1.00, "rgba(255, 70,180,0.55)"); // pink
  ctx.fillStyle = rainbow;
  // Strong on the frame
  ctx.fill(frameRegion, "evenodd");
  ctx.restore();

  // ── LAYER 2: lighter rainbow tint over the card (so the doodle stays clear) ──
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  const cardTint = ctx.createLinearGradient(cardX, cardY, cardX + cardW, cardY + cardH);
  cardTint.addColorStop(0.00, "rgba(255, 80,160,0.10)");
  cardTint.addColorStop(0.33, "rgba(255,210, 90,0.08)");
  cardTint.addColorStop(0.66, "rgba( 80,220,255,0.10)");
  cardTint.addColorStop(1.00, "rgba(200,100,255,0.10)");
  ctx.fillStyle = cardTint;
  ctx.fillRect(cardX, cardY, cardW, cardH);
  ctx.restore();

  // ── LAYER 3: diagonal rainbow stripes (real holo stripes pattern) ──
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.translate(W / 2, H / 2);
  ctx.rotate(-0.55);
  ctx.translate(-W, -H);
  const stripeCount = 14;
  const stripeColors = [
    [255, 80,140], [255,180, 60], [180,255,100],
    [ 80,220,220], [120,140,255], [220, 80,200],
  ];
  for (let i = 0; i < stripeCount; i++) {
    const x = (i / stripeCount) * (W * 2.4);
    const col = stripeColors[i % stripeColors.length];
    const g = ctx.createLinearGradient(x, 0, x + W * 0.08, H * 2);
    g.addColorStop(0.0, `rgba(${col[0]},${col[1]},${col[2]},0)`);
    g.addColorStop(0.5, `rgba(${col[0]},${col[1]},${col[2]},0.35)`);
    g.addColorStop(1.0, `rgba(${col[0]},${col[1]},${col[2]},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, W * 0.08, H * 2.5);
  }
  ctx.restore();

  // ── LAYER 4: bright "money shot" white highlight (vertical band) ──
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  const shine = ctx.createLinearGradient(W * 0.30, 0, W * 0.55, H);
  shine.addColorStop(0.00, "rgba(255,255,255,0)");
  shine.addColorStop(0.45, "rgba(255,255,255,0.08)");
  shine.addColorStop(0.50, "rgba(255,255,255,0.30)");
  shine.addColorStop(0.55, "rgba(255,255,255,0.08)");
  shine.addColorStop(1.00, "rgba(255,255,255,0)");
  ctx.fillStyle = shine;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // ── LAYER 5: sparkle dots scattered on the black plastic ──
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  // Deterministic sparkle positions based on a simple LCG seeded from slab dims
  let seed = 1234567;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 90; i++) {
    const x = rng() * W, y = rng() * H, r = 1 + rng() * 3.5;
    // skip sparkles that would land on the card (most concentration on frame)
    if (x > cardX && x < cardX + cardW && y > cardY && y < cardY + cardH) {
      if (rng() > 0.25) continue; // 25% of card-area sparkles survive
    }
    const hue = rng();
    const col =
      hue < 0.20 ? "rgba(255,255,255,0.95)" :
      hue < 0.40 ? "rgba(255,200,255,0.85)" :
      hue < 0.60 ? "rgba(180,255,255,0.85)" :
      hue < 0.80 ? "rgba(255,230,160,0.85)" :
                   "rgba(220,180,255,0.85)";
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.globalCompositeOperation = "source-over";
}

function drawCardContent(ctx, x, y, w, h, entry) {
  // Cream paper
  ctx.fillStyle = "#f5f1e5";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(0,0,0,0.06)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  const innerPad = Math.round(w * 0.04);

  // === Card header strip: "DOODLES" wordmark + ✿ logo ===
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#111";
  ctx.textAlign = "left";
  const wordSize = Math.round(h * 0.055); // bumped from 0.04
  ctx.font = `400 ${wordSize}px Anton, 'Inter', system-ui, sans-serif`;
  ctx.fillText("DOODLES", x + innerPad, y + innerPad + wordSize * 0.88);

  // ✿ flower logo top-right
  drawCardLogo(ctx, x + w - innerPad - wordSize * 0.7, y + innerPad + wordSize * 0.42, wordSize * 0.5);

  // === Image area ===
  const imgY = y + innerPad + wordSize + Math.round(h * 0.020);
  const imgH = Math.round(h * 0.56);
  const imgX = x + innerPad;
  const imgW = w - innerPad * 2;

  ctx.fillStyle = "#e8ecf2";
  ctx.fillRect(imgX, imgY, imgW, imgH);

  if (entry && entry.image && entry.image.complete && entry.image.naturalWidth) {
    const img = entry.image;
    const s = Math.min(imgW / img.naturalWidth, imgH / img.naturalHeight);
    const dw = img.naturalWidth * s;
    const dh = img.naturalHeight * s;
    // Big vibrance boost so the NFT really pops off the cream card
    const prevFilter = ctx.filter;
    ctx.filter = "saturate(1.55) contrast(1.18) brightness(1.05)";
    ctx.drawImage(img, imgX + (imgW - dw) / 2, imgY + (imgH - dh) / 2, dw, dh);
    ctx.filter = prevFilter;
  } else {
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.font = `500 ${Math.round(h * 0.028)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("Type a token id and click Slab it",
      x + w / 2, imgY + imgH / 2);
  }

  // === Bottom block: token id + traits ===
  const botY = imgY + imgH + Math.round(h * 0.022);
  ctx.textAlign = "left";
  ctx.fillStyle = "#111";
  // Title much bigger so it's the clear focal point of the lower section
  const titleSize = Math.round(h * 0.046);
  ctx.font = `400 ${titleSize}px Anton, 'Inter', system-ui, sans-serif`;
  const titleText = entry ? `DOODLES #${entry.id}` : "DOODLES #----";
  ctx.fillText(titleText, x + innerPad, botY + titleSize * 0.88);

  // Traits in 2 columns (up to 6) — bigger labels and values
  const traits = (entry && entry.metadata && entry.metadata.attributes) || [];
  const traitsY = botY + titleSize + Math.round(h * 0.020);
  const colGap = Math.round(w * 0.025);
  const colW = (w - innerPad * 2 - colGap) / 2;
  const rowH = Math.round(h * 0.060);
  const labelSize = Math.round(h * 0.022); // was 0.014
  const valSize   = Math.round(h * 0.030); // was 0.020

  for (let i = 0; i < Math.min(6, traits.length); i++) {
    const t = traits[i];
    const col = i % 2;
    const row = Math.floor(i / 2);
    const tx = x + innerPad + col * (colW + colGap);
    const ty = traitsY + row * rowH;

    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.font = `700 ${labelSize}px JetBrains Mono, monospace`;
    ctx.fillText(String(t.trait_type || "").toUpperCase(), tx, ty + labelSize);

    ctx.fillStyle = "#111";
    ctx.font = `600 ${valSize}px Inter, system-ui, sans-serif`;
    let val = String(t.value || "");
    while (val.length > 0 && ctx.measureText(val).width > colW) val = val.slice(0, -1);
    ctx.fillText(val, tx, ty + labelSize + valSize + 4);
  }
}

function drawCardLogo(ctx, cx, cy, size) {
  // simple flower glyph as the Doodles mark, drawn vector so it's crisp
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = "#111";
  for (let i = 0; i < 5; i++) {
    ctx.rotate((Math.PI * 2) / 5);
    ctx.beginPath();
    ctx.ellipse(0, -size * 0.6, size * 0.32, size * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.32, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.restore();
}

// ============================================================================
// Three.js scene (with 2D fallback when WebGL is unavailable)
// ============================================================================
let renderer, scene, camera;
let slabMesh, frontMaterial, slabTextureCanvas, slabTexture;
let rafId = null;
let manualRotation = false;
let manualRot = { x: 0, y: 0 };
let use3D = false;
let fallback2DCanvas = null; // 2D context drawn to the page canvas when WebGL fails

function init3D() {
  renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: true, preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  scene = new THREE.Scene();
  scene.background = null;

  camera = new THREE.PerspectiveCamera(24, 1, 0.1, 100);
  camera.position.set(0, 0, 3.7); // closer so slab fills ~88% of view
  camera.lookAt(0, 0, 0);

  // Environment for plastic reflections (looks like a softbox studio)
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // Lighting
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(3, 4, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xb8d5ff, 0.5);
  rim.position.set(-4, -1, 3);
  scene.add(rim);
  scene.add(new THREE.AmbientLight(0xffffff, 0.3));

  // Slab body (rounded box for soft edges)
  const slabGeom = new RoundedBoxGeometry(SLAB_W, SLAB_H, SLAB_D, 6, 0.02);

  // Texture for the +Z (front) face
  slabTextureCanvas = document.createElement("canvas");
  slabTextureCanvas.width  = TEX_W;
  slabTextureCanvas.height = TEX_H;
  drawSlabFront(slabTextureCanvas, null);

  slabTexture = new THREE.CanvasTexture(slabTextureCanvas);
  slabTexture.colorSpace = THREE.SRGBColorSpace;
  slabTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  slabTexture.needsUpdate = true;

  // Single material with the slab front texture — glossy clear-coat plastic
  // RoundedBoxGeometry has standard box UVs; the texture wraps around but the
  // sides/back are thin enough that we don't really see them. We use a single
  // material and accept that. Alternatively could split into multi-material.
  frontMaterial = new THREE.MeshPhysicalMaterial({
    map: slabTexture,
    roughness: 0.28,
    metalness: 0.08,
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
    envMapIntensity: 1.4,
    iridescence: 0.7,           // ← real holographic shimmer
    iridescenceIOR: 1.45,
    iridescenceThicknessRange: [180, 520],
    side: THREE.FrontSide,
  });

  slabMesh = new THREE.Mesh(slabGeom, frontMaterial);
  scene.add(slabMesh);

  use3D = true;

  // resize handler
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas.parentElement);

  // pointer drag for manual rotation (optional UX)
  let dragging = false, dragStart = { x: 0, y: 0 }, rotStart = { x: 0, y: 0 };
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true; manualRotation = true;
    dragStart = { x: e.clientX, y: e.clientY };
    rotStart = { x: slabMesh.rotation.x, y: slabMesh.rotation.y };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = (e.clientX - dragStart.x) / 200;
    const dy = (e.clientY - dragStart.y) / 200;
    manualRot.y = rotStart.y + dx;
    manualRot.x = rotStart.x + dy;
  });
  canvas.addEventListener("pointerup", () => { dragging = false; });
  canvas.addEventListener("dblclick", () => { manualRotation = false; }); // resume auto

  // start animation
  startAutoRotate();
}

function resize() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  if (use3D) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  } else if (fallback2DCanvas) {
    // 2D fallback: HiDPI canvas
    const pr = Math.min(window.devicePixelRatio, 2);
    canvas.width = Math.floor(w * pr);
    canvas.height = Math.floor(h * pr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    render2DPreview();
  }
}

function startAutoRotate() {
  if (rafId) return;
  const start = performance.now();
  function tick(now) {
    const t = (now - start) * 0.001;
    if (use3D) {
      if (manualRotation) {
        slabMesh.rotation.x = manualRot.x;
        slabMesh.rotation.y = manualRot.y;
      } else {
        slabMesh.rotation.y = Math.sin(t * 0.55) * 0.32; // ±18°
        slabMesh.rotation.x = Math.cos(t * 0.4)  * 0.05;
      }
      renderer.render(scene, camera);
    } else {
      render2DPreview(t);
    }
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);
}

function stopAutoRotate() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

function rerenderSlabTexture() {
  drawSlabFront(slabTextureCanvas, current);
  if (use3D && slabTexture) slabTexture.needsUpdate = true;
  if (!use3D) render2DPreview();
}

// ----- 2D fallback preview --------------------------------------------------
function init2DFallback() {
  use3D = false;
  // Ensure slabTextureCanvas exists
  if (!slabTextureCanvas) {
    slabTextureCanvas = document.createElement("canvas");
    slabTextureCanvas.width = TEX_W;
    slabTextureCanvas.height = TEX_H;
    drawSlabFront(slabTextureCanvas, null);
  }
  fallback2DCanvas = canvas.getContext("2d");
  resize();
}

function render2DPreview(t = 0) {
  if (!fallback2DCanvas) return;
  const W = canvas.width, H = canvas.height;
  const ctx = fallback2DCanvas;
  ctx.clearRect(0, 0, W, H);

  // Fit slab in canvas with margin
  const margin = 0.95;
  const slabAspect = SLAB_W / SLAB_H;
  let drawH = H * margin;
  let drawW = drawH * slabAspect;
  if (drawW > W * margin) { drawW = W * margin; drawH = drawW / slabAspect; }

  // Simulated rotation (small skew + scale to mimic 3D)
  const rotY = Math.sin(t * 0.55) * 0.22; // radians
  const skewX = -rotY * 0.18;
  const visScale = Math.cos(rotY) * 0.97 + 0.03;

  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.transform(visScale, 0, skewX, 1, 0, 0);
  // shadow
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 30;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 12;
  ctx.drawImage(slabTextureCanvas, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();

  // Moving foil highlight across the slab
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  const hg = ctx.createLinearGradient(
    W * 0.2 + Math.sin(t * 0.8) * W * 0.3, 0,
    W * 0.6 + Math.sin(t * 0.8) * W * 0.3, H
  );
  hg.addColorStop(0.0, "rgba(255,255,255,0)");
  hg.addColorStop(0.5, "rgba(255,255,255,0.10)");
  hg.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = hg;
  ctx.fillRect(W / 2 - drawW / 2, H / 2 - drawH / 2, drawW, drawH);
  ctx.restore();
}

// ============================================================================
// Exports
// ============================================================================
function requireCurrent() {
  if (!current) throw new Error("Load a Doodle first — type a token id and click Slab it.");
  return current;
}

// -- Card PNG: flat trading card (no slab plastic, no cert label) ------------
async function exportCardPNG() {
  const e = requireCurrent();
  const W = 1200, H = Math.round(W * SLAB_H / SLAB_W); // 1680
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";

  // Use just the cream card content, full-bleed
  drawCardContent(ctx, 0, 0, W, H, e);
  downloadBlob(await canvasToBlob(c, "image/png"), `doodle-card-${e.id}.png`);
  showToast("✿ card PNG saved");
}

// -- Slab PNG: render scene at high res, single frame ------------------------
async function exportSlabPNG() {
  const e = requireCurrent();
  if (use3D) {
    const prev = new THREE.Vector2(); renderer.getSize(prev);
    const prevPR = renderer.getPixelRatio();
    const prevRotY = slabMesh.rotation.y, prevRotX = slabMesh.rotation.x;
    try {
      stopAutoRotate();
      const W = 2000, H = Math.round(W * SLAB_H / SLAB_W);
      renderer.setPixelRatio(1);
      renderer.setSize(W, H, false);
      camera.aspect = W / H; camera.updateProjectionMatrix();
      slabMesh.rotation.y = -0.18;
      slabMesh.rotation.x = 0.05;
      renderer.render(scene, camera);
      const blob = await canvasToBlob(canvas, "image/png");
      downloadBlob(blob, `doodle-slab-${e.id}.png`);
      showToast("✿ slab PNG saved");
    } finally {
      renderer.setPixelRatio(prevPR);
      renderer.setSize(prev.x, prev.y, false);
      camera.aspect = prev.x / prev.y; camera.updateProjectionMatrix();
      slabMesh.rotation.y = prevRotY;
      slabMesh.rotation.x = prevRotX;
      startAutoRotate();
    }
  } else {
    // 2D fallback: render slab DIRECTLY at high resolution (no upscale of
    // the cached texture) so all text is razor-sharp.
    const W = 1600;
    const H = Math.round(W * SLAB_H / SLAB_W) + 160;
    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const ctx = out.getContext("2d");
    ctx.imageSmoothingQuality = "high";

    // Solid dark bg
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, W, H);

    // Render slab front at the size we'll display it
    const drawW = Math.round(W * 0.92);
    const drawH = Math.round(drawW * SLAB_H / SLAB_W);
    const slabHighRes = document.createElement("canvas");
    slabHighRes.width = drawW;
    slabHighRes.height = drawH;
    drawSlabFront(slabHighRes, e);

    // Tilt + shadow
    const angle = 0.12;
    const skewX = -angle * 0.18;
    const visScale = Math.cos(angle) * 0.97 + 0.03;

    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.transform(visScale, 0, skewX, 1, 0, 0);
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 50;
    ctx.shadowOffsetY = 22;
    ctx.drawImage(slabHighRes, -drawW / 2, -drawH / 2);
    ctx.restore();

    const blob = await canvasToBlob(out, "image/png");
    downloadBlob(blob, `doodle-slab-${e.id}.png`);
    showToast("✿ slab PNG saved");
  }
}

// -- GIF (lazy load gif.js) --------------------------------------------------
let gifLoading = null, gifWorkerUrl = null;
function ensureGifJs() {
  if (gifLoading) return gifLoading;
  gifLoading = (async () => {
    if (!window.GIF) {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = GIFJS_URL; s.async = true;
        s.onload = resolve;
        s.onerror = () => reject(new Error("Failed to load gif.js"));
        document.head.appendChild(s);
      });
    }
    if (!gifWorkerUrl) {
      const r = await fetch(GIFJS_WORKER);
      if (!r.ok) throw new Error("Failed to fetch gif.worker.js");
      gifWorkerUrl = URL.createObjectURL(await r.blob());
    }
  })();
  return gifLoading;
}

async function exportSlabGIF() {
  const e = requireCurrent();
  setLoading(true, "rendering gif…");
  await ensureGifJs();

  // 900x1260 — high enough that cert label text is sharp after gif quantization
  const W = 900, H = Math.round(W * SLAB_H / SLAB_W);
  const gif = new window.GIF({
    workers: 2, quality: 10, width: W, height: H, workerScript: gifWorkerUrl,
  });

  if (use3D) {
    const prev = new THREE.Vector2(); renderer.getSize(prev);
    const prevPR = renderer.getPixelRatio();
    const prevRotY = slabMesh.rotation.y, prevRotX = slabMesh.rotation.x;
    try {
      stopAutoRotate();
      renderer.setPixelRatio(1);
      renderer.setSize(W, H, false);
      camera.aspect = W / H; camera.updateProjectionMatrix();
      scene.background = new THREE.Color(0x0a0a0a); // bg for transparency-safe GIF

      const FRAMES = 36, DELAY = 70;
      for (let i = 0; i < FRAMES; i++) {
        const t = i / FRAMES;
        slabMesh.rotation.y = Math.sin(t * Math.PI * 2) * 0.35;
        slabMesh.rotation.x = Math.cos(t * Math.PI * 2) * 0.06;
        renderer.render(scene, camera);
        const frame = document.createElement("canvas");
        frame.width = W; frame.height = H;
        frame.getContext("2d").drawImage(canvas, 0, 0, W, H);
        gif.addFrame(frame, { delay: DELAY });
      }
    } finally {
      scene.background = null;
      renderer.setPixelRatio(prevPR);
      renderer.setSize(prev.x, prev.y, false);
      camera.aspect = prev.x / prev.y; camera.updateProjectionMatrix();
      slabMesh.rotation.y = prevRotY;
      slabMesh.rotation.x = prevRotX;
      startAutoRotate();
    }
  } else {
    // 2D fallback: simulated rotation via canvas transforms
    const FRAMES = 36, DELAY = 70;
    for (let i = 0; i < FRAMES; i++) {
      const t = i / FRAMES;
      const frame = document.createElement("canvas");
      frame.width = W; frame.height = H;
      render2DSlabFrame(frame, t);
      gif.addFrame(frame, { delay: DELAY });
    }
  }

  const blob = await new Promise((resolve, reject) => {
    gif.on("finished", resolve);
    gif.on("abort", () => reject(new Error("GIF aborted")));
    gif.render();
  });
  downloadBlob(blob, `doodle-slab-${e.id}.gif`);
  showToast("✿ slab GIF saved");
}

// 2D fallback frame: draws the slab on a bg with rotation simulation + animated foil
function render2DSlabFrame(target, t /* 0..1 */) {
  const W = target.width, H = target.height;
  const ctx = target.getContext("2d");
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, W, H);

  const margin = 0.95;
  const slabAspect = SLAB_W / SLAB_H;
  let drawH = H * margin;
  let drawW = drawH * slabAspect;
  if (drawW > W * margin) { drawW = W * margin; drawH = drawW / slabAspect; }

  const angle = Math.sin(t * Math.PI * 2) * 0.32;
  const skewX = -angle * 0.18;
  const visScale = Math.cos(angle) * 0.97 + 0.03;

  // ── Draw slab with tilt + shadow
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.transform(visScale, 0, skewX, 1, 0, 0);
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 18;
  ctx.drawImage(slabTextureCanvas, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();

  // ── Animated holographic foil clipped to slab bounds ──
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.transform(visScale, 0, skewX, 1, 0, 0);
  ctx.beginPath();
  ctx.rect(-drawW / 2, -drawH / 2, drawW, drawH);
  ctx.clip();
  // back to canvas-space coords for gradients
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Rainbow that shifts with rotation
  const sweep = angle * W * 0.55;
  ctx.globalCompositeOperation = "screen";
  const cx = W / 2 + sweep;
  const rainbow = ctx.createLinearGradient(cx - W * 0.45, 0, cx + W * 0.45, H);
  rainbow.addColorStop(0.00, "rgba(255,80,140,0)");
  rainbow.addColorStop(0.18, "rgba(255,80,140,0.22)");
  rainbow.addColorStop(0.33, "rgba(255,200,80,0.22)");
  rainbow.addColorStop(0.50, "rgba(120,255,160,0.20)");
  rainbow.addColorStop(0.67, "rgba(80,200,255,0.22)");
  rainbow.addColorStop(0.82, "rgba(180,120,255,0.22)");
  rainbow.addColorStop(1.00, "rgba(255,80,180,0)");
  ctx.fillStyle = rainbow;
  ctx.fillRect(0, 0, W, H);

  // White hotspot
  const hx = W / 2 + angle * W * 0.4;
  const hg = ctx.createLinearGradient(hx - W * 0.15, 0, hx + W * 0.15, H);
  hg.addColorStop(0.0, "rgba(255,255,255,0)");
  hg.addColorStop(0.5, "rgba(255,255,255,0.22)");
  hg.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = hg;
  ctx.fillRect(0, 0, W, H);

  // Diagonal shimmer streaks
  ctx.globalCompositeOperation = "overlay";
  ctx.save();
  ctx.translate(W / 2 + sweep * 0.3, H / 2);
  ctx.rotate(-0.42);
  ctx.translate(-W / 2, -H / 2);
  for (let i = -8; i < 14; i++) {
    const x = (i / 14) * W + (sweep * 0.2);
    const g = ctx.createLinearGradient(x, 0, x + W * 0.025, H);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.5, "rgba(255,255,255,0.10)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x, -H * 0.2, W * 0.025, H * 1.4);
  }
  ctx.restore();

  ctx.restore();
}

// -- WebM via captureStream --------------------------------------------------
async function exportSlabWebM() {
  const e = requireCurrent();
  if (typeof MediaRecorder === "undefined")
    throw new Error("WebM recording not supported in this browser");
  setLoading(true, "recording webm…");

  const W = 1000, H = Math.round(W * SLAB_H / SLAB_W);
  const FPS = 30, DURATION = 4000;
  const mimePref = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  const mime = mimePref.find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";

  if (use3D) {
    const prev = new THREE.Vector2(); renderer.getSize(prev);
    const prevPR = renderer.getPixelRatio();
    const prevRotY = slabMesh.rotation.y, prevRotX = slabMesh.rotation.x;
    try {
      stopAutoRotate();
      renderer.setPixelRatio(1);
      renderer.setSize(W, H, false);
      camera.aspect = W / H; camera.updateProjectionMatrix();
      scene.background = new THREE.Color(0x0a0a0a);
      slabMesh.rotation.y = 0;
      renderer.render(scene, camera);

      const stream = canvas.captureStream(FPS);
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
      const chunks = [];
      rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      const start = performance.now();
      let raf;
      function loop(now) {
        const elapsed = now - start;
        const t = (elapsed / DURATION) % 1;
        slabMesh.rotation.y = Math.sin(t * Math.PI * 2) * 0.35;
        slabMesh.rotation.x = Math.cos(t * Math.PI * 2) * 0.06;
        renderer.render(scene, camera);
        if (elapsed < DURATION) raf = requestAnimationFrame(loop);
        else { rec.stop(); cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); }
      }
      const done = new Promise((resolve) => (rec.onstop = resolve));
      rec.start();
      raf = requestAnimationFrame(loop);
      await done;
      const blob = new Blob(chunks, { type: mime });
      if (!blob.size) throw new Error("WebM produced no data");
      downloadBlob(blob, `doodle-slab-${e.id}.webm`);
      showToast("✿ slab WebM saved");
    } finally {
      scene.background = null;
      renderer.setPixelRatio(prevPR);
      renderer.setSize(prev.x, prev.y, false);
      camera.aspect = prev.x / prev.y; camera.updateProjectionMatrix();
      slabMesh.rotation.y = prevRotY;
      slabMesh.rotation.x = prevRotX;
      startAutoRotate();
    }
  } else {
    // 2D fallback
    const rec2D = document.createElement("canvas");
    rec2D.width = W; rec2D.height = H;
    render2DSlabFrame(rec2D, 0);
    const stream = rec2D.captureStream(FPS);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
    const chunks = [];
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    const start = performance.now();
    let raf;
    function loop(now) {
      const elapsed = now - start;
      const t = (elapsed / DURATION) % 1;
      render2DSlabFrame(rec2D, t);
      if (elapsed < DURATION) raf = requestAnimationFrame(loop);
      else { rec.stop(); cancelAnimationFrame(raf); stream.getTracks().forEach((tr) => tr.stop()); }
    }
    const done = new Promise((resolve) => (rec.onstop = resolve));
    rec.start();
    raf = requestAnimationFrame(loop);
    await done;
    const blob = new Blob(chunks, { type: mime });
    if (!blob.size) throw new Error("WebM produced no data");
    downloadBlob(blob, `doodle-slab-${e.id}.webm`);
    showToast("✿ slab WebM saved");
  }
}

// -- GLB: real 3D model of the entire slab ----------------------------------
async function exportSlabGLB() {
  const e = requireCurrent();
  setLoading(true, "building 3D slab…");

  // Even without WebGL preview we can still build a Three.js scene to export.
  const exporter = new GLTFExporter();
  const exportScene = new THREE.Scene();

  let mesh;
  if (use3D && slabMesh) {
    mesh = slabMesh.clone();
  } else {
    // Build the slab geometry+material+texture purely for export
    const geom = new RoundedBoxGeometry(SLAB_W, SLAB_H, SLAB_D, 6, 0.02);
    const tex = new THREE.CanvasTexture(slabTextureCanvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    const mat = new THREE.MeshPhysicalMaterial({
      map: tex,
      roughness: 0.32,
      metalness: 0.05,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
    });
    mesh = new THREE.Mesh(geom, mat);
  }
  mesh.rotation.set(0, 0, 0);
  mesh.name = `DoodleSlab_${e.id}`;
  exportScene.add(mesh);

  const buf = await new Promise((resolve, reject) => {
    try {
      exporter.parse(exportScene, resolve, reject, { binary: true, embedImages: true });
    } catch (err) { reject(err); }
  });
  if (!(buf instanceof ArrayBuffer)) throw new Error("GLB returned non-binary");
  downloadBlob(new Blob([buf], { type: "model/gltf-binary" }), `doodle-slab-${e.id}.glb`);
  showToast("✿ slab GLB saved");
}

// ============================================================================
// Load slab flow
// ============================================================================
async function loadSlab(rawId) {
  const id = String(rawId).trim();
  if (!/^\d+$/.test(id)) return showError("Token id must be a positive integer");
  const n = Number(id);
  if (n < 0 || n > DOODLES.maxId)
    return showError(`Doodles token ids go from 0 to ${DOODLES.maxId}`);

  showError("");
  setLoading(true, "fetching doodle…");
  setBusy(true);
  try {
    const entry = await fetchDoodle(id);
    current = entry;
    rerenderSlabTexture();
    showToast(`✿ Doodle #${id} loaded in ${entry.loadMs}ms`);
  } catch (e) {
    console.error(e);
    showError(e.message || "Could not load doodle");
  } finally {
    setLoading(false);
    setBusy(false);
  }
}

// ============================================================================
// Wire up UI
// ============================================================================
slabIt.addEventListener("click", () => loadSlab(tokenInput.value || "0"));
tokenInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && tokenInput.value.trim()) { e.preventDefault(); loadSlab(tokenInput.value); }
});
tokenInput.addEventListener("input", () => {
  const cleaned = tokenInput.value.replace(/[^0-9]/g, "").slice(0, 4);
  if (cleaned !== tokenInput.value) tokenInput.value = cleaned;
});
randomBtn.addEventListener("click", () => {
  const id = String(Math.floor(Math.random() * (DOODLES.maxId + 1)));
  tokenInput.value = id;
  loadSlab(id);
});

const exporters = {
  "card-png":  { fn: exportCardPNG,  label: "exporting card png…" },
  "slab-png":  { fn: exportSlabPNG,  label: "exporting slab png…" },
  "slab-gif":  { fn: exportSlabGIF,  label: "rendering gif…" },
  "slab-glb":  { fn: exportSlabGLB,  label: "building 3D model…" },
  "slab-webm": { fn: exportSlabWebM, label: "recording webm…" },
};
exportBtns.forEach((btn) => {
  btn.addEventListener("click", async () => {
    const ex = exporters[btn.dataset.export];
    if (!ex) return;
    showError("");
    try {
      setBusy(true);
      setLoading(true, ex.label);
      await ex.fn();
    } catch (err) {
      console.error(err);
      showError(err.message || "Export failed");
    } finally {
      setBusy(false);
      setLoading(false);
    }
  });
});

// ============================================================================
// Boot
// ============================================================================
(async function boot() {
  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  } catch {}

  // Ensure slab texture canvas exists (used by both 3D and 2D paths)
  if (!slabTextureCanvas) {
    slabTextureCanvas = document.createElement("canvas");
    slabTextureCanvas.width = TEX_W;
    slabTextureCanvas.height = TEX_H;
    drawSlabFront(slabTextureCanvas, null);
  }

  try {
    init3D();
    renderer.render(scene, camera);
  } catch (err) {
    console.warn("WebGL unavailable — falling back to 2D preview:", err.message || err);
    init2DFallback();
  }

  startAutoRotate();

  const id = String(Math.floor(Math.random() * (DOODLES.maxId + 1)));
  tokenInput.value = id;
  loadSlab(id);
})();
