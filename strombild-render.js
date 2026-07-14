/* =====================================================================
 * STROMBILD v0.1 — renderer + app shell (DOM layer over the core).
 *
 * Browser-only. Load AFTER strombild.js; this augments window.Strombild
 * with createApp(...). One renderer, mounted twice: by index.html (the dev
 * harness/validator) and by player.html (the lightweight iframe player).
 * The language semantics live in strombild.js; nothing here changes them.
 *
 *   Strombild.createApp({ canvas, editor, ...optional DOM elements })
 *     -> { load(src), rebuild(), setRunning(b), toggleRun(), step(dt),
 *          reset(), setPathway(name), setSpeed(x), model, engine }
 *
 * Only `canvas` and `editor` are required; every other element is optional
 * and simply skipped if absent (so the player can drop the report, stats,
 * pathway selector, etc.). Each call is an isolated instance with its own
 * engine + animation loop — many can run on one page (the glossary case).
 * ===================================================================== */
(function () {
"use strict";
const S = (typeof window !== "undefined") && window.Strombild;
if (!S) { if (typeof console !== "undefined") console.error("strombild-render.js: load strombild.js first"); return; }
const { parseModel, Engine, layout, influences, knifeEdge, splitChannels, splitTop } = S;

const FLASH_MS = 650;
const C = {
  paper: "#f7f2e6", paperDeep: "#efe7d3", ink: "#22304a", inkSoft: "rgba(34,48,74,0.55)",
  vermilion: "#c8451f", teal: "#1f7a6d", water: "#3d7fa6", gold: "#b98a1d",
};

function escapeHtml(s){ return s.replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

/* ---------------------------------------------------------------------
 * Stateless draw helpers (pure: ctx + args in, pixels out). The only
 * per-run state they need — the event-flash map and the threshold map —
 * is threaded in as arguments, not captured, so they stay reusable.
 * ------------------------------------------------------------------- */
function borderPoint(b, tx, ty) {
  const dx = tx - b.x, dy = ty - b.y;
  if (dx === 0 && dy === 0) return { x: b.x, y: b.y };
  const sx = dx !== 0 ? (b.w / 2) / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? (b.h / 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: b.x + dx * s, y: b.y + dy * s };
}

// stable seat positions for the 'dots' fill, cached per node name (deterministic,
// so sharing the cache across instances is harmless)
const seatCache = new Map();
function seats(name, count) {
  let arr = seatCache.get(name);
  if (arr && arr.length >= count) return arr;
  arr = [];
  let s = 1234567 ^ [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < Math.max(count, 60); i++) arr.push({ jx: rnd(), jy: rnd() });
  seatCache.set(name, arr);
  return arr;
}

function drawPail(ctx, b) {
  const topY = b.y - b.h / 2, botY = b.y + b.h / 2;
  const halfTop = b.w / 2, halfBot = b.w * 0.41;
  ctx.beginPath();
  ctx.moveTo(b.x - halfTop, topY);
  ctx.lineTo(b.x - halfBot, botY - 8);
  ctx.quadraticCurveTo(b.x - halfBot, botY, b.x - halfBot + 8, botY);
  ctx.lineTo(b.x + halfBot - 8, botY);
  ctx.quadraticCurveTo(b.x + halfBot, botY, b.x + halfBot, botY - 8);
  ctx.lineTo(b.x + halfTop, topY);
  return { topY, botY, halfTop, halfBot };
}

// a straight-sided crate (vertical-walled) — the factory/industrial container
function drawBox(ctx, b) {
  const topY = b.y - b.h / 2, botY = b.y + b.h / 2, half = b.w / 2, r = 6;
  const x = b.x - half, y = topY;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + b.w, y, x + b.w, y + b.h, r);
  ctx.arcTo(x + b.w, y + b.h, x, y + b.h, r);
  ctx.arcTo(x, y + b.h, x, y, r);
  ctx.arcTo(x, y, x + b.w, y, r);
  ctx.closePath();
  return { topY, botY, halfTop: half, halfBot: half };
}
// dispatch on the node's visual primitive; both return the same geometry shape
function drawContainer(ctx, b, shape) {
  return shape === "box" ? drawBox(ctx, b) : drawPail(ctx, b);
}

function drawNode(ctx, name, node, value, dmax, time, fill, threshold, shape, eventFlash, waveTime) {
  const b = node;
  const on = threshold != null && value > threshold;   // switch latched above the line

  // EVENT flash: a vermilion pulse when an event just fired on this node (the
  // truck leaving / the cell dividing). Decays over FLASH_MS.
  const flashAt = eventFlash.get(name);
  const flash = flashAt != null ? Math.max(0, 1 - (time - flashAt) / FLASH_MS) : 0;
  if (flash > 0) {
    ctx.save();
    drawContainer(ctx, b, shape);
    ctx.shadowColor = `rgba(200,69,31,${0.9 * flash})`; ctx.shadowBlur = 10 + 28 * flash;
    ctx.lineWidth = 3 + 5 * flash; ctx.strokeStyle = `rgba(200,69,31,${flash})`; ctx.stroke();
    ctx.restore();
  }

  // ON glow: an amber halo around the whole pail when latched on
  if (on) {
    ctx.save();
    drawContainer(ctx, b, shape);
    ctx.shadowColor = "rgba(185,138,29,0.9)"; ctx.shadowBlur = 16;
    ctx.lineWidth = 4; ctx.strokeStyle = C.gold; ctx.stroke();
    ctx.restore();
  }

  const g = drawContainer(ctx, b, shape);
  // shell
  ctx.fillStyle = "#fbf8ef";
  ctx.fill();
  ctx.lineWidth = 2.5; ctx.strokeStyle = on ? C.gold : C.ink; ctx.stroke();

  const frac = dmax > 0 ? Math.max(0, Math.min(1, value / dmax)) : 0;
  const innerTop = g.topY + 6, innerBot = g.botY - 4;
  const surfaceY = innerBot - frac * (innerBot - innerTop);
  const widthAt = y => {
    const tt = (g.botY - y) / b.h; // 0 at bottom .. 1 at top
    return g.halfBot + (g.halfTop - g.halfBot) * Math.max(0, Math.min(1, tt + 0.04));
  };

  ctx.save();
  drawContainer(ctx, b, shape); ctx.clip();

  if (fill === "squares") {
    // stacked square units in a neat grid, sized so capacity just fills the box
    const count = Math.round(value);
    const usableW = Math.min(g.halfTop, g.halfBot) * 2 - 10;
    const cols = Math.max(1, Math.min(6, Math.round(usableW / 14)));
    const rowsCap = Math.max(1, Math.ceil(dmax / cols));
    const cellW = usableW / cols;
    const cellH = (innerBot - innerTop) / rowsCap;
    const size = Math.max(3, Math.min(cellW, cellH) - 3);
    for (let i = 0; i < count; i++) {
      const cx = b.x - usableW / 2 + (i % cols + 0.5) * cellW;
      const cy = innerBot - (Math.floor(i / cols) + 0.5) * cellH;
      ctx.fillStyle = C.teal;
      ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
      ctx.lineWidth = 1; ctx.strokeStyle = "rgba(247,242,230,0.55)";
      ctx.strokeRect(cx - size / 2, cy - size / 2, size, size);
    }
  } else if (fill === "dots") {
    const count = Math.round(value);
    const st = seats(name, count);
    for (let i = 0; i < count; i++) {
      // pile bottom-up: row index from how many fit per band
      const ny = innerBot - ((i + 0.5) / Math.max(count, 1)) * frac * (innerBot - innerTop);
      const wHere = widthAt(ny) - 6;
      const jitter = st[i] || { jx: 0.5, jy: 0.5 };
      const dx = (jitter.jx - 0.5) * 2 * wHere;
      const dy = (jitter.jy - 0.5) * 3;
      ctx.beginPath();
      ctx.arc(b.x + dx, ny + dy, 3.1, 0, Math.PI * 2);
      ctx.fillStyle = C.vermilion; ctx.fill();
    }
  } else if (frac > 0.001) {
    // water body with a wavy surface
    ctx.beginPath();
    ctx.moveTo(b.x - g.halfBot, innerBot + 4);
    for (let x = b.x - g.halfTop; x <= b.x + g.halfTop; x += 4) {
      const y = surfaceY + Math.sin(x * 0.10 + waveTime / 240) * 1.4 + Math.sin(x * 0.05 - waveTime / 360) * 0.8;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(b.x + g.halfBot, innerBot + 4);
    ctx.closePath();
    ctx.fillStyle = "rgba(61,127,166,0.80)"; ctx.fill();
    // surface highlight
    ctx.beginPath();
    for (let x = b.x - g.halfTop, first = true; x <= b.x + g.halfTop; x += 4, first = false) {
      const y = surfaceY + Math.sin(x * 0.10 + waveTime / 240) * 1.4 + Math.sin(x * 0.05 - waveTime / 360) * 0.8;
      first ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.lineWidth = 2; ctx.strokeStyle = "rgba(247,242,230,0.5)"; ctx.stroke();
  }
  ctx.restore();

  // capacity tick + brim flash when clamped at the top
  if (node && value >= dmax - 1e-3 && frac >= 0.999) {
    ctx.strokeStyle = C.vermilion; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(b.x - g.halfTop, innerTop); ctx.lineTo(b.x + g.halfTop, innerTop); ctx.stroke();
  }

  // threshold line (the computed switch point) + ON/OFF readout
  if (threshold != null && dmax > 0) {
    const tFrac = Math.max(0, Math.min(1, threshold / dmax));
    const ty = innerBot - tFrac * (innerBot - innerTop);
    const half = g.halfBot + (g.halfTop - g.halfBot) * tFrac;
    ctx.save();
    ctx.setLineDash([5, 4]); ctx.lineWidth = 2; ctx.strokeStyle = C.gold;
    ctx.beginPath(); ctx.moveTo(b.x - half - 4, ty); ctx.lineTo(b.x + half + 4, ty); ctx.stroke();
    ctx.restore();
    ctx.font = "italic 9px 'Fraunces', serif";
    ctx.fillStyle = C.gold; ctx.textAlign = "left";
    ctx.fillText("switch " + threshold.toFixed(0), b.x + half + 7, ty + 3);
    // ON/OFF pill
    ctx.textAlign = "center";
    ctx.font = "600 9px 'IBM Plex Mono', monospace";
    ctx.fillStyle = on ? C.gold : "rgba(34,48,74,0.4)";
    ctx.fillText(on ? "● ON" : "○ OFF", b.x, g.topY - 22);
  }

  // label + value
  ctx.fillStyle = C.ink;
  ctx.font = "500 12px 'IBM Plex Mono', monospace";
  ctx.textAlign = "center";
  ctx.fillText(name, b.x, g.topY - 9);
  const isCount = fill === "dots" || fill === "squares";
  ctx.font = "600 15px 'Fraunces', serif";
  ctx.fillStyle = fill === "dots" ? C.vermilion : fill === "squares" ? C.teal : C.water;
  ctx.fillText(isCount ? String(Math.round(value)) : value.toFixed(1), b.x, b.y + 6);
}

function drawExternal(ctx, name, ext, role) {
  const b = ext;
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 2; ctx.strokeStyle = C.inkSoft;
  ctx.fillStyle = "rgba(34,48,74,0.05)";
  const x = b.x - b.w / 2, y = b.y - b.h / 2, r = 8;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + b.w, y, x + b.w, y + b.h, r);
  ctx.arcTo(x + b.w, y + b.h, x, y + b.h, r);
  ctx.arcTo(x, y + b.h, x, y, r);
  ctx.arcTo(x, y, x + b.w, y, r);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.restore();

  ctx.fillStyle = C.inkSoft;
  ctx.textAlign = "center";
  ctx.font = "500 11px 'IBM Plex Mono', monospace";
  ctx.fillText(name, b.x, b.y + 1);
  ctx.font = "9px 'IBM Plex Mono', monospace";
  ctx.fillText(role === "source" ? "▸ source" : role === "sink" ? "sink ▸" : "source/sink", b.x, b.y + 13);
}

function drawPipe(ctx, p0, p1, flow, time, active, moving) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const tip = { x: p1.x - ux * 9, y: p1.y - uy * 9 }; // leave room for arrowhead
  const thick = Math.max(1.5, Math.min(13, Math.abs(flow) * 1.3 + 1.2));
  const col = active ? C.water : "rgba(34,48,74,0.30)";

  // pipe body
  ctx.lineCap = "round";
  ctx.strokeStyle = active ? "rgba(61,127,166,0.32)" : "rgba(34,48,74,0.12)";
  ctx.lineWidth = thick;
  ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();

  // animated flow dashes
  if (active && Math.abs(flow) > 0.001) {
    ctx.save();
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1.2, thick * 0.45);
    ctx.setLineDash([2, 10]);
    // freeze the dashes when the sim is paused — a stopped clock shows no flow
    ctx.lineDashOffset = moving ? -(time / 32) * Math.sign(flow || 1) : 0;
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
    ctx.restore();
  }
  ctx.setLineDash([]);

  // arrowhead
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p1.x - ux * 11 - uy * 5, p1.y - uy * 11 + ux * 5);
  ctx.lineTo(p1.x - ux * 11 + uy * 5, p1.y - uy * 11 - ux * 5);
  ctx.closePath(); ctx.fill();

  // flow label at midpoint, with a paper halo
  const mx = (p0.x + tip.x) / 2, my = (p0.y + tip.y) / 2;
  const label = (flow >= 0 ? "" : "−") + Math.abs(flow).toFixed(2);
  ctx.font = "10px 'IBM Plex Mono', monospace";
  ctx.textAlign = "center";
  ctx.lineWidth = 3.5; ctx.strokeStyle = "rgba(251,248,239,0.95)";
  ctx.strokeText(label, mx, my - 6 - thick / 2);
  ctx.fillStyle = active ? C.ink : C.inkSoft;
  ctx.fillText(label, mx, my - 6 - thick / 2);
}

