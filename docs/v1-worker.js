/* =============================================================
   SST EXPLORER · versión clásica · Worker
   -------------------------------------------------------------
   Trabajo pesado fuera del hilo principal:
   - "decode":  descarga un PNG y lo convierte a escala de grises
                (Uint8Array, 0 = sin dato).
   - "stream":  construye el campo de viento del fotograma y
                calcula las streamlines (RK4 + control de
                densidad), devolviendo segmentos y flechas listos
                para dibujar.
   ============================================================= */

const WIND_BASE = 'data/wind/';

// Parámetros idénticos a la versión original.
const STREAM_CELL_SIZE = 3.5;
const STREAM_BUFFER_CELLS = 0;
const STREAM_STEP = 0.5;
const STREAM_MAX_STEPS = 600;
const SEED_COLUMNS = 25;
const SEED_ROWS = 18;
const ARROW_SIZE = 3.5;
const ARROW_OPENING = Math.PI / 6;

// ------------------------------------------------------------
// MENSAJES
// ------------------------------------------------------------

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'decode') {
      const r = await decodePNG(msg.url);
      self.postMessage({ id: msg.id, ...r }, [r.data.buffer]);
    } else if (msg.type === 'stream') {
      const r = await computeStreamlines(msg);
      const bitmap = rasterize(r, msg.style);
      if (bitmap) {
        // Imagen lista: el hilo principal solo hace drawImage.
        self.postMessage({ id: msg.id, width: r.width, height: r.height, bitmap }, [bitmap]);
      } else {
        const transfer = [];
        r.runs.forEach((c) => transfer.push(c.coords.buffer, c.lens.buffer));
        transfer.push(r.arrows.buffer);
        self.postMessage({ id: msg.id, ...r }, transfer);
      }
    }
  } catch (err) {
    self.postMessage({ id: msg.id, error: String((err && err.message) || err) });
  }
};

// ------------------------------------------------------------
// PNG
// ------------------------------------------------------------

async function decodePNG(url) {
  if (typeof OffscreenCanvas === 'undefined') throw new Error('NO_OFFSCREEN');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo cargar la imagen: ${url}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('NO_OFFSCREEN');
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const data = new Uint8Array(bmp.width * bmp.height);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = px[j + 3] === 0 ? 0 : px[j];
  }
  const w = bmp.width;
  const h = bmp.height;
  bmp.close();
  return { data, w, h };
}

// ------------------------------------------------------------
// DATOS DE VIENTO
// ------------------------------------------------------------

const metaCache = new Map();
const yearCache = new Map();
const YEAR_CACHE_LIMIT = 12;

function loadMeta(level) {
  if (!metaCache.has(level)) {
    const p = fetch(`${WIND_BASE}${level}/metadata.json`).then((r) => {
      if (!r.ok) throw new Error(`No se pudo cargar metadata del viento: ${level}`);
      return r.json();
    });
    p.catch(() => metaCache.delete(level));
    metaCache.set(level, p);
  }
  return metaCache.get(level);
}

function loadYear(level, year) {
  const key = `${level}/${year}`;
  if (yearCache.has(key)) {
    const p = yearCache.get(key);
    yearCache.delete(key);
    yearCache.set(key, p);
    return p;
  }
  const p = fetch(`${WIND_BASE}${level}/${year}.bin`).then(async (r) => {
    if (!r.ok) throw new Error(`No se pudo cargar viento: ${key}`);
    const buf = await r.arrayBuffer();
    return new Int16Array(buf);
  });
  p.catch(() => yearCache.delete(key));
  yearCache.set(key, p);
  while (yearCache.size > YEAR_CACHE_LIMIT) {
    yearCache.delete(yearCache.keys().next().value);
  }
  return p;
}