// a rotor: a flux drawn as a spinning wheel. Its RPM tracks the live rate (the
// angle integrates the flow), so a faster flux visibly spins faster — the
// ATP-synthase reading. Strip the `@ rotor` and the same flow draws as a pipe.
const rotorPhase = new Map(); // spin id -> { angle, lastT }  (persistent spin state)
// integrate the flow into an angle so spin speed == rate
function advanceSpin(id, flow, time, moving) {
  let st = rotorPhase.get(id);
  if (!st) { st = { angle: 0, lastT: time }; rotorPhase.set(id, st); }
  const dt = Math.min(80, Math.max(0, time - st.lastT)); st.lastT = time;
  // only turn the wheel while the sim is actually running; a paused motor holds still
  if (moving) st.angle += flow * dt * 0.0017;
  return st.angle;
}
// the wheel itself, centered at (cx,cy): rim teeth + face + spokes + a vermilion
// marker spoke (so the rotation is unmistakable) + hub.
function spinWheel(ctx, cx, cy, R, ang, active) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = active ? "rgba(61,127,166,0.55)" : "rgba(34,48,74,0.25)";
  ctx.lineWidth = 2;
  const N = 8;
  for (let i = 0; i < N; i++) {
    const a = ang + (i / N) * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
    ctx.beginPath(); ctx.moveTo(dx * R, dy * R); ctx.lineTo(dx * (R + 4), dy * (R + 4)); ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(251,248,239,0.95)"; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = active ? C.water : "rgba(34,48,74,0.3)"; ctx.stroke();
  ctx.lineWidth = 2; ctx.strokeStyle = active ? "rgba(34,48,74,0.4)" : "rgba(34,48,74,0.18)";
  for (let i = 1; i < 3; i++) {
    const a = ang + (i / 3) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R); ctx.stroke();
  }
  ctx.lineWidth = 2.5; ctx.strokeStyle = active ? C.vermilion : "rgba(200,69,31,0.4)";
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(ang) * R, Math.sin(ang) * R); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, 2.5, 0, Math.PI * 2); ctx.fillStyle = C.ink; ctx.fill();
  ctx.restore();
}
// a filled arrowhead at point p, pointing along (ux,uy)
function arrowhead(ctx, p, ux, uy, col) {
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x - ux * 11 - uy * 5, p.y - uy * 11 + ux * 5);
  ctx.lineTo(p.x - ux * 11 + uy * 5, p.y - uy * 11 - ux * 5);
  ctx.closePath(); ctx.fill();
}
function rotorLabel(ctx, text, cx, cy, R, active) {
  ctx.font = "10px 'IBM Plex Mono', monospace";
  ctx.textAlign = "center";
  ctx.lineWidth = 3.5; ctx.strokeStyle = "rgba(251,248,239,0.95)";
  ctx.strokeText(text, cx, cy - R - 8);
  ctx.fillStyle = active ? C.ink : C.inkSoft;
  ctx.fillText(text, cx, cy - R - 8);
}
// flux on a single edge: a wheel at the midpoint, the drive shaft running src->dest
function drawRotor(ctx, id, p0, p1, flow, time, active, moving) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
  const R = 15;
  const col = active ? C.water : "rgba(34,48,74,0.30)";
  const ang = advanceSpin(id, flow, time, moving);

  ctx.lineCap = "round";
  ctx.strokeStyle = active ? "rgba(61,127,166,0.32)" : "rgba(34,48,74,0.12)";
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(mx - ux * R, my - uy * R); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(mx + ux * R, my + uy * R); ctx.lineTo(p1.x - ux * 9, p1.y - uy * 9); ctx.stroke();

  spinWheel(ctx, mx, my, R, ang, active);
  arrowhead(ctx, p1, ux, uy, col);
  rotorLabel(ctx, (flow >= 0 ? "" : "−") + Math.abs(flow).toFixed(2), mx, my, R, active);
}
// a reaction drawn as a rotor: a MOTOR HUB. Every input shaft fans into the
// wheel, every output shaft leaves it. The wheel spins at the shared reaction
// rate — so a two-substrate reaction (protons + ADP -> ATP) reads as one motor
// that stalls the instant either feed runs dry.
function drawReactionRotor(ctx, id, inPos, outPos, rate, time, active, moving) {
  const all = [...inPos, ...outPos];
  const hub = { x: all.reduce((s, n) => s + n.x, 0) / all.length,
                y: all.reduce((s, n) => s + n.y, 0) / all.length };
  const R = 16;
  const col = active ? C.water : "rgba(34,48,74,0.30)";
  const ang = advanceSpin(id, rate, time, moving);
  ctx.lineCap = "round";
  ctx.strokeStyle = active ? "rgba(61,127,166,0.32)" : "rgba(34,48,74,0.12)";
  ctx.lineWidth = 3;

  for (const n of inPos) {                          // feeds: node border -> wheel rim
    const a = borderPoint(n, hub.x, hub.y);
    const dx = hub.x - a.x, dy = hub.y - a.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(hub.x - ux * R, hub.y - uy * R); ctx.stroke();
  }
  for (const n of outPos) {                         // products: wheel rim -> node border
    const b = borderPoint(n, hub.x, hub.y);
    const dx = b.x - hub.x, dy = b.y - hub.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    ctx.strokeStyle = active ? "rgba(61,127,166,0.32)" : "rgba(34,48,74,0.12)";
    ctx.beginPath(); ctx.moveTo(hub.x + ux * R, hub.y + uy * R); ctx.lineTo(b.x - ux * 9, b.y - uy * 9); ctx.stroke();
    arrowhead(ctx, b, ux, uy, col);
  }
  spinWheel(ctx, hub.x, hub.y, R, ang, active);
  rotorLabel(ctx, Math.abs(rate).toFixed(2), hub.x, hub.y, R, active);
}

// a dashed influence arrow: information/causation, not mass. read = muted ink,
// write = vermilion (an event acting). No flow animation — that's the contrast
// with a pipe (solid + animated = stuff moving).
function drawInfluence(ctx, p0, p1, kind) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const col = kind === "write" ? "rgba(200,69,31,0.75)" : "rgba(34,48,74,0.5)";
  ctx.save();
  ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = col; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x - ux * 7, p1.y - uy * 7); ctx.stroke();
  ctx.restore();
  // small open arrowhead
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p1.x - ux * 8 - uy * 4, p1.y - uy * 8 + ux * 4);
  ctx.lineTo(p1.x - ux * 8 + uy * 4, p1.y - uy * 8 - ux * 4);
  ctx.closePath(); ctx.fill();
}

// an event: a small diamond (a discrete transition), labelled with its guard.
function drawEventGlyph(ctx, g, ev, time, eventFlash) {
  const r = g.w / 2;
  const flashAt = eventFlash.get("event:" + ev.name);
  const flash = flashAt != null ? Math.max(0, 1 - (time - flashAt) / FLASH_MS) : 0;
  ctx.save();
  ctx.translate(g.x, g.y); ctx.rotate(Math.PI / 4);   // square -> diamond
  if (flash > 0) { ctx.shadowColor = `rgba(200,69,31,${0.9 * flash})`; ctx.shadowBlur = 8 + 22 * flash; }
  ctx.fillStyle = flash > 0 ? `rgba(200,69,31,${0.25 + 0.6 * flash})` : "rgba(247,242,230,0.95)";
  ctx.strokeStyle = C.vermilion; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.rect(-r, -r, g.w, g.w); ctx.fill(); ctx.stroke();
  ctx.restore();
  // label: name above, guard below
  ctx.textAlign = "center";
  ctx.font = "italic 10px 'Fraunces', serif"; ctx.fillStyle = C.vermilion;
  ctx.fillText(ev.name, g.x, g.y - r - 5);
  ctx.font = "9px 'IBM Plex Mono', monospace"; ctx.fillStyle = C.inkSoft;
  ctx.fillText(ev.guard.map(c => `${c.node} ${c.op} ${c.rhs}`).join(" & "), g.x, g.y + r + 11);
}