// Campo U/V del fotograma (con interpolación mensual).
async function buildField(msg) {
  const meta = await loadMeta(msg.level);
  const W = meta.width;
  const H = meta.height;
  const n = W * H;
  const scale = meta.encoding.scale;
  const miss = meta.encoding.missingValue;

  const dA = await loadYear(msg.level, msg.year);
  const offA = msg.month * n * 2;
  if (offA + n * 2 > dA.length) {
    throw new Error(`El archivo de viento no contiene el mes ${msg.month + 1}.`);
  }

  let dB = null;
  let offB = 0;
  let alpha = msg.alpha;
  if (alpha > 0) {
    try {
      dB = msg.nextYear === msg.year ? dA : await loadYear(msg.level, msg.nextYear);
      offB = msg.nextMonth * n * 2;
      if (offB + n * 2 > dB.length) dB = null;
    } catch {
      dB = null;
    }
    if (!dB) alpha = 0;
  }

  const U = new Float32Array(n);
  const V = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const u1 = dA[offA + i];
    const v1 = dA[offA + n + i];
    if (u1 === miss || v1 === miss) {
      U[i] = NaN;
      V[i] = NaN;
      continue;
    }
    if (alpha > 0) {
      const u2 = dB[offB + i];
      const v2 = dB[offB + n + i];
      if (u2 === miss || v2 === miss) {
        U[i] = NaN;
        V[i] = NaN;
        continue;
      }
      U[i] = (u1 * (1 - alpha) + u2 * alpha) * scale;
      V[i] = (v1 * (1 - alpha) + v2 * alpha) * scale;
    } else {
      U[i] = u1 * scale;
      V[i] = v1 * scale;
    }
  }

  return { U, V, width: W, height: H };
}

// ------------------------------------------------------------
// MUESTREO (sin crear objetos: resultados en variables globales)
// ------------------------------------------------------------

let SU = 0;
let SV = 0;

function sample(F, x, y) {
  const W = F.width;
  const H = F.height;
  x = ((x % W) + W) % W;
  if (y < 0 || y >= H - 1) return false;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = (x0 + 1) % W;
  const y1 = Math.min(y0 + 1, H - 1);
  const fx = x - x0;
  const fy = y - y0;

  const i00 = y0 * W + x0;
  const i10 = y0 * W + x1;
  const i01 = y1 * W + x0;
  const i11 = y1 * W + x1;

  const U = F.U;
  const V = F.V;
  const u00 = U[i00], u10 = U[i10], u01 = U[i01], u11 = U[i11];
  const v00 = V[i00], v10 = V[i10], v01 = V[i01], v11 = V[i11];

  // NaN !== NaN
  if (u00 !== u00 || u10 !== u10 || u01 !== u01 || u11 !== u11 ||
      v00 !== v00 || v10 !== v10 || v01 !== v01 || v11 !== v11) {
    return false;
  }

  const u0 = u00 * (1 - fx) + u10 * fx;
  const u1 = u01 * (1 - fx) + u11 * fx;
  const v0 = v00 * (1 - fx) + v10 * fx;
  const v1 = v01 * (1 - fx) + v11 * fx;

  SU = u0 * (1 - fy) + u1 * fy;
  SV = v0 * (1 - fy) + v1 * fy;
  return true;
}

let DX = 0;
let DY = 0;
const DEG = Math.PI / 180;

function direction(F, x, y, dir) {
  if (!sample(F, x, y)) return false;
  const lat = 90 - (y / (F.height - 1)) * 180;
  const cosLat = Math.max(0.15, Math.cos(lat * DEG));
  const dx = SU / cosLat;
  const dy = -SV;
  const m = Math.sqrt(dx * dx + dy * dy);
  if (!(m >= 1e-8) || m === Infinity) return false;
  DX = (dx / m) * dir;
  DY = (dy / m) * dir;
  return true;
}

// ------------------------------------------------------------
// OCUPACIÓN
// ------------------------------------------------------------

function createOccupancy(F) {
  const columns = Math.ceil(F.width / STREAM_CELL_SIZE);
  const rows = Math.ceil(F.height / STREAM_CELL_SIZE);
  return { columns, rows, span: columns * STREAM_CELL_SIZE, cells: new Uint8Array(columns * rows) };
}

function occupied(o, x, y) {
  x = ((x % o.span) + o.span) % o.span;
  const cx = Math.floor(x / STREAM_CELL_SIZE);
  const cy = Math.floor(y / STREAM_CELL_SIZE);
  if (cy < 0 || cy >= o.rows) return true;
  for (let oy = -STREAM_BUFFER_CELLS; oy <= STREAM_BUFFER_CELLS; oy++) {
    const yy = cy + oy;
    if (yy < 0 || yy >= o.rows) continue;
    for (let ox = -STREAM_BUFFER_CELLS; ox <= STREAM_BUFFER_CELLS; ox++) {
      const xx = (cx + ox + o.columns) % o.columns;
      if (o.cells[yy * o.columns + xx]) return true;
    }
  }
  return false;
}