// the water-surface wave rides on wall-clock time; hold its phase while the sim
// is paused so a stopped clock shows a still surface. render() advances it only
// while running, so a paused frame reuses the last live phase (no snap/jump).
let waveClock = 0;

// an unmistakable "the sim is paused" badge. With every animation now frozen, a
// still canvas must not read as running-but-idle — this says which it is.
function drawPausedBadge(ctx, W, H) {
  const label = "❚❚ paused";
  ctx.save();
  ctx.font = "600 11px 'IBM Plex Mono', monospace";
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const tw = ctx.measureText(label).width;
  const padX = 11, h = 23, w = tw + padX * 2;
  const x = W - w - 12, y = 12, r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = "rgba(185,138,29,0.15)"; ctx.fill();      // amber wash
  ctx.lineWidth = 1.5; ctx.strokeStyle = C.gold; ctx.stroke();
  ctx.fillStyle = C.ink;
  ctx.fillText(label, x + padX, y + h / 2 + 0.5);
  ctx.restore();
}

function render(ctx, model, engine, pos, W, H, time, thresholds, eventFlash, running) {
  if (running) waveClock = time;   // freeze the surface phase while paused
  ctx.clearRect(0, 0, W, H);
  const active = new Set(engine.activeEdges().map(e => e.id));

  // edges first (under the nodes)
  for (const e of model.edges) {
    const a = pos.get(e.src), b = pos.get(e.dest);
    if (!a || !b) continue;
    const p0 = borderPoint(a, b.x, b.y);
    const p1 = borderPoint(b, a.x, a.y);
    const isOn = active.has(e.id);
    const flow = isOn ? (engine.lastFlows.get(e.id) || 0) : 0;
    const moving = isOn && running;
    if (e.visual === "rotor") drawRotor(ctx, e.id, p0, p1, flow, time, isOn, moving);
    else drawPipe(ctx, p0, p1, flow, time, isOn, moving);
  }
  // reaction arcs: one shared rate, drawn as an input->output pipe per pair
  const activeRx = new Set(engine.activeReactions().map(r => r.name));
  for (const [rname, p] of model.pathways) {
    if (p.kind !== "reaction") continue;
    const on = activeRx.has(rname);
    const rate = on ? (engine.lastReactionRates.get(rname) || 0) : 0;
    const moving = on && running;
    if (p.visual === "rotor") {
      const inPos = p.inputs.map(i => pos.get(i.node)).filter(Boolean);
      const outPos = p.outputs.map(o => pos.get(o.node)).filter(Boolean);
      if (inPos.length && outPos.length) drawReactionRotor(ctx, "rx:" + rname, inPos, outPos, rate, time, on, moving);
      continue;
    }
    for (const inp of p.inputs) for (const out of p.outputs) {
      const a = pos.get(inp.node), b = pos.get(out.node);
      if (!a || !b) continue;
      drawPipe(ctx, borderPoint(a, b.x, b.y), borderPoint(b, a.x, a.y), rate, time, on, moving);
    }
  }
  // influence arrows: the couplings that aren't flows (a rate law's `of` read,
  // an event's guard read and action writes). Dashed; drawn under the nodes.
  for (const inf of influences(model)) {
    const fromPos = inf.kind === "write" ? pos.get("event:" + inf.from.event) : pos.get(inf.from);
    if (!fromPos) continue;
    let target;
    if (inf.kind === "write") target = pos.get(inf.to);
    else if (inf.to.event) target = pos.get("event:" + inf.to.event);
    else if (inf.to.edge) {                              // read controlling a flow: aim at the pipe midpoint
      const e = model.edges.find(x => x.id === inf.to.edge);
      const a = e && pos.get(e.src), b = e && pos.get(e.dest);
      if (a && b) target = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    if (!target) continue;
    const p0 = borderPoint(fromPos, target.x, target.y);
    const p1 = target.w ? borderPoint(target, fromPos.x, fromPos.y) : target;
    drawInfluence(ctx, p0, p1, inf.kind);
  }

  // nodes, externals, event glyphs
  for (const [name, p] of pos) {
    if (p.kind === "node") {
      const node = model.nodes.get(name);
      drawNode(ctx, name, p, engine.state.get(name) || 0, engine.displayMax(name), time, node.fill, thresholds.get(name), node.visual, eventFlash, waveClock);
    } else if (p.kind === "event") {
      const ev = model.events.find(e => e.name === p.name);
      if (ev) drawEventGlyph(ctx, p, ev, time, eventFlash);
    } else {
      drawExternal(ctx, name, p, model.externals.get(name)?.role);
    }
  }

  // paused overlay — drawn last so it sits above everything
  if (!running) drawPausedBadge(ctx, W, H);
}

/* ---------------------------------------------------------------------
 * APP INSTANCE — owns the model/engine/state and the animation loop for
 * one canvas. DOM elements come in via `opts`; missing ones are skipped.
 * ------------------------------------------------------------------- */
function createApp(opts) {
  const canvas = opts.canvas, editor = opts.editor;
  if (!canvas || !editor) throw new Error("Strombild.createApp needs at least { canvas, editor }");
  const reportEl   = opts.report   || null;
  const statsEl    = opts.stats    || null;
  const runBtn     = opts.runBtn   || null;
  const stepBtn    = opts.stepBtn  || null;
  const resetBtn   = opts.resetBtn || null;
  const pathwaySel = opts.pathwaySel || null;
  const speedIn    = opts.speed    || null;
  const speedOut   = opts.speedOut || null;
  const DEFAULT_SPEED = opts.defaultSpeed || 5;
  const ctx = canvas.getContext("2d");

  let model = null, engine = null, pos = new Map();
  let thresholds = new Map();   // node -> drawn switch level (computed or hand-set)
  let eventFlash = new Map();   // node name -> timestamp of the last event that touched it
  let seenFires  = new Map();   // event name -> fire count already reflected in the flashes
  let running = false, valid = false;
  let W = 0, H = 0, lastTime = 0, statsAccum = 0;

  const currentSpeed = () => speedIn ? parseFloat(speedIn.value) : DEFAULT_SPEED;

  // resolve each node's threshold visual: 'auto' -> the computed knife-edge for
  // the active pathway; a number -> itself. Recomputed when model/pathway change.
  function computeThresholds() {
    thresholds = new Map();
    if (!model || !engine) return;
    for (const [name, node] of model.nodes) {
      if (node.threshold == null) continue;
      const t = node.threshold === "auto" ? knifeEdge(model, name, engine.pathway) : node.threshold;
      if (t != null) thresholds.set(name, t);
    }
  }

  function fit() {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = r.width * dpr; canvas.height = r.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    W = r.width; H = r.height;
    if (model) pos = layout(model, W, H);
  }

  // --- validator report (skipped if no element) -----------------------
  function renderReport(res) {
    if (!reportEl) return;
    const rows = [];
    if (res.errors.length === 0) {
      const m = res.model;
      rows.push(`<div class="row ok"><span class="tag">parsed</span><span>${
        m.nodes.size} node${m.nodes.size!==1?"s":""}, ${
        m.externals.size} external${m.externals.size!==1?"s":""}, ${
        m.edges.length} edge${m.edges.length!==1?"s":""}, ${
        m.pathways.size} pathway${m.pathways.size!==1?"s":""}</span></div>`);
    }
    for (const e of res.errors)
      rows.push(`<div class="row err"><span class="tag">error</span><span>${
        e.line?`<span class="ln">L${e.line}</span> `:""}${escapeHtml(e.msg)}</span></div>`);
    for (const w of res.warnings)
      rows.push(`<div class="row warn"><span class="tag">warn</span><span>${
        w.line?`<span class="ln">L${w.line}</span> `:""}${escapeHtml(w.msg)}</span></div>`);
    reportEl.innerHTML = rows.join("") || `<div class="row ok"><span class="tag">empty</span><span>nothing to parse yet</span></div>`;
  }

  // --- (re)build the model from the editor -----------------------------
  function rebuild(preservePathway) {
    const res = parseModel(editor.value);
    renderReport(res);
    valid = res.errors.length === 0 && res.model.edges.length > 0;

    const prevPathway = (preservePathway && pathwaySel) ? pathwaySel.value : null;
    model = res.model;
    engine = valid ? new Engine(model) : null;
    eventFlash = new Map();
    seenFires = new Map();

    // pick the active pathway: keep the previous if it still exists; else a lone
    // pathway IS the model so select it; with several, "all edges" tells more.
    let chosen = "";
    if (prevPathway && model.pathways.has(prevPathway)) chosen = prevPathway;
    else if (model.pathways.size === 1) chosen = [...model.pathways.keys()][0];

    if (pathwaySel) {
      pathwaySel.innerHTML = "";
      pathwaySel.add(new Option("all edges", ""));
      for (const name of model.pathways.keys()) pathwaySel.add(new Option(name, name));
      pathwaySel.value = chosen;
    }
    if (engine) engine.setPathway(chosen);

    if (valid) { fit(); engine.derivatives(); computeThresholds(); }
    setRunning(false);
    updateButtons();
    canvas.classList.toggle("seedable", valid);
  }

  function updateButtons() {
    if (runBtn)   runBtn.disabled = !valid;
    if (stepBtn)  stepBtn.disabled = !valid;
    if (resetBtn) resetBtn.disabled = !valid;
    if (pathwaySel) pathwaySel.disabled = !model || model.pathways.size === 0;
  }

  function setRunning(on) {
    running = on && valid;
    if (runBtn) {
      runBtn.textContent = running ? "❚❚ Pause" : "▶ Run";
      runBtn.classList.toggle("primary", !running);
    }
  }

  // --- stats panel (skipped if no element) -----------------------------
  function renderStats() {
    if (!statsEl) return;
    if (!engine) { statsEl.innerHTML = ""; return; }
    const rows = [`<div class="clock"><span>t = ${engine.t.toFixed(2)}</span><span>${
      running ? "running" : "paused"}${engine.pathway ? " · " + engine.pathway : ""}</span></div>`];
    rows.push(`<div class="group-title">stocks (value · d/dt)</div>`);
    for (const name of model.nodes.keys()) {
      const v = engine.state.get(name) || 0;
      const d = engine.lastNet.get(name) || 0;
      const cls = d > 1e-3 ? "pos" : d < -1e-3 ? "neg" : "";
      rows.push(`<div class="stat"><span class="k">${escapeHtml(name)}</span><span class="v">${
        v.toFixed(2)} <span class="${cls}">${d>=0?"+":""}${d.toFixed(2)}</span></span></div>`);
    }
    rows.push(`<div class="group-title">flows</div>`);
    const act = new Set(engine.activeEdges().map(e => e.id));
    for (const e of model.edges) {
      const on = act.has(e.id);
      const f = on ? (engine.lastFlows.get(e.id) || 0) : 0;
      rows.push(`<div class="stat"><span class="k" style="${on?"":"opacity:.4"}">${
        escapeHtml(e.src)}→${escapeHtml(e.dest)}</span><span class="v" style="${on?"":"opacity:.4"}">${
        f.toFixed(2)}</span></div>`);
    }
    const actRx = new Set(engine.activeReactions().map(r => r.name));
    for (const [rname, p] of model.pathways) {
      if (p.kind !== "reaction") continue;
      const on = actRx.has(rname);
      const r = on ? (engine.lastReactionRates.get(rname) || 0) : 0;
      const eq = p.inputs.map(t => (t.coeff !== 1 ? t.coeff + " " : "") + t.node).join("+")
        + "→" + p.outputs.map(t => (t.coeff !== 1 ? t.coeff + " " : "") + t.node).join("+");
      rows.push(`<div class="stat"><span class="k" style="${on?"":"opacity:.4"}">${
        escapeHtml(rname)}: ${escapeHtml(eq)}</span><span class="v" style="${on?"":"opacity:.4"}">${
        r.toFixed(2)}</span></div>`);
    }
    if (model.events.length) {
      rows.push(`<div class="group-title">events (fires)</div>`);
      for (const ev of model.events) {
        const fires = engine.eventFires.get(ev.name) || 0;
        const armed = engine.guardTrue(ev);   // guard currently satisfied?
        const guardLabel = ev.guard.map(c => `${c.node} ${c.op} ${c.rhs}`).join(" & ");
        rows.push(`<div class="stat"><span class="k" style="${armed?"":"opacity:.6"}">${
          escapeHtml(ev.name)}: ${escapeHtml(guardLabel)
          }</span><span class="v">×${fires}</span></div>`);
      }
    }
    statsEl.innerHTML = rows.join("");
  }

  // note which nodes an event just touched, so render() can flash them. uses the
  // engine's cumulative fire count so no fire is missed between frames (an advance
  // can run many substeps, firing several times).
  function pumpEventFlashes(time) {
    if (!engine || !model.events.length) return;
    for (const ev of model.events) {
      const n = engine.eventFires.get(ev.name) || 0;
      if (n > (seenFires.get(ev.name) || 0)) {
        seenFires.set(ev.name, n);
        eventFlash.set("event:" + ev.name, time);
        for (const c of ev.guard) eventFlash.set(c.node, time);
        for (const a of ev.actions) eventFlash.set(a.node, time);
      }
    }
  }

  // --- main loop --------------------------------------------------------
  function frame(time) {
    if (!lastTime) lastTime = time;
    const real = Math.min((time - lastTime) / 1000, 0.1);
    lastTime = time;

    if (engine) {
      if (running) engine.advance(real * currentSpeed());
      else engine.derivatives(); // keep flows/net fresh for the readouts
      pumpEventFlashes(time);
      render(ctx, model, engine, pos, W, H, time, thresholds, eventFlash, running);
      statsAccum += real;
      if (statsAccum > 0.1) { renderStats(); statsAccum = 0; }
    } else {
      ctx.clearRect(0, 0, W, H);
    }
    requestAnimationFrame(frame);
  }

  // --- seeding: drag a bucket to set its level --------------------------
  let seeding = null;
  function nodeAt(px, py) {
    for (const [name, p] of pos) {
      if (p.kind !== "node") continue;
      if (Math.abs(px - p.x) <= p.w / 2 + 6 && Math.abs(py - p.y) <= p.h / 2 + 6) return { name, p };
    }
    return null;
  }
  function seedFromPointer(hit, py) {
    const top = hit.p.y - hit.p.h / 2 + 6, bot = hit.p.y + hit.p.h / 2 - 4;
    const frac = Math.max(0, Math.min(1, (bot - py) / (bot - top)));
    engine.state.set(hit.name, frac * engine.displayMax(hit.name));
    engine.derivatives();
  }
  canvas.addEventListener("pointerdown", e => {
    if (!engine) return;
    const r = canvas.getBoundingClientRect();
    const hit = nodeAt(e.clientX - r.left, e.clientY - r.top);
    if (hit) { seeding = hit; seedFromPointer(hit, e.clientY - r.top); canvas.setPointerCapture(e.pointerId); }
  });
  canvas.addEventListener("pointermove", e => {
    if (!seeding) return;
    const r = canvas.getBoundingClientRect();
    seedFromPointer(seeding, e.clientY - r.top);
  });
  canvas.addEventListener("pointerup", () => {
    if (seeding) writeInitToSource(seeding.name, engine.state.get(seeding.name));
    seeding = null;
  });

  // Make the dragged level durable: write/replace an init(...) clause on the
  // node's line so the source stays the complete record of the run.
  function writeInitToSource(name, value) {
    const node = model.nodes.get(name);
    if (!node) return;
    const v = node.fill === "dots" ? Math.round(value) : Math.round(value * 10) / 10;
    const lines = editor.value.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const hash = lines[i].indexOf("#");
      const code = hash >= 0 ? lines[i].slice(0, hash) : lines[i];
      const comment = hash >= 0 ? lines[i].slice(hash) : "";
      const { head, channels } = splitChannels(code);
      if (!/^node\b/.test(head) || head.replace(/^node\s+/, "").trim() !== name) continue;

      let clauses = channels[":"] ? splitTop(channels[":"], ",").map(s => s.trim()).filter(Boolean) : [];
      clauses = clauses.filter(c => !/^init\b/.test(c));
      clauses.push(`init(${v})`);
      let rebuilt = `node ${name} : ${clauses.join(", ")}`;
      if (channels["@"] != null) rebuilt += ` @ ${channels["@"]}`;
      if (comment) rebuilt += "  " + comment;
      lines[i] = rebuilt;
      editor.value = lines.join("\n");
      node.init = v;            // keep live model in sync; reset() restores this
      return;
    }
  }

  // --- wiring (guard every optional element) ----------------------------
  let debounce = null;
  editor.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => rebuild(true), 250);
  });
  if (runBtn)   runBtn.addEventListener("click", () => setRunning(!running));
  if (stepBtn)  stepBtn.addEventListener("click", () => { if (engine) { setRunning(false); engine.advance(0.2); renderStats(); } });
  if (resetBtn) resetBtn.addEventListener("click", () => doReset());
  if (pathwaySel) pathwaySel.addEventListener("change", () => { if (engine) { engine.setPathway(pathwaySel.value); engine.derivatives(); computeThresholds(); } });
  if (speedIn)  speedIn.addEventListener("input", () => { if (speedOut) speedOut.textContent = parseFloat(speedIn.value).toFixed(speedIn.value % 1 ? 1 : 0) + "×"; });
  window.addEventListener("resize", fit);

  function doReset() {
    if (!engine) return;
    engine.reset(); engine.derivatives();
    eventFlash = new Map(); seenFires = new Map();
    setRunning(false); renderStats();
  }

  // --- public API + boot ------------------------------------------------
  function load(src) {
    if (src != null) editor.value = src;
    rebuild(false);
    if (opts.autoplay) setRunning(true);
  }

  fit();
  if (opts.source != null) load(opts.source);
  else rebuild(false);
  requestAnimationFrame(frame);

  return {
    load, rebuild,
    setRunning, toggleRun: () => setRunning(!running),
    step: (dt = 0.2) => { setRunning(false); if (engine) { engine.advance(dt); renderStats(); } },
    reset: doReset,
    setPathway: (name) => { if (pathwaySel) pathwaySel.value = name; if (engine) { engine.setPathway(name); engine.derivatives(); computeThresholds(); } },
    setSpeed: (x) => { if (speedIn) { speedIn.value = x; speedIn.dispatchEvent(new Event("input")); } },
    get model() { return model; },
    get engine() { return engine; },
  };
}

S.createApp = createApp;
S.render = render;   // exported for anyone wanting to draw a frame directly
})();