function markOccupancy(o, pts) {
  for (let k = 0; k < pts.length; k += 2) {
    const x = ((pts[k] % o.span) + o.span) % o.span;
    const cx = Math.floor(x / STREAM_CELL_SIZE);
    const cy = Math.floor(pts[k + 1] / STREAM_CELL_SIZE);
    if (cy < 0 || cy >= o.rows) continue;
    for (let oy = -STREAM_BUFFER_CELLS; oy <= STREAM_BUFFER_CELLS; oy++) {
      const yy = cy + oy;
      if (yy < 0 || yy >= o.rows) continue;
      for (let ox = -STREAM_BUFFER_CELLS; ox <= STREAM_BUFFER_CELLS; ox++) {
        o.cells[yy * o.columns + ((cx + ox + o.columns) % o.columns)] = 1;
      }
    }
  }
}

// ------------------------------------------------------------
// INTEGRACIÓN RK4
// ------------------------------------------------------------

function integrate(F, x, y, dir, occ) {
  const pts = [];
  const h = STREAM_STEP;
  const W = F.width;

  for (let i = 0; i < STREAM_MAX_STEPS; i++) {
    if (y < 0 || y >= F.height - 1) break;
    if (occ && i > 0 && occupied(occ, x, y)) break;

    if (!direction(F, x, y, dir)) break;
    const k1x = DX, k1y = DY;
    if (!direction(F, x + k1x * h * 0.5, y + k1y * h * 0.5, dir)) break;
    const k2x = DX, k2y = DY;
    if (!direction(F, x + k2x * h * 0.5, y + k2y * h * 0.5, dir)) break;
    const k3x = DX, k3y = DY;
    if (!direction(F, x + k3x * h, y + k3y * h, dir)) break;
    const k4x = DX, k4y = DY;

    pts.push(x, y);

    x += (h * (k1x + 2 * k2x + 2 * k3x + k4x)) / 6;
    y += (h * (k1y + 2 * k2y + 2 * k3y + k4y)) / 6;
    x = ((x % W) + W) % W;
  }
  return pts;
}

// Clase de color según velocidad (igual que colorViento original).
function speedClass(s) {
  if (s < 2) return 0;
  if (s < 7) return 1;
  return 2;
}

// ------------------------------------------------------------
// STREAMLINES
// ------------------------------------------------------------

// Simplificación Douglas-Peucker (tolerancia en celdas del campo).
// Elimina puntos casi colineales sin cambio visible.
const SIMPLIFY_TOL = 0.06;

function simplify(pts, out) {
  const n = pts.length / 2;
  if (n <= 2) {
    for (let i = 0; i < pts.length; i++) out.push(pts[i]);
    return n;
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [0, n - 1];
  const tol2 = SIMPLIFY_TOL * SIMPLIFY_TOL;

  while (stack.length) {
    const b = stack.pop();
    const a = stack.pop();
    const ax = pts[a * 2], ay = pts[a * 2 + 1];
    const bx = pts[b * 2], by = pts[b * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 2] - ax;
      const py = pts[i * 2 + 1] - ay;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
      const ex = px - t * dx;
      const ey = py - t * dy;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2 && idx > 0) {
      keep[idx] = 1;
      stack.push(a, idx, idx, b);
    }
  }

  let count = 0;
  for (let i = 0; i < n; i++) {
    if (keep[i]) {
      out.push(pts[i * 2], pts[i * 2 + 1]);
      count++;
    }
  }
  return count;
}

// Dibuja las streamlines en un OffscreenCanvas y devuelve un ImageBitmap.
function rasterize(r, style) {
  if (!style || typeof OffscreenCanvas === 'undefined') return null;
  const S = style.scale;
  const canvas = new OffscreenCanvas(r.width * S, r.height * S);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.setTransform(S, 0, 0, S, 0, 0);
  ctx.lineCap = 'round';
  // Uniones "miter": idénticas a la vista en curvas suaves y
  // mucho más rápidas de rasterizar que "round".
  ctx.lineJoin = 'miter';
  ctx.lineWidth = style.lineWidth;

  for (let c = 0; c < 3; c++) {
    const { coords, lens } = r.runs[c];
    if (!lens.length) continue;
    ctx.beginPath();
    let k = 0;
    for (let j = 0; j < lens.length; j++) {
      ctx.moveTo(coords[k], coords[k + 1]);
      k += 2;
      for (let p = 1; p < lens[j]; p++, k += 2) ctx.lineTo(coords[k], coords[k + 1]);
    }
    ctx.strokeStyle = style.colors[c];
    ctx.stroke();
  }

  ctx.lineJoin = 'round';
  ctx.lineWidth = style.arrowWidth;
  const a = r.arrows;
  for (let c = 0; c < 3; c++) {
    ctx.beginPath();
    for (let i = 0; i < a.length; i += 7) {
      if (a[i + 6] !== c) continue;
      ctx.moveTo(a[i], a[i + 1]);
      ctx.lineTo(a[i + 2], a[i + 3]);
      ctx.lineTo(a[i + 4], a[i + 5]);
    }
    ctx.strokeStyle = style.colors[c];
    ctx.stroke();
  }

  return canvas.transferToImageBitmap();
}

async function computeStreamlines(msg) {
  const F = await buildField(msg);
  const occ = createOccupancy(F);
  const runs = [
    { coords: [], lens: [] },
    { coords: [], lens: [] },
    { coords: [], lens: [] }
  ];
  const arrows = [];

  // Tramo continuo actual (mismo color, sin cortes).
  let tramo = [];
  let tramoClase = -1;
  const cerrarTramo = () => {
    if (tramo.length >= 4) {
      const r = runs[tramoClase];
      r.lens.push(simplify(tramo, r.coords));
    }
    tramo = [];
    tramoClase = -1;
  };

  const dx = F.width / SEED_COLUMNS;
  const dy = F.height / SEED_ROWS;

  for (let j = 0; j < SEED_ROWS; j++) {
    for (let i = 0; i < SEED_COLUMNS; i++) {
      const sx = (i + 0.5) * dx;
      const sy = (j + 0.5) * dy;

      if (!sample(F, sx, sy)) continue;
      if (Math.hypot(SU, SV) < 0.05) continue;
      if (occupied(occ, sx, sy)) continue;

      const fwd = integrate(F, sx, sy, 1, occ);
      const back = integrate(F, sx, sy, -1, occ);

      // atrás (invertido) + adelante, como en la versión original.
      const n = (back.length + fwd.length) / 2;
      if (n < 3) continue;
      const pts = new Float64Array(n * 2);
      let k = 0;
      for (let b = back.length - 2; b >= 0; b -= 2) {
        pts[k++] = back[b];
        pts[k++] = back[b + 1];
      }
      for (let f = 0; f < fwd.length; f++) pts[k++] = fwd[f];

      markOccupancy(occ, pts);

      // Segmentos coloreados por velocidad, unidos en tramos
      // continuos del mismo color.
      for (let p = 1; p < n; p++) {
        const x1 = pts[(p - 1) * 2], y1 = pts[(p - 1) * 2 + 1];
        const x2 = pts[p * 2], y2 = pts[p * 2 + 1];
        if (Math.abs(x2 - x1) > F.width * 0.5 ||
            !sample(F, (x1 + x2) * 0.5, (y1 + y2) * 0.5)) {
          cerrarTramo();
          continue;
        }
        const cls = speedClass(Math.hypot(SU, SV));
        if (cls !== tramoClase) {
          cerrarTramo();
          tramoClase = cls;
          tramo.push(x1, y1);
        }
        tramo.push(x2, y2);
      }
      cerrarTramo();

      // Una flecha por trayectoria.
      const a = Math.floor(n * 0.6);
      if (a >= 1 && a < n - 1 && sample(F, pts[a * 2], pts[a * 2 + 1])) {
        const cls = speedClass(Math.hypot(SU, SV));
        const x1 = pts[(a - 1) * 2], y1 = pts[(a - 1) * 2 + 1];
        const x2 = pts[(a + 1) * 2], y2 = pts[(a + 1) * 2 + 1];
        const ang = Math.atan2(y2 - y1, x2 - x1);
        arrows.push(
          x2 - ARROW_SIZE * Math.cos(ang - ARROW_OPENING),
          y2 - ARROW_SIZE * Math.sin(ang - ARROW_OPENING),
          x2, y2,
          x2 - ARROW_SIZE * Math.cos(ang + ARROW_OPENING),
          y2 - ARROW_SIZE * Math.sin(ang + ARROW_OPENING),
          cls
        );
      }
    }
  }

  return {
    width: F.width,
    height: F.height,
    runs: runs.map((r) => ({ coords: new Float32Array(r.coords), lens: new Uint32Array(r.lens) })),
    arrows: new Float32Array(arrows)
  };
}
