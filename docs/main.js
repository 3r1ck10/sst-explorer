/* =============================================================
   SST EXPLORER · v2
   -------------------------------------------------------------
   - Mapas renderizados en GPU (Three.js / WebGL2): la paleta,
     la interpolación entre meses y la diferencia B − A se
     calculan en el shader, no en la CPU.
   - Solo se descargan los fotogramas mensuales; la transición
     entre meses se interpola de forma continua en la GPU.
   - Los PNG se decodifican en Web Workers (sin bloquear la UI).
   - Viento: partículas animadas con estelas acumuladas en un
     render target (en lugar de streamlines RK4 por fotograma).
   - Vista de mapa 2D (zoom / desplazamiento) y globo 3D.
   ============================================================= */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// =============================================================
// CONFIGURACIÓN
// =============================================================

const CONFIG = {
  metadataPath: 'data/metadata.json',
  windBasePath: 'data/wind/',
  framesPerMonth: 10,

  maxConcurrent: 6,
  workers: 3,
  frameCacheLimit: 150,
  windCacheLimit: 16,

  display: {
    anomaly: { min: -4, max: 4, iso: 1, isoMajor: 0, label: 'Anomalía SST', signed: true },
    sst: { min: 0, max: 32, iso: 2, isoMajor: 28, label: 'SST', signed: false }
  },
  diff: { min: -4, max: 4, iso: 1, isoMajor: 0 },

  palettes: {
    moderna: {
      anomaly: ['#d6f1ff', '#74c6f2', '#2f8bd3', '#1f4f93', '#151b27', '#93302a', '#d24a2a', '#f39237', '#ffe7a0'],
      sst: ['#042333', '#2c3395', '#744992', '#b15f82', '#eb7958', '#fbb43d', '#e8fa5b'],
      land: '#363d49',
      coast: '#a8b6cc',
      trailSlow: '#a9c4e6',
      trailFast: '#ffffff',
      windBar: 'linear-gradient(90deg, rgba(169,196,230,.25), #fff)'
    },
    clasica: {
      anomaly: ['#2337aa', '#5aa0dc', '#f5f5f5', '#f0914b', '#aa1423'],
      sst: ['#313695', '#4575b4', '#74add1', '#abd9e9', '#ffffbf', '#fdae61', '#f46d43', '#d73027', '#a50026'],
      land: '#2a3039',
      coast: '#0b0f15',
      trailSlow: '#2a3346',
      trailFast: '#05070c',
      windBar: 'linear-gradient(90deg, rgba(42,51,70,.25), #05070c)'
    }
  },

  windLevels: {
    '10m': { label: '10 m', speedMax: 12, flow: 1.0 },
    '850hpa': { label: '850 hPa', speedMax: 16, flow: 1.25 },
    '500hpa': { label: '500 hPa', speedMax: 32, flow: 2.0 },
    '250hpa': { label: '250 hPa', speedMax: 55, flow: 3.0 }
  },

  regions: {
    global: { cx: 180, cy: 0, zoom: 1 },
    pacifico: { cx: 200, cy: 0, zoom: 2.3 },
    nino34: { cx: 215, cy: 0, zoom: 5 },
    peru: { cx: 278, cy: -8, zoom: 5 }
  },

  presets: [
    { label: '82-83 vs 97-98', a: 1982, b: 1997 },
    { label: '97-98 vs 15-16', a: 1997, b: 2015 },
    { label: '15-16 vs 23-24', a: 2015, b: 2023 },
    { label: 'Niña 88-89 vs 10-11', a: 1988, b: 2010 },
    { label: '23-24 vs 25-26', a: 2023, b: 2025 }
  ],

  // Referencia aproximada (año de inicio del par).
  eventos: {
    1982: 'El Niño muy fuerte', 1987: 'El Niño', 1988: 'La Niña', 1991: 'El Niño',
    1997: 'El Niño muy fuerte', 1998: 'La Niña', 1999: 'La Niña', 2007: 'La Niña',
    2009: 'El Niño', 2010: 'La Niña', 2015: 'El Niño muy fuerte', 2020: 'La Niña',
    2021: 'La Niña', 2023: 'El Niño'
  },

  // Caja Niño 3.4 (longitudes 0–360).
  nino34: { lon0: 190, lon1: 240, lat0: -5, lat1: 5 }
};

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const INICIALES = ['E', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const DEG = Math.PI / 180;
const FULL_WIN = { x0: 0, y0: -90, w: 360, h: 180 };

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mod = (a, n) => ((a % n) + n) % n;

// =============================================================
// ESTADO
// =============================================================

const state = {
  meta: null,
  variable: 'anomaly',
  view: '2d',
  paleta: 'moderna',
  periodA: { inicio: 1982, fin: 1983 },
  periodB: { inicio: 1997, fin: 1998 },
  t: 0,
  total: 24,
  playing: false,
  speed: 1,
  wind: true,
  windLevel: '10m',
  iso: true,
  regions: true,
  tooltip: true,
  win: { cx: 180, cy: 0, zoom: 1 },
  hover: null
};

// =============================================================
// PERIODOS Y TIEMPO
// =============================================================

function mesesAnio(anio) {
  const info = state.meta?.anios[String(anio)];
  if (!info) return 0;
  const frames = info[state.variable]?.frames ?? 0;
  return Math.ceil(frames / CONFIG.framesPerMonth);
}

function mesesPeriodo(p) {
  return mesesAnio(p.inicio) + mesesAnio(p.fin);
}

function mesDePeriodo(p, i) {
  const m1 = mesesAnio(p.inicio);
  return i < m1 ? { year: p.inicio, month: i } : { year: p.fin, month: i - m1 };
}

function etiquetaMes(p, i) {
  const { year, month } = mesDePeriodo(p, i);
  return `${MESES[month]} ${year}`;
}

function tiempo() {
  const max = Math.max(0, state.total - 1);
  const t = clamp(state.t, 0, max);
  const i0 = Math.floor(t);
  const i1 = Math.min(i0 + 1, max);
  return { i0, i1, frac: i1 === i0 ? 0 : t - i0 };
}

// =============================================================
// CARGA DE FOTOGRAMAS (WEB WORKERS)
// =============================================================

const WORKER_SRC = `
self.onmessage = async (e) => {
  const { id, url } = e.data;
  try {
    if (typeof OffscreenCanvas === 'undefined') throw new Error('NO_OFFSCREEN');
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('NO_OFFSCREEN');
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const out = new Uint8Array(bmp.width * bmp.height);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = d[j + 3] === 0 ? 0 : d[j];
    self.postMessage({ id, w: bmp.width, h: bmp.height, data: out }, [out.buffer]);
    bmp.close();
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};`;

const FrameStore = (() => {
  const entries = new Map();
  const queue = [];
  const pending = new Map();
  const listeners = [];
  let active = 0;
  let nextId = 1;
  let workers = [];
  let mainCanvas = null;
  let isProtected = () => false;

  try {
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    for (let i = 0; i < CONFIG.workers; i++) {
      const w = new Worker(url);
      w.onmessage = onMessage;
      w.onerror = fallbackToMain;
      workers.push(w);
    }
  } catch {
    workers = [];
  }

  function fallbackToMain() {
    workers = [];
    for (const [id, p] of pending) {
      pending.delete(id);
      decodeMain(p.url).then(p.resolve, p.reject);
    }
  }

  function onMessage(ev) {
    const { id, error, data, w, h } = ev.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error === 'NO_OFFSCREEN') {
      workers = [];
      decodeMain(p.url).then(p.resolve, p.reject);
    } else if (error) {
      p.reject(new Error(error));
    } else {
      p.resolve({ data, w, h });
    }
  }

  async function decodeMain(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    if (!mainCanvas) mainCanvas = document.createElement('canvas');
    mainCanvas.width = bmp.width;
    mainCanvas.height = bmp.height;
    const ctx = mainCanvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, bmp.width, bmp.height);
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const out = new Uint8Array(bmp.width * bmp.height);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = d[j + 3] === 0 ? 0 : d[j];
    bmp.close?.();
    return { data: out, w: bmp.width, h: bmp.height };
  }

  function decode(url) {
    if (workers.length) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { url, resolve, reject });
        workers[id % workers.length].postMessage({ id, url });
      });
    }
    return decodeMain(url);
  }

  function key(variable, year, month) {
    return `${variable}/${year}/${month}`;
  }

  function peek(variable, year, month) {
    return entries.get(key(variable, year, month)) || null;
  }

  function get(variable, year, month, urgent = false) {
    const k = key(variable, year, month);
    let e = entries.get(k);
    if (!e) {
      e = { key: k, variable, year, month, status: 'idle', texture: null, data: null, nino: undefined };
      entries.set(k, e);
    }
    e.lastUse = performance.now();
    if (e.status === 'idle') {
      e.status = 'queued';
      if (urgent) queue.unshift(e); else queue.push(e);
      pump();
    } else if (urgent && e.status === 'queued') {
      const idx = queue.indexOf(e);
      if (idx > 0) {
        queue.splice(idx, 1);
        queue.unshift(e);
      }
    }
    return e;
  }

  function pump() {
    while (active < CONFIG.maxConcurrent && queue.length) {
      const e = queue.shift();
      if (e.status !== 'queued') continue;
      active++;
      e.status = 'loading';
      load(e).finally(() => {
        active--;
        pump();
      });
    }
  }

  async function load(e) {
    const frame = String(e.month * CONFIG.framesPerMonth).padStart(4, '0');
    const url = new URL(`data/${e.variable}/${e.year}/frame_${frame}.png`, location.href).href;
    try {
      const r = await decode(url);
      const tex = new THREE.DataTexture(r.data, r.w, r.h, THREE.RedFormat, THREE.UnsignedByteType);
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.unpackAlignment = 1;
      tex.needsUpdate = true;
      e.data = r.data;
      e.w = r.w;
      e.h = r.h;
      e.texture = tex;
      e.status = 'ready';
      listeners.forEach((fn) => fn(e));
      evict();
    } catch (err) {
      e.status = 'error';
      console.error('Error cargando fotograma', url, err);
    }
  }

  function evict() {
    if (entries.size <= CONFIG.frameCacheLimit) return;
    const candidates = [...entries.values()]
      .filter((e) => (e.status === 'ready' || e.status === 'error') && !isProtected(e))
      .sort((a, b) => a.lastUse - b.lastUse);
    const target = Math.floor(CONFIG.frameCacheLimit * 0.8);
    for (const e of candidates) {
      if (entries.size <= target) break;
      e.texture?.dispose();
      entries.delete(e.key);
    }
  }

  function dropQueued() {
    // Descarta descargas pendientes que ya no son necesarias.
    for (let i = queue.length - 1; i >= 0; i--) {
      const e = queue[i];
      if (!isProtected(e)) {
        e.status = 'idle';
        queue.splice(i, 1);
      }
    }
  }

  return {
    get,
    peek,
    dropQueued,
    onReady: (fn) => listeners.push(fn),
    setProtect: (fn) => { isProtected = fn; },
    get pendingCount() { return queue.length + active; }
  };
})();

// =============================================================
// VIENTO: DATOS
// =============================================================

const WindStore = (() => {
  const metas = new Map();
  const years = new Map();
  const listeners = [];

  function lazy(map, k, loader) {
    let e = map.get(k);
    if (!e) {
      e = { status: 'loading', value: null };
      map.set(k, e);
      loader().then(
        (v) => { e.value = v; e.status = 'ready'; listeners.forEach((fn) => fn()); },
        (err) => { e.status = 'error'; console.error(err); }
      );
    }
    return e;
  }

  function meta(level) {
    return lazy(metas, level, async () => {
      const r = await fetch(`${CONFIG.windBasePath}${level}/metadata.json`);
      if (!r.ok) throw new Error(`No se pudo cargar metadata del viento (${level})`);
      return r.json();
    });
  }

  function year(level, y) {
    const k = `${level}/${y}`;
    const existing = years.get(k);
    if (existing) {
      // Mantener orden LRU.
      years.delete(k);
      years.set(k, existing);
      return existing;
    }
    const e = lazy(years, k, async () => {
      const r = await fetch(`${CONFIG.windBasePath}${level}/${y}.bin`);
      if (!r.ok) throw new Error(`No se pudo cargar viento ${k}`);
      return new Int16Array(await r.arrayBuffer());
    });
    while (years.size > CONFIG.windCacheLimit) {
      const oldest = years.keys().next().value;
      years.delete(oldest);
    }
    return e;
  }

  return { meta, year, onReady: (fn) => listeners.push(fn) };
})();

// Prepara un "muestreador" del campo de viento para un periodo
// en el instante actual. Devuelve null si los datos no están listos.
function windSampler(period) {
  if (!period) return null;
  const level = state.windLevel;
  const m = WindStore.meta(level);
  if (m.status !== 'ready') return null;
  const meta = m.value;

  const { i0, i1, frac } = tiempo();
  const a = mesDePeriodo(period, i0);
  const b = mesDePeriodo(period, i1);
  const ya = WindStore.year(level, a.year);
  const yb = WindStore.year(level, b.year);
  if (ya.status !== 'ready' || yb.status !== 'ready') return null;

  const W = meta.width;
  const H = meta.height;
  const n = W * H;
  const offA = a.month * n * 2;
  const offB = b.month * n * 2;
  if (offA + 2 * n > ya.value.length || offB + 2 * n > yb.value.length) return null;

  const latMax = meta.latitude.max;
  const latMin = meta.latitude.min;

  return {
    W, H, n,
    lon0: meta.longitude.min,
    latMax,
    rowsPerDeg: (H - 1) / (latMax - latMin),
    colsPerDeg: W / 360,
    dA: ya.value, offA,
    dB: yb.value, offB,
    frac,
    scale: meta.encoding.scale,
    miss: meta.encoding.missingValue
  };
}

// Interpolación bilineal (espacio) + lineal (tiempo). Escribe u, v en out.
function sampleWind(s, lon, lat, out) {
  const y = (s.latMax - lat) * s.rowsPerDeg;
  if (y < 0 || y > s.H - 1) return false;
  const x = mod(lon - s.lon0, 360) * s.colsPerDeg;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const xa = x0 % s.W;
  const xb = (x0 + 1) % s.W;
  const yb = Math.min(y0 + 1, s.H - 1);

  const i00 = y0 * s.W + xa;
  const i10 = y0 * s.W + xb;
  const i01 = yb * s.W + xa;
  const i11 = yb * s.W + xb;

  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;

  const miss = s.miss;
  const d = s.dA, o = s.offA, n = s.n;
  const ua0 = d[o + i00], ua1 = d[o + i10], ua2 = d[o + i01], ua3 = d[o + i11];
  const va0 = d[o + n + i00], va1 = d[o + n + i10], va2 = d[o + n + i01], va3 = d[o + n + i11];
  if (ua0 === miss || ua1 === miss || ua2 === miss || ua3 === miss ||
      va0 === miss || va1 === miss || va2 === miss || va3 === miss) return false;

  let u = ua0 * w00 + ua1 * w10 + ua2 * w01 + ua3 * w11;
  let v = va0 * w00 + va1 * w10 + va2 * w01 + va3 * w11;

  if (s.frac > 0) {
    const e = s.dB, p = s.offB;
    const ub0 = e[p + i00], ub1 = e[p + i10], ub2 = e[p + i01], ub3 = e[p + i11];
    const vb0 = e[p + n + i00], vb1 = e[p + n + i10], vb2 = e[p + n + i01], vb3 = e[p + n + i11];
    if (!(ub0 === miss || ub1 === miss || ub2 === miss || ub3 === miss ||
          vb0 === miss || vb1 === miss || vb2 === miss || vb3 === miss)) {
      const ub = ub0 * w00 + ub1 * w10 + ub2 * w01 + ub3 * w11;
      const vb = vb0 * w00 + vb1 * w10 + vb2 * w01 + vb3 * w11;
      u += (ub - u) * s.frac;
      v += (vb - v) * s.frac;
    }
  }

  out[0] = u * s.scale;
  out[1] = v * s.scale;
  return true;
}

// =============================================================
// PALETAS
// =============================================================

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function hexToVec3(hex) {
  const [r, g, b] = hexToRgb(hex);
  return new THREE.Vector3(r / 255, g / 255, b / 255);
}

const paletteCache = new Map();

function paletteTexture(stops) {
  const k = stops.join(',');
  if (paletteCache.has(k)) return paletteCache.get(k);
  const rgb = stops.map(hexToRgb);
  const N = 256;
  const data = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const p = (i / (N - 1)) * (rgb.length - 1);
    const j = Math.min(Math.floor(p), rgb.length - 2);
    const f = p - j;
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(rgb[j][c] + (rgb[j + 1][c] - rgb[j][c]) * f);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  paletteCache.set(k, tex);
  return tex;
}

function cssGradient(stops) {
  return `linear-gradient(90deg, ${stops.map((c, i) => `${c} ${(i / (stops.length - 1)) * 100}%`).join(', ')})`;
}

// =============================================================
// SHADERS
// =============================================================

const VS_2D = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const VS_GLOBE = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vPosW;
void main() {
  vUv = uv;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPosW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FS_FIELD = /* glsl */ `
precision highp float;
precision highp int;

uniform sampler2D tA0;
uniform sampler2D tA1;
uniform sampler2D tB0;
uniform sampler2D tB1;
uniform float uFrac;
uniform float uDiff;
uniform vec2 uDecode;      // min, rango de la codificación PNG
uniform vec2 uRange;       // min, max de la paleta
uniform sampler2D uPalette;
uniform float uIso;
uniform float uIsoMajor;
uniform vec3 uLand;
uniform vec3 uCoast;
uniform float uRegions;
uniform float uGrid;
uniform vec4 uWin;
uniform sampler2D uTrail;
uniform vec4 uTrailWin;
uniform float uTrailOn;
uniform vec3 uHover;
uniform float uHasData;

varying vec2 vUv;
#ifdef GLOBE
varying vec3 vNormalW;
varying vec3 vPosW;
#endif

// Muestra bilineal que ignora píxeles sin dato (tierra / hielo).
// Devuelve (valor, peso válido 0..1).
vec2 sampleField(sampler2D t, vec2 ll) {
  ivec2 sz = textureSize(t, 0);
  float fx = mod(ll.x, 360.0) / 360.0 * float(sz.x);
  float fy = clamp((90.0 - ll.y) / 180.0 * float(sz.y - 1), 0.0, float(sz.y - 1));
  float x0f = floor(fx);
  float y0f = floor(fy);
  vec2 f = vec2(fx - x0f, fy - y0f);
  int x0 = int(x0f) % sz.x;
  int x1 = (x0 + 1) % sz.x;
  int y0 = int(y0f);
  int y1 = min(y0 + 1, sz.y - 1);
  vec4 g = vec4(
    texelFetch(t, ivec2(x0, y0), 0).r,
    texelFetch(t, ivec2(x1, y0), 0).r,
    texelFetch(t, ivec2(x0, y1), 0).r,
    texelFetch(t, ivec2(x1, y1), 0).r
  ) * 255.0;
  vec4 m = step(0.5, g);
  vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y) * m;
  float sw = dot(w, vec4(1.0));
  vec4 val = uDecode.x + (g - 1.0) / 254.0 * uDecode.y;
  return vec2(sw > 0.0 ? dot(w, val) / sw : 0.0, sw);
}

vec2 fieldAt(sampler2D t0, sampler2D t1, vec2 ll) {
  vec2 a = sampleField(t0, ll);
  vec2 b = sampleField(t1, ll);
  float va = a.y > 0.001 ? a.x : b.x;
  float vb = b.y > 0.001 ? b.x : a.x;
  return vec2(mix(va, vb, uFrac), mix(a.y, b.y, uFrac));
}

float aline(float d, float w) {
  return 1.0 - smoothstep(w, w + 1.0, d);
}

float gridLine(float coord, float stepDeg, float px) {
  float m = abs(mod(coord + stepDeg * 0.5, stepDeg) - stepDeg * 0.5);
  return aline(m / px, 0.2);
}

float boxLine(vec2 ll, vec4 b, vec2 px, float w) {
  float lon = mod(ll.x, 360.0);
  float dx = min(abs(lon - b.x), abs(lon - b.y)) / px.x;
  float dy = min(abs(ll.y - b.z), abs(ll.y - b.w)) / px.y;
  float inLat = step(b.z - px.y * w, ll.y) * step(ll.y, b.w + px.y * w);
  float inLon = step(b.x - px.x * w, lon) * step(lon, b.y + px.x * w);
  return max(aline(dx, w) * inLat, aline(dy, w) * inLon);
}

void main() {
#ifdef GLOBE
  vec2 ll = vec2(vUv.x * 360.0, (vUv.y - 0.5) * 180.0);
  float pxDeg = length(fwidth(vPosW)) * 57.29578;
  vec2 px = vec2(pxDeg / max(cos(radians(ll.y)), 0.05), pxDeg);
#else
  vec2 ll = uWin.xy + vUv * uWin.zw;
  vec2 px = fwidth(ll);
#endif
  px = max(px, vec2(1e-5));

  vec3 col;

  if (uHasData < 0.5) {
    col = uLand * 0.6;
  } else {
    vec2 F = fieldAt(tA0, tA1, ll);
    if (uDiff > 0.5) {
      vec2 G = fieldAt(tB0, tB1, ll);
      F = vec2(G.x - F.x, min(F.y, G.y));
    }

    float n = clamp((F.x - uRange.x) / (uRange.y - uRange.x), 0.0, 1.0);
    vec3 ocean = texture2D(uPalette, vec2(n * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).rgb;

    if (uIso > 0.0) {
      float x = (F.x - uIsoMajor) / uIso;
      float fw = max(fwidth(x), 1e-4);
      float l = aline(abs(fract(x + 0.5) - 0.5) / fw, 0.3);
      float major = aline(abs(x) / fw, 0.6);
      float lum = dot(ocean, vec3(0.299, 0.587, 0.114));
      vec3 ink = lum < 0.42 ? vec3(1.0) : vec3(0.0);
      ocean = mix(ocean, ink, l * 0.13 + major * 0.22);
    }

    float oceanMask = smoothstep(0.3, 0.7, F.y);
    col = mix(uLand, ocean, oceanMask);
    float coast = aline(abs(F.y - 0.5) / max(fwidth(F.y), 1e-4), 0.35);
    col = mix(col, uCoast, coast * 0.75);
  }

  // Retícula
  if (uGrid > 0.0) {
    float g = max(gridLine(ll.x, uGrid, px.x), gridLine(ll.y, uGrid, px.y));
    col = mix(col, vec3(1.0), g * 0.09);
    col = mix(col, vec3(1.0), aline(abs(ll.y) / px.y, 0.4) * 0.18);
  }

  // Regiones Niño
  if (uRegions > 0.5) {
    float others = max(max(
      boxLine(ll, vec4(210.0, 270.0, -5.0, 5.0), px, 0.35),
      boxLine(ll, vec4(160.0, 210.0, -5.0, 5.0), px, 0.35)),
      boxLine(ll, vec4(270.0, 280.0, -10.0, 0.0), px, 0.35));
    col = mix(col, vec3(1.0), others * 0.4);
    float b34 = boxLine(ll, vec4(190.0, 240.0, -5.0, 5.0), px, 0.9);
    float halo = boxLine(ll, vec4(190.0, 240.0, -5.0, 5.0), px, 2.2);
    col = mix(col, vec3(0.0), halo * 0.35);
    col = mix(col, vec3(1.0, 0.9, 0.45), b34);
  }

  // Estelas de viento (premultiplicadas)
  if (uTrailOn > 0.5) {
    vec2 tuv = vec2((ll.x - uTrailWin.x) / uTrailWin.z, (ll.y - uTrailWin.y) / uTrailWin.w);
#ifdef GLOBE
    tuv.x = fract(tuv.x);
#endif
    vec4 tr = texture2D(uTrail, tuv);
    col = tr.rgb + col * (1.0 - tr.a);
  }

  // Marcador del cursor (sincronizado entre mapas)
  if (uHover.z > 0.5) {
    vec2 d = ll - uHover.xy;
    d.x = mod(d.x + 180.0, 360.0) - 180.0;
    float r = length(d / px);
    col = mix(col, vec3(0.0), aline(abs(r - 7.0), 1.6) * 0.6);
    col = mix(col, vec3(1.0), aline(abs(r - 7.0), 0.6));
    col = mix(col, vec3(1.0), aline(r, 0.8));
  }

#ifdef GLOBE
  vec3 V = normalize(cameraPosition - vPosW);
  vec3 N = normalize(vNormalW);
  vec3 L = normalize(V + vec3(0.25, 0.35, 0.0));
  float lambert = max(dot(N, L), 0.0);
  col *= 0.7 + 0.32 * lambert;
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += vec3(0.3, 0.55, 1.0) * rim * 0.45;
#endif

  gl_FragColor = vec4(col, 1.0);
}`;

const ATMO_VS = /* glsl */ `
varying vec3 vN;
void main() {
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const ATMO_FS = /* glsl */ `
varying vec3 vN;
void main() {
  float i = pow(clamp(-vN.z, 0.0, 1.0), 1.6) * 1.5;
  gl_FragColor = vec4(vec3(0.32, 0.62, 1.0) * i, i);
}`;

const FADE_VS = VS_2D;

const FADE_FS = /* glsl */ `
uniform sampler2D tPrev;
uniform float uFade;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tPrev, vUv) * uFade;
  c *= step(0.015, c.a);
  gl_FragColor = c;
}`;

const LINE_VS = /* glsl */ `
attribute float aSpeed;
varying float vS;
void main() {
  vS = aSpeed;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const LINE_FS = /* glsl */ `
uniform vec3 uSlow;
uniform vec3 uFast;
uniform float uMax;
varying float vS;
void main() {
  float s = clamp(vS / uMax, 0.0, 1.0);
  vec3 c = mix(uSlow, uFast, s);
  float a = mix(0.28, 1.0, sqrt(s));
  gl_FragColor = vec4(c * a, a);
}`;

// =============================================================
// RECURSOS COMPARTIDOS
// =============================================================

const EMPTY_RED = (() => {
  const t = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat);
  t.needsUpdate = true;
  return t;
})();

const EMPTY_RGBA = (() => {
  const t = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
})();

const SPHERE_GEO = new THREE.SphereGeometry(1, 192, 96);
const ATMO_GEO = new THREE.SphereGeometry(1.13, 64, 32);
const QUAD_GEO = new THREE.PlaneGeometry(2, 2);
const DUMMY_CAM = new THREE.Camera();

const STAR_GEO = (() => {
  const n = 1600;
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const z = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    p[i * 3] = r * Math.cos(a) * 60;
    p[i * 3 + 1] = z * 60;
    p[i * 3 + 2] = r * Math.sin(a) * 60;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  return g;
})();

const globeCamera = new THREE.PerspectiveCamera(35, 2, 0.1, 200);

function lookAtLonLat(lon, lat = 0, dist = 3.7) {
  const phi = (lon / 360) * Math.PI * 2;
  const th = (90 - lat) * DEG;
  globeCamera.position.set(
    -Math.cos(phi) * Math.sin(th) * dist,
    Math.cos(th) * dist,
    Math.sin(phi) * Math.sin(th) * dist
  );
  globeCamera.lookAt(0, 0, 0);
}

lookAtLonLat(200, 5);

// =============================================================
// VIENTO: PARTÍCULAS
// =============================================================

class WindLayer {
  constructor(view) {
    this.view = view;
    this.rts = [];
    this.cur = 0;
    this.sizeKey = '';
    this.winKey = '';
    this.n = 0;
    this.seeded = false;
    this.tmp = new Float32Array(2);

    this.fadeMat = new THREE.ShaderMaterial({
      uniforms: { tPrev: { value: null }, uFade: { value: 0.96 } },
      vertexShader: FADE_VS,
      fragmentShader: FADE_FS,
      depthTest: false,
      depthWrite: false
    });
    this.fadeScene = new THREE.Scene();
    const quad = new THREE.Mesh(QUAD_GEO, this.fadeMat);
    quad.frustumCulled = false;
    this.fadeScene.add(quad);

    this.lineMat = new THREE.ShaderMaterial({
      uniforms: {
        uSlow: { value: new THREE.Vector3(1, 1, 1) },
        uFast: { value: new THREE.Vector3(1, 1, 1) },
        uMax: { value: 12 }
      },
      vertexShader: LINE_VS,
      fragmentShader: LINE_FS,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor
    });
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), this.lineMat);
    this.lines.frustumCulled = false;
    this.lineScene = new THREE.Scene();
    this.lineScene.add(this.lines);
    this.lineCam = new THREE.OrthographicCamera(0, 360, 90, -90, -1, 1);
  }

  get texture() {
    return this.rts.length ? this.rts[this.cur].texture : null;
  }

  allocate(W, H) {
    this.rts.forEach((rt) => rt.dispose());
    const type = this.view.halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.rts = [0, 1].map(() => new THREE.WebGLRenderTarget(W, H, {
      type,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter
    }));
    this.clear();
  }

  clear() {
    const r = this.view.renderer;
    r.setClearColor(0x000000, 0);
    for (const rt of this.rts) {
      r.setRenderTarget(rt);
      r.clear(true, false, false);
    }
    r.setRenderTarget(null);
  }

  setCount(n) {
    this.n = n;
    this.lon = new Float32Array(n);
    this.lat = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.pos = new Float32Array(n * 6);
    this.spd = new Float32Array(n * 2);
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.spdAttr = new THREE.BufferAttribute(this.spd, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.posAttr);
    g.setAttribute('aSpeed', this.spdAttr);
    this.lines.geometry.dispose();
    this.lines.geometry = g;
    this.seeded = false;
  }

  respawn(i, win, globe) {
    this.lon[i] = win.x0 + Math.random() * win.w;
    this.lat[i] = globe
      ? Math.asin(Math.random() * 2 - 1) / DEG * 0.985
      : win.y0 + Math.random() * win.h;
    this.age[i] = 0;
    this.life[i] = 45 + Math.random() * 90;
  }

  step(dt, win, globe, sampler) {
    const view = this.view;
    const r = view.renderer;
    const canvas = r.domElement;
    const W = globe ? 2048 : canvas.width;
    const H = globe ? 1024 : canvas.height;
    const sizeKey = `${W}x${H}`;
    if (sizeKey !== this.sizeKey) {
      this.allocate(W, H);
      this.sizeKey = sizeKey;
      this.winKey = '';
    }

    const n = globe ? 11000 : clamp(Math.round((view.w * view.h) / 38), 1500, 11000);
    if (n !== this.n) this.setCount(n);

    if (!this.seeded) {
      for (let i = 0; i < n; i++) {
        this.respawn(i, win, globe);
        this.age[i] = Math.random() * this.life[i];
      }
      this.seeded = true;
    }

    const wk = `${win.x0.toFixed(4)}|${win.y0.toFixed(4)}|${win.w.toFixed(4)}|${win.h.toFixed(4)}|${state.windLevel}`;
    if (wk !== this.winKey) {
      this.winKey = wk;
      this.clear();
      this.lineCam.left = win.x0;
      this.lineCam.right = win.x0 + win.w;
      this.lineCam.bottom = win.y0;
      this.lineCam.top = win.y0 + win.h;
      this.lineCam.updateProjectionMatrix();
    }

    const pal = CONFIG.palettes[state.paleta];
    const lvl = CONFIG.windLevels[state.windLevel];
    this.lineMat.uniforms.uSlow.value.copy(hexToVec3(pal.trailSlow));
    this.lineMat.uniforms.uFast.value.copy(hexToVec3(pal.trailFast));
    this.lineMat.uniforms.uMax.value = lvl.speedMax;

    const dts = clamp(dt * 60, 0.25, 3);
    const k = 0.045 * (win.w / 360) / lvl.flow * dts;
    const wrap = win.w >= 359.9;
    const x1 = win.x0 + win.w;
    const y1 = win.y0 + win.h;
    const { lon, lat, age, life, pos, spd, tmp } = this;

    for (let i = 0; i < n; i++) {
      const o = i * 6;
      age[i] += dts;
      let x = lon[i];
      let y = lat[i];
      const outside = y < win.y0 || y > y1 || x < win.x0 || x > x1;
      const ok = sampler && !outside && age[i] <= life[i] && sampleWind(sampler, x, y, tmp);

      if (!ok) {
        if (sampler) this.respawn(i, win, globe);
        x = lon[i];
        y = lat[i];
        pos[o] = pos[o + 3] = x;
        pos[o + 1] = pos[o + 4] = y;
        pos[o + 2] = pos[o + 5] = 0;
        spd[i * 2] = spd[i * 2 + 1] = 0;
        continue;
      }

      const u = tmp[0];
      const v = tmp[1];
      const c = Math.max(Math.cos(y * DEG), 0.15);
      let nx = x + (u * k) / c;
      const ny = y + v * k;
      const s = Math.sqrt(u * u + v * v);

      pos[o] = x; pos[o + 1] = y; pos[o + 2] = 0;
      pos[o + 3] = nx; pos[o + 4] = ny; pos[o + 5] = 0;
      spd[i * 2] = spd[i * 2 + 1] = s;

      if (wrap) {
        if (nx < win.x0) nx += 360;
        else if (nx > x1) nx -= 360;
      }
      lon[i] = nx;
      lat[i] = ny;
    }

    this.posAttr.needsUpdate = true;
    this.spdAttr.needsUpdate = true;

    const prev = this.rts[this.cur];
    const next = this.rts[1 - this.cur];
    this.fadeMat.uniforms.tPrev.value = prev.texture;
    this.fadeMat.uniforms.uFade.value = Math.pow(0.955, dts);
    r.setRenderTarget(next);
    r.render(this.fadeScene, DUMMY_CAM);
    r.render(this.lineScene, this.lineCam);
    r.setRenderTarget(null);
    this.cur = 1 - this.cur;
  }

  reset() {
    this.winKey = '';
    this.seeded = false;
  }
}

// =============================================================
// VISTA DE MAPA (2D / GLOBO)
// =============================================================

class MapView {
  constructor(el, kind) {
    this.el = el;
    this.kind = kind; // 'A' | 'B' | 'D'
    this.w = 1;
    this.h = 1;
    this.dirty = true;
    this.visible = true;
    this.pointers = new Map();
    this.dragged = false;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x000000, 0);
    el.appendChild(this.renderer.domElement);

    const ext = this.renderer.extensions;
    this.halfFloat = this.renderer.capabilities.isWebGL2 &&
      (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float'));

    this.uniforms = {
      tA0: { value: EMPTY_RED },
      tA1: { value: EMPTY_RED },
      tB0: { value: EMPTY_RED },
      tB1: { value: EMPTY_RED },
      uFrac: { value: 0 },
      uDiff: { value: kind === 'D' ? 1 : 0 },
      uDecode: { value: new THREE.Vector2(-5, 10) },
      uRange: { value: new THREE.Vector2(-4, 4) },
      uPalette: { value: EMPTY_RGBA },
      uIso: { value: 1 },
      uIsoMajor: { value: 0 },
      uLand: { value: new THREE.Vector3() },
      uCoast: { value: new THREE.Vector3() },
      uRegions: { value: 1 },
      uGrid: { value: 30 },
      uWin: { value: new THREE.Vector4(0, -90, 360, 180) },
      uTrail: { value: EMPTY_RGBA },
      uTrailWin: { value: new THREE.Vector4(0, -90, 360, 180) },
      uTrailOn: { value: 0 },
      uHover: { value: new THREE.Vector3() },
      uHasData: { value: 0 }
    };

    // Escena 2D
    this.cam2d = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene2d = new THREE.Scene();
    const mat2d = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VS_2D,
      fragmentShader: FS_FIELD,
      depthTest: false,
      depthWrite: false
    });
    const quad = new THREE.Mesh(QUAD_GEO, mat2d);
    quad.frustumCulled = false;
    this.scene2d.add(quad);

    // Escena globo
    this.sceneG = new THREE.Scene();
    const matG = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VS_GLOBE,
      fragmentShader: FS_FIELD,
      defines: { GLOBE: '' }
    });
    this.globe = new THREE.Mesh(SPHERE_GEO, matG);
    const atmo = new THREE.Mesh(ATMO_GEO, new THREE.ShaderMaterial({
      vertexShader: ATMO_VS,
      fragmentShader: ATMO_FS,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false
    }));
    const stars = new THREE.Points(STAR_GEO, new THREE.PointsMaterial({
      color: 0x9fb4d8, size: 1.3, sizeAttenuation: false, transparent: true, opacity: 0.65, depthWrite: false
    }));
    this.sceneG.add(stars, this.globe, atmo);

    this.controls = new OrbitControls(globeCamera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.8;
    this.controls.minDistance = 1.45;
    this.controls.maxDistance = 8;
    this.controls.enabled = false;

    this.wind = kind === 'D' ? null : new WindLayer(this);
    this.raycaster = new THREE.Raycaster();

    new ResizeObserver(() => this.resize()).observe(el);
    new IntersectionObserver((entries) => {
      this.visible = entries[0].isIntersecting;
      if (this.visible) this.dirty = true;
    }).observe(el);
    this.resize();
    this.bindEvents();
  }

  period() {
    return this.kind === 'B' ? state.periodB : state.periodA;
  }

  resize() {
    const r = this.el.getBoundingClientRect();
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    this.renderer.setSize(this.w, this.h, false);
    this.dirty = true;
  }

  // Ventana geográfica visible en modo 2D.
  window2d() {
    let w = 360 / state.win.zoom;
    let h = (w * this.h) / this.w;
    if (h > 180) {
      h = 180;
      w = (h * this.w) / this.h;
    }
    const cy = clamp(state.win.cy, -90 + h / 2, 90 - h / 2);
    return { x0: state.win.cx - w / 2, y0: cy - h / 2, w, h };
  }

  lonLatAt(clientX, clientY) {
    const rect = this.el.getBoundingClientRect();
    const u = (clientX - rect.left) / rect.width;
    const v = (clientY - rect.top) / rect.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;

    if (state.view === 'globe') {
      this.raycaster.setFromCamera(new THREE.Vector2(u * 2 - 1, 1 - v * 2), globeCamera);
      const hit = this.raycaster.intersectObject(this.globe, false)[0];
      if (!hit || !hit.uv) return null;
      return { lon: hit.uv.x * 360, lat: (hit.uv.y - 0.5) * 180 };
    }
    const win = this.window2d();
    return { lon: mod(win.x0 + u * win.w, 360), lat: win.y0 + (1 - v) * win.h };
  }

  bindEvents() {
    const el = this.el;

    el.addEventListener('pointerdown', (e) => {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.dragged = false;
      if (state.view === '2d') {
        el.setPointerCapture(e.pointerId);
        if (this.pointers.size === 2) this.pinch = this.pinchInfo();
      }
    });

    el.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (p && state.view === '2d') {
        if (this.pointers.size === 1) {
          const dx = e.clientX - p.x;
          const dy = e.clientY - p.y;
          if (Math.abs(dx) + Math.abs(dy) > 0) {
            if (Math.abs(dx) + Math.abs(dy) > 2) this.dragged = true;
            this.pan(dx, dy);
          }
          p.x = e.clientX;
          p.y = e.clientY;
          if (this.dragged) setHover(null);
          return;
        }
        if (this.pointers.size === 2) {
          p.x = e.clientX;
          p.y = e.clientY;
          const now = this.pinchInfo();
          if (this.pinch && now.d > 0) this.zoomAt(now.cx, now.cy, now.d / this.pinch.d);
          this.pinch = now;
          this.dragged = true;
          return;
        }
      }
      if (p && state.view === 'globe' && e.buttons) {
        this.dragged = true;
        setHover(null);
        return;
      }
      if (e.pointerType !== 'touch') setHover(this, e.clientX, e.clientY);
    });

    const end = (e) => {
      const wasTap = !this.dragged;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (wasTap && e.type === 'pointerup') setHover(this, e.clientX, e.clientY);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch' && !this.pointers.size) setHover(null);
    });

    el.addEventListener('wheel', (e) => {
      if (state.view !== '2d') return;
      e.preventDefault();
      this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });

    el.addEventListener('dblclick', (e) => {
      if (state.view !== '2d') return;
      this.zoomAt(e.clientX, e.clientY, 2);
    });
  }

  pinchInfo() {
    const [a, b] = [...this.pointers.values()];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  pan(dx, dy) {
    const win = this.window2d();
    state.win.cx = mod(state.win.cx - (dx * win.w) / this.w, 360);
    state.win.cy = clamp(state.win.cy + (dy * win.h) / this.h, -90 + win.h / 2, 90 - win.h / 2);
    regionChanged();
  }

  zoomAt(clientX, clientY, factor) {
    const rect = this.el.getBoundingClientRect();
    const u = (clientX - rect.left) / rect.width;
    const v = (clientY - rect.top) / rect.height;
    const win = this.window2d();
    const lon = win.x0 + u * win.w;
    const lat = win.y0 + (1 - v) * win.h;
    state.win.zoom = clamp(state.win.zoom * factor, 1, 18);
    const w2 = this.window2d();
    state.win.cx = mod(lon - (u - 0.5) * w2.w, 360);
    state.win.cy = clamp(lat - (0.5 - v) * w2.h, -90 + w2.h / 2, 90 - w2.h / 2);
    regionChanged();
  }

  render(dt) {
    const u = this.uniforms;
    const r = this.renderer;
    const globe = state.view === 'globe';
    let win = FULL_WIN;

    if (!globe) {
      win = this.window2d();
      u.uWin.value.set(win.x0, win.y0, win.w, win.h);
      u.uGrid.value = win.w > 200 ? 30 : win.w > 70 ? 10 : 5;
    } else {
      u.uGrid.value = 30;
    }

    if (this.wind && state.wind) {
      this.wind.step(dt, win, globe, windSampler(this.period()));
      u.uTrail.value = this.wind.texture || EMPTY_RGBA;
      u.uTrailWin.value.set(win.x0, win.y0, win.w, win.h);
      u.uTrailOn.value = this.wind.texture ? 1 : 0;
    } else {
      u.uTrailOn.value = 0;
    }

    r.setRenderTarget(null);
    r.setClearColor(0x000000, 0);
    r.clear();
    if (globe) {
      globeCamera.aspect = this.w / this.h;
      globeCamera.updateProjectionMatrix();
      r.render(this.sceneG, globeCamera);
    } else {
      r.render(this.scene2d, this.cam2d);
    }
    this.dirty = false;
  }
}

// =============================================================
// APLICACIÓN
// =============================================================

const ui = {
  periodoA: $('periodoA'),
  periodoB: $('periodoB'),
  region: $('region'),
  mostrarVientos: $('mostrarVientos'),
  nivelViento: $('nivelViento'),
  timeline: $('timeline'),
  ticks: $('timelineTicks'),
  btnPlay: $('btnPlay'),
  velocidad: $('velocidad'),
  tooltip: $('tooltip'),
  loader: $('loader'),
  loaderText: $('loaderText'),
  status: $('status'),
  chart: $('ninoChart')
};

let views = {};
let firstFrameShown = false;

function allViews() {
  return [views.A, views.B, views.D];
}

function markDirty() {
  allViews().forEach((v) => { v.dirty = true; });
}

// ---------- Uniforms globales (variable, paleta, capas) ----------

function applyStyleUniforms() {
  const pal = CONFIG.palettes[state.paleta];
  const disp = CONFIG.display[state.variable];
  const decode = state.variable === 'anomaly'
    ? [state.meta.anomaly_min ?? -5, state.meta.anomaly_max ?? 5]
    : [state.meta.sst_min ?? 0, state.meta.sst_max ?? 45];

  const mainPal = paletteTexture(pal[state.variable]);
  const diffPal = paletteTexture(pal.anomaly);

  for (const v of allViews()) {
    const u = v.uniforms;
    const isDiff = v.kind === 'D';
    u.uDecode.value.set(decode[0], decode[1] - decode[0]);
    u.uPalette.value = isDiff ? diffPal : mainPal;
    u.uRange.value.set(isDiff ? CONFIG.diff.min : disp.min, isDiff ? CONFIG.diff.max : disp.max);
    u.uIso.value = state.iso ? (isDiff ? CONFIG.diff.iso : disp.iso) : 0;
    u.uIsoMajor.value = isDiff ? CONFIG.diff.isoMajor : disp.isoMajor;
    u.uLand.value.copy(hexToVec3(pal.land));
    u.uCoast.value.copy(hexToVec3(pal.coast));
    u.uRegions.value = state.regions ? 1 : 0;
    v.controls.enabled = state.view === 'globe';
    v.el.style.cursor = state.view === 'globe' ? 'grab' : '';
  }
  renderLegends();
  markDirty();
}

// ---------- Texturas del instante actual ----------

function frameFor(period, i, urgent) {
  const { year, month } = mesDePeriodo(period, i);
  return FrameStore.get(state.variable, year, month, urgent);
}

function setPair(u, prefix, e0, e1, frac) {
  if (e0.status !== 'ready') return false;
  const t0 = e0.texture;
  const ready1 = e1.status === 'ready';
  const t1 = ready1 ? e1.texture : t0;
  const f = ready1 ? frac : 0;
  const changed = u[prefix + '0'].value !== t0 || u[prefix + '1'].value !== t1 || u.uFrac.value !== f;
  u[prefix + '0'].value = t0;
  u[prefix + '1'].value = t1;
  u.uFrac.value = f;
  return changed;
}

function updateTextures() {
  const { i0, i1, frac } = tiempo();
  const a0 = frameFor(state.periodA, i0, true);
  const a1 = frameFor(state.periodA, i1, true);
  const b0 = frameFor(state.periodB, i0, true);
  const b1 = frameFor(state.periodB, i1, true);

  const { A, B, D } = views;
  if (setPair(A.uniforms, 'tA', a0, a1, frac)) A.dirty = true;
  if (setPair(B.uniforms, 'tA', b0, b1, frac)) B.dirty = true;

  const okA = a0.status === 'ready';
  const okB = b0.status === 'ready';
  const fracD = a1.status === 'ready' && b1.status === 'ready' ? frac : 0;
  if (okA && okB) {
    const u = D.uniforms;
    const ta1 = fracD ? a1.texture : a0.texture;
    const tb1 = fracD ? b1.texture : b0.texture;
    if (u.tA0.value !== a0.texture || u.tA1.value !== ta1 || u.tB0.value !== b0.texture ||
        u.tB1.value !== tb1 || u.uFrac.value !== fracD) {
      u.tA0.value = a0.texture;
      u.tA1.value = ta1;
      u.tB0.value = b0.texture;
      u.tB1.value = tb1;
      u.uFrac.value = fracD;
      D.dirty = true;
    }
  }

  setHasData(A, okA);
  setHasData(B, okB);
  setHasData(D, okA && okB);

  if (!firstFrameShown && okA && okB) {
    firstFrameShown = true;
    ui.loader.classList.add('is-hidden');
  }
}

function setHasData(view, ok) {
  const has = view.uniforms.uHasData.value > 0.5;
  if (ok && !has) {
    view.uniforms.uHasData.value = 1;
    view.dirty = true;
  }
  view.el.classList.toggle('loading', !ok && !has);
}

// ---------- Carga anticipada ----------

function prefetchPeriods() {
  const { i0 } = tiempo();
  // Primero alrededor del instante actual, luego el resto.
  const order = [];
  for (let d = 0; d < state.total; d++) order.push((i0 + d) % state.total);
  for (const i of order) {
    frameFor(state.periodA, i, false);
    frameFor(state.periodB, i, false);
  }
  if (state.wind) prefetchWind();
}

function prefetchWind() {
  const lvl = state.windLevel;
  WindStore.meta(lvl);
  for (const p of [state.periodA, state.periodB]) {
    WindStore.year(lvl, p.inicio);
    WindStore.year(lvl, p.fin);
  }
}

FrameStore.setProtect((e) => {
  if (e.variable !== state.variable) return false;
  return [state.periodA, state.periodB].some((p) => e.year === p.inicio || e.year === p.fin);
});

FrameStore.onReady((e) => {
  if (e.variable === state.variable) scheduleChart();
});

WindStore.onReady(() => markDirty());

// ---------- Cambios de periodo / variable ----------

function readPeriod(select) {
  const y = Number(select.value);
  return { inicio: y, fin: y + 1 };
}

function onPeriodsChanged() {
  state.periodA = readPeriod(ui.periodoA);
  state.periodB = readPeriod(ui.periodoB);
  state.total = Math.max(1, Math.min(mesesPeriodo(state.periodA), mesesPeriodo(state.periodB)));
  state.t = clamp(Math.round(state.t), 0, state.total - 1);
  allViews().forEach((v) => { v.uniforms.uHasData.value = 0; v.wind?.reset(); });
  FrameStore.dropQueued();
  buildTimeline();
  prefetchPeriods();
  updatePresetChips();
  updateHeaders(true);
  scheduleChart();
  saveHash();
  markDirty();
}

function setVariable(v) {
  if (state.variable === v) return;
  state.variable = v;
  setSeg('segVariable', v);
  allViews().forEach((view) => { view.uniforms.uHasData.value = 0; });
  applyStyleUniforms();
  onPeriodsChanged();
}

function setView(v) {
  if (state.view === v) return;
  state.view = v;
  setSeg('segVista', v);
  allViews().forEach((view) => view.wind?.reset());
  setHover(null);
  applyStyleUniforms();
  saveHash();
}

function setPaleta(p) {
  state.paleta = p;
  setSeg('segPaleta', p);
  applyStyleUniforms();
  allViews().forEach((view) => view.wind?.clear());
  saveHash();
}

function setSeg(id, value) {
  document.querySelectorAll(`#${id} button`).forEach((b) => {
    b.classList.toggle('is-on', b.dataset.value === value);
    b.setAttribute('aria-checked', b.dataset.value === value ? 'true' : 'false');
  });
}

function setRegion(name) {
  const r = CONFIG.regions[name];
  if (!r) return;
  if (state.view === 'globe') {
    const dist = r.zoom <= 2.5 ? 3.7 : clamp(3.7 * Math.sqrt(2.5 / r.zoom), 1.9, 3.7);
    lookAtLonLat(r.cx, r.cy, dist);
    allViews().forEach((v) => v.controls.update());
  } else {
    state.win = { ...r };
  }
  ui.region.value = name;
  markDirty();
}

function regionChanged() {
  if (ui.region.value !== 'custom') ui.region.value = 'custom';
  markDirty();
}

// ---------- Tiempo / reproducción ----------

function seek(t, pause = true) {
  if (pause) setPlaying(false);
  state.t = clamp(t, 0, state.total - 1);
  onTimeChanged();
}

function stepMonth(dir) {
  setPlaying(false);
  const cur = state.t;
  let next = dir > 0 ? Math.floor(cur + 1e-6) + 1 : Math.ceil(cur - 1e-6) - 1;
  if (next > state.total - 1) next = 0;
  if (next < 0) next = state.total - 1;
  seek(next);
}

function setPlaying(p) {
  state.playing = p;
  ui.btnPlay.classList.toggle('is-playing', p);
  ui.btnPlay.setAttribute('aria-label', p ? 'Pausar' : 'Reproducir');
}

function advance(dt) {
  let t = state.t + dt * state.speed;
  if (t > state.total - 1) t = 0;

  // Esperar a que el siguiente mes esté descargado (sin saltos).
  const need = Math.min(Math.floor(t) + 1, state.total - 1);
  const ready = (p) => frameFor(p, need, true).status === 'ready';
  if (!ready(state.periodA) || !ready(state.periodB)) {
    t = Math.min(t, Math.floor(t));
    if (t < state.t && state.t <= state.total - 1) t = state.t;
  }

  if (t !== state.t) {
    state.t = t;
    onTimeChanged();
  }
}

let lastMonthIndex = -1;

function onTimeChanged() {
  ui.timeline.value = state.t;
  ui.timeline.style.setProperty('--p', `${(state.t / Math.max(1, state.total - 1)) * 100}%`);
  updateHeaders();
  updateChartCursor();
  updateBadges();
  if (state.hover) renderTooltip();
  markDirty();
}

function updateHeaders(force = false) {
  const i = Math.floor(state.t + 1e-6);
  if (!force && i === lastMonthIndex) return;
  lastMonthIndex = i;
  const fa = etiquetaMes(state.periodA, i);
  const fb = etiquetaMes(state.periodB, i);
  $('fechaA').textContent = fa;
  $('fechaB').textContent = fb;
  $('fechaDiff').textContent = `${fb} − ${fa}`;
  $('roA').textContent = fa;
  $('roB').textContent = fb;
  $('tituloA').textContent = periodTitle(state.periodA);
  $('tituloB').textContent = periodTitle(state.periodB);
}

function periodTitle(p) {
  const ev = CONFIG.eventos[p.inicio];
  return `${p.inicio}–${p.fin}${ev ? ` · ${ev}` : ''}`;
}

function buildTimeline() {
  ui.timeline.max = state.total - 1;
  ui.timeline.value = state.t;
  const n = state.total;
  let html = '';
  for (let i = 0; i < n; i++) {
    const { year, month } = mesDePeriodo(state.periodA, i);
    const left = n > 1 ? (i / (n - 1)) * 100 : 0;
    const isYear = month === 0;
    const label = isYear ? (i === 0 ? 'Año 1' : 'Año 2') : INICIALES[month];
    const q = month % 3 === 0 ? ' q' : '';
    html += `<span class="${isYear ? 'year' : ''}${q}" style="left:${left}%" title="${MESES[month]} ${year}">${label}</span>`;
  }
  ui.ticks.innerHTML = html;
  ui.timeline.style.setProperty('--p', `${(state.t / Math.max(1, n - 1)) * 100}%`);
}

// =============================================================
// ÍNDICE NIÑO 3.4
// =============================================================

function decodeValue(g, variable) {
  if (g === 0) return NaN;
  const [min, max] = variable === 'anomaly'
    ? [state.meta.anomaly_min ?? -5, state.meta.anomaly_max ?? 5]
    : [state.meta.sst_min ?? 0, state.meta.sst_max ?? 45];
  return min + ((g - 1) / 254) * (max - min);
}

function ninoOf(e) {
  if (e.nino !== undefined) return e.nino;
  const b = CONFIG.nino34;
  const c0 = Math.round((b.lon0 / 360) * e.w);
  const c1 = Math.round((b.lon1 / 360) * e.w);
  const r0 = Math.round(((90 - b.lat1) / 180) * (e.h - 1));
  const r1 = Math.round(((90 - b.lat0) / 180) * (e.h - 1));
  let sum = 0;
  let count = 0;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const g = e.data[r * e.w + c];
      if (g) {
        sum += decodeValue(g, e.variable);
        count++;
      }
    }
  }
  e.nino = count ? sum / count : null;
  return e.nino;
}

function seriesFor(period) {
  const out = [];
  for (let i = 0; i < state.total; i++) {
    const { year, month } = mesDePeriodo(period, i);
    const e = FrameStore.peek(state.variable, year, month);
    out.push(e && e.status === 'ready' ? ninoOf(e) : null);
  }
  return out;
}

function valueAtT(series) {
  const { i0, i1, frac } = tiempo();
  const a = series[i0];
  const b = series[i1];
  if (a == null) return null;
  if (b == null) return a;
  return a + (b - a) * frac;
}

// Descripción neutra de la anomalía Niño 3.4 del mes mostrado.
// No es una clasificación oficial de El Niño / La Niña (NOAA usa
// medias de 3 meses, persistencia y otra climatología).
function ensoClass(v) {
  if (v == null || state.variable !== 'anomaly') return null;
  if (v >= 1.5) return ['nino', 'Muy cálido'];
  if (v >= 0.5) return ['nino', 'Cálido'];
  if (v <= -1.5) return ['nina', 'Muy frío'];
  if (v <= -0.5) return ['nina', 'Frío'];
  return ['', 'Cerca de lo normal'];
}

const chartState = { sA: [], sB: [], W: 600, H: 220, pad: { l: 40, r: 14, t: 14, b: 26 }, y0: -3, y1: 3 };
let chartScheduled = false;

function scheduleChart() {
  if (chartScheduled) return;
  chartScheduled = true;
  requestAnimationFrame(() => {
    chartScheduled = false;
    drawChart();
  });
}

function fmt(v, d = 2, signed = true) {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = v.toFixed(d);
  return signed && v > 0 ? `+${s}` : s;
}

function drawChart() {
  const svg = ui.chart;
  const rect = svg.getBoundingClientRect();
  const W = Math.max(200, Math.round(rect.width));
  const H = Math.max(140, Math.round(rect.height));
  const cs = chartState;
  cs.W = W;
  cs.H = H;
  cs.sA = seriesFor(state.periodA);
  cs.sB = seriesFor(state.periodB);

  const anomaly = state.variable === 'anomaly';
  const vals = [...cs.sA, ...cs.sB].filter((v) => v != null);
  if (anomaly) {
    const m = Math.max(2.5, Math.ceil((Math.max(0, ...vals.map(Math.abs)) + 0.3) * 2) / 2);
    cs.y0 = -m;
    cs.y1 = m;
  } else {
    const lo = vals.length ? Math.min(...vals) : 25;
    const hi = vals.length ? Math.max(...vals) : 29;
    cs.y0 = Math.floor(lo - 0.5);
    cs.y1 = Math.ceil(hi + 0.5);
  }

  const { l, r, t, b } = cs.pad;
  const x = (i) => l + (state.total > 1 ? (i / (state.total - 1)) : 0) * (W - l - r);
  const y = (v) => t + (1 - (v - cs.y0) / (cs.y1 - cs.y0)) * (H - t - b);
  cs.x = x;
  cs.y = y;

  let g = '';

  // Bandas El Niño / La Niña
  if (anomaly) {
    g += `<rect x="${l}" y="${t}" width="${W - l - r}" height="${y(0.5) - t}" fill="rgba(240,90,60,0.07)"/>`;
    g += `<rect x="${l}" y="${y(-0.5)}" width="${W - l - r}" height="${H - b - y(-0.5)}" fill="rgba(70,140,255,0.07)"/>`;
    g += `<text class="band-text" x="${W - r - 4}" y="${t + 11}" text-anchor="end" style="fill:#ff9a7a">CÁLIDO ≥ +0.5 °C</text>`;
    g += `<text class="band-text" x="${W - r - 4}" y="${H - b - 5}" text-anchor="end" style="fill:#7cc4ff">FRÍO ≤ −0.5 °C</text>`;
  }

  // Rejilla Y
  const span = cs.y1 - cs.y0;
  const stepY = span > 8 ? 2 : span > 4 ? 1 : 0.5;
  for (let v = Math.ceil(cs.y0 / stepY) * stepY; v <= cs.y1 + 1e-9; v += stepY) {
    const yy = y(v).toFixed(1);
    const isZero = anomaly && Math.abs(v) < 1e-9;
    g += `<line class="${isZero ? 'zero-line' : 'grid-line'}" x1="${l}" x2="${W - r}" y1="${yy}" y2="${yy}"/>`;
    g += `<text x="${l - 6}" y="${yy}" dy="3" text-anchor="end">${anomaly && v > 0 ? '+' : ''}${Number(v.toFixed(1))}</text>`;
  }

  // Eje X
  const every = W < 420 ? 3 : 1;
  for (let i = 0; i < state.total; i++) {
    const { month } = mesDePeriodo(state.periodA, i);
    if (month === 0 && i > 0) {
      g += `<line class="year-sep" x1="${x(i)}" x2="${x(i)}" y1="${t}" y2="${H - b}"/>`;
    }
    if (month % every === 0) {
      g += `<text x="${x(i)}" y="${H - b + 15}" text-anchor="middle">${INICIALES[month]}</text>`;
    }
  }

  // Series
  const path = (s) => {
    let d = '';
    let pen = false;
    s.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  g += `<path class="s-a" d="${path(cs.sA)}" fill="none" stroke-width="2.2" stroke-linejoin="round"/>`;
  g += `<path class="s-b" d="${path(cs.sB)}" fill="none" stroke-width="2.2" stroke-linejoin="round"/>`;
  cs.sA.forEach((v, i) => { if (v != null) g += `<circle class="f-a" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2"/>`; });
  cs.sB.forEach((v, i) => { if (v != null) g += `<circle class="f-b" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2"/>`; });

  // Cursor
  g += `<line id="chCursor" class="cursor" y1="${t}" y2="${H - b}" stroke-width="1"/>`;
  g += `<circle id="chA" class="f-a" r="4.5" stroke="#060a12" stroke-width="2"/>`;
  g += `<circle id="chB" class="f-b" r="4.5" stroke="#060a12" stroke-width="2"/>`;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = g;

  $('chartTitle').textContent = anomaly ? 'Índice Niño 3.4 (anomalía, °C)' : 'SST media Niño 3.4 (°C)';
  $('chartLegA').textContent = `${state.periodA.inicio}–${state.periodA.fin}`;
  $('chartLegB').textContent = `${state.periodB.inicio}–${state.periodB.fin}`;

  updateChartCursor();
  updateBadges();
}

function updateChartCursor() {
  const cs = chartState;
  if (!cs.x) return;
  const cur = $('chCursor');
  if (!cur) return;
  const xx = cs.x(state.t);
  cur.setAttribute('x1', xx);
  cur.setAttribute('x2', xx);
  const place = (id, s) => {
    const c = $(id);
    const v = valueAtT(s);
    if (v == null) { c.setAttribute('visibility', 'hidden'); return; }
    c.setAttribute('visibility', 'visible');
    c.setAttribute('cx', xx);
    c.setAttribute('cy', cs.y(v));
  };
  place('chA', cs.sA);
  place('chB', cs.sB);
}

const badgeCache = {};

function setBadge(id, cls, text) {
  const k = cls + '|' + text;
  if (badgeCache[id] === k) return;
  badgeCache[id] = k;
  const el = $(id);
  el.className = `badge ${cls}`;
  el.textContent = text;
}

function updateBadges() {
  const vA = valueAtT(chartState.sA);
  const vB = valueAtT(chartState.sB);
  const anomaly = state.variable === 'anomaly';
  for (const [id, v] of [['badgeA', vA], ['badgeB', vB]]) {
    if (v == null) { setBadge(id, '', 'Niño 3.4: —'); continue; }
    if (anomaly) {
      const [cls, name] = ensoClass(v);
      setBadge(id, cls, `Niño 3.4 · ${name} ${fmt(v, 1)} °C`);
    } else {
      setBadge(id, '', `Niño 3.4 · ${fmt(v, 1, false)} °C`);
    }
  }
  if (vA != null && vB != null) setBadge('badgeD', 'neutral', `Niño 3.4 · ${fmt(vB - vA, 1)} °C`);
  else setBadge('badgeD', 'neutral', 'Niño 3.4: —');
}

function bindChart() {
  const svg = ui.chart;
  const seekFromEvent = (e) => {
    const cs = chartState;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * cs.W;
    const f = (px - cs.pad.l) / (cs.W - cs.pad.l - cs.pad.r);
    seek(clamp(f, 0, 1) * (state.total - 1));
  };
  svg.addEventListener('pointerdown', (e) => {
    svg.setPointerCapture(e.pointerId);
    seekFromEvent(e);
  });
  svg.addEventListener('pointermove', (e) => {
    if (e.buttons) seekFromEvent(e);
  });
  new ResizeObserver(() => scheduleChart()).observe(svg.parentElement);
}

// =============================================================
// TOOLTIP
// =============================================================

function setHover(view, clientX, clientY) {
  if (!view) {
    if (!state.hover) return;
    state.hover = null;
    allViews().forEach((v) => { v.uniforms.uHover.value.z = 0; });
    ui.tooltip.hidden = true;
    markDirty();
    return;
  }
  const ll = view.lonLatAt(clientX, clientY);
  if (!ll) {
    setHover(null);
    return;
  }
  state.hover = { ...ll, x: clientX, y: clientY };
  allViews().forEach((v) => v.uniforms.uHover.value.set(ll.lon, ll.lat, 1));
  markDirty();
  renderTooltip();
}

function sampleFrame(e, lon, lat) {
  if (!e || e.status !== 'ready') return NaN;
  const c = Math.round((mod(lon, 360) / 360) * e.w) % e.w;
  const r = clamp(Math.round(((90 - lat) / 180) * (e.h - 1)), 0, e.h - 1);
  return decodeValue(e.data[r * e.w + c], e.variable);
}

function valueAt(period, lon, lat) {
  const { i0, i1, frac } = tiempo();
  const a = sampleFrame(frameFor(period, i0, false), lon, lat);
  const b = sampleFrame(frameFor(period, i1, false), lon, lat);
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  return a + (b - a) * frac;
}

function windAt(period, lon, lat) {
  if (!state.wind) return null;
  const s = windSampler(period);
  const out = new Float32Array(2);
  if (!s || !sampleWind(s, lon, lat, out)) return null;
  return { u: out[0], v: out[1], s: Math.hypot(out[0], out[1]) };
}

function windHtml(w) {
  if (!w) return '';
  // Dirección hacia donde sopla (0° = norte, sentido horario).
  const deg = Math.atan2(w.u, w.v) / DEG;
  return `<div class="tt-sub"><span class="tt-arrow" style="transform:rotate(${deg.toFixed(0)}deg)">↑</span>${w.s.toFixed(1)} m/s</div>`;
}

function renderTooltip() {
  const h = state.hover;
  const tip = ui.tooltip;
  if (!h || !state.tooltip) {
    tip.hidden = true;
    return;
  }
  const disp = CONFIG.display[state.variable];
  const vA = valueAt(state.periodA, h.lon, h.lat);
  const vB = valueAt(state.periodB, h.lon, h.lat);
  const wA = windAt(state.periodA, h.lon, h.lat);
  const wB = windAt(state.periodB, h.lon, h.lat);
  const d = vB - vA;
  const lonE = h.lon > 180 ? h.lon - 360 : h.lon;
  const lonTxt = `${Math.abs(lonE).toFixed(1)}°${lonE >= 0 ? 'E' : 'W'}`;
  const latTxt = `${Math.abs(h.lat).toFixed(1)}°${h.lat >= 0 ? 'N' : 'S'}`;
  const i = Math.floor(state.t + 1e-6);
  const level = CONFIG.windLevels[state.windLevel].label;

  const valTxt = (v) => (Number.isFinite(v) ? `${fmt(v, 2, disp.signed)} °C` : 'Tierra / sin dato');

  tip.innerHTML = `
    <div class="tt-coords"><span>Lat <b>${latTxt}</b></span><span>Lon <b>${lonTxt}</b></span></div>
    <div class="tt-grid">
      <div class="tt-col a">
        <div class="tt-head">A · ${etiquetaMes(state.periodA, i)}</div>
        <div class="tt-val">${valTxt(vA)}</div>
        ${windHtml(wA)}
      </div>
      <div class="tt-col b">
        <div class="tt-head">B · ${etiquetaMes(state.periodB, i)}</div>
        <div class="tt-val">${valTxt(vB)}</div>
        ${windHtml(wB)}
      </div>
    </div>
    <div class="tt-diff"><span>${disp.label} B − A</span><b class="${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}">${Number.isFinite(d) ? fmt(d, 2) + ' °C' : '—'}</b></div>
    ${wA && wB ? `<div class="tt-diff"><span>Viento ${level} B − A</span><b>${fmt(wB.s - wA.s, 1)} m/s</b></div>` : ''}
  `;
  tip.hidden = false;

  const m = 12;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = h.x + 16;
  let top = h.y + 16;
  if (left + tw > window.innerWidth - m) left = h.x - tw - 16;
  if (top + th > window.innerHeight - m) top = h.y - th - 16;
  tip.style.left = `${clamp(left, m, window.innerWidth - tw - m)}px`;
  tip.style.top = `${clamp(top, m, window.innerHeight - th - m)}px`;
}

// =============================================================
// LEYENDAS
// =============================================================

function legendHtml(stops, min, max, name, signed) {
  const mid = (min + max) / 2;
  const q1 = (min + mid) / 2;
  const q3 = (mid + max) / 2;
  const f = (v) => `${signed && v > 0 ? '+' : ''}${Number(v.toFixed(1))}`;
  const ticks = [[0, min], [25, q1], [50, mid], [75, q3], [100, max]]
    .map(([p, v]) => `<span style="left:${p}%">${f(v)}</span>`).join('');
  return `
    <div class="legend-scale">
      <span class="legend-name">${name} (°C)</span>
      <div class="legend-bar-wrap">
        <div class="legend-bar" style="background:${cssGradient(stops)}"></div>
        <div class="legend-ticks">${ticks}</div>
      </div>
    </div>`;
}

function renderLegends() {
  const pal = CONFIG.palettes[state.paleta];
  const disp = CONFIG.display[state.variable];
  const lvl = CONFIG.windLevels[state.windLevel];
  const windLegend = state.wind
    ? `<div class="legend-wind">Viento ${lvl.label}
         <div class="legend-bar" style="background:${pal.windBar}"></div>
         0–${lvl.speedMax} m/s</div>`
    : '';
  document.querySelectorAll('[data-legend="main"]').forEach((el) => {
    el.innerHTML = legendHtml(pal[state.variable], disp.min, disp.max, disp.label, disp.signed) + windLegend;
  });
  document.querySelectorAll('[data-legend="diff"]').forEach((el) => {
    el.innerHTML = legendHtml(pal.anomaly, CONFIG.diff.min, CONFIG.diff.max, 'B − A', true);
  });
}

// =============================================================
// CONTROLES DE LA INTERFAZ
// =============================================================

function buildPeriodOptions() {
  const years = Object.keys(state.meta.anios).map(Number).sort((a, b) => a - b);
  ui.periodoA.innerHTML = '';
  ui.periodoB.innerHTML = '';
  for (const y of years) {
    if (!state.meta.anios[String(y + 1)]) continue;
    const ev = CONFIG.eventos[y];
    const text = `${y}–${y + 1}${ev ? `  ·  ${ev}` : ''}`;
    ui.periodoA.add(new Option(text, String(y)));
    ui.periodoB.add(new Option(text, String(y)));
  }
}

function buildPresets() {
  const wrap = $('presets');
  wrap.innerHTML = '';
  for (const p of CONFIG.presets) {
    if (!state.meta.anios[String(p.a + 1)] || !state.meta.anios[String(p.b + 1)]) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = p.label;
    b.dataset.a = p.a;
    b.dataset.b = p.b;
    b.addEventListener('click', () => {
      ui.periodoA.value = String(p.a);
      ui.periodoB.value = String(p.b);
      state.t = 0;
      onPeriodsChanged();
    });
    wrap.appendChild(b);
  }
}

function updatePresetChips() {
  document.querySelectorAll('#presets .chip').forEach((c) => {
    c.classList.toggle('is-active',
      Number(c.dataset.a) === state.periodA.inicio && Number(c.dataset.b) === state.periodB.inicio);
  });
}

function bindUI() {
  ui.periodoA.addEventListener('change', onPeriodsChanged);
  ui.periodoB.addEventListener('change', onPeriodsChanged);

  $('btnSwap').addEventListener('click', () => {
    const a = ui.periodoA.value;
    ui.periodoA.value = ui.periodoB.value;
    ui.periodoB.value = a;
    onPeriodsChanged();
  });

  document.querySelectorAll('#segVariable button').forEach((b) =>
    b.addEventListener('click', () => setVariable(b.dataset.value)));
  document.querySelectorAll('#segVista button').forEach((b) =>
    b.addEventListener('click', () => setView(b.dataset.value)));
  document.querySelectorAll('#segPaleta button').forEach((b) =>
    b.addEventListener('click', () => setPaleta(b.dataset.value)));

  ui.region.addEventListener('change', () => setRegion(ui.region.value));

  ui.mostrarVientos.addEventListener('change', () => {
    state.wind = ui.mostrarVientos.checked;
    ui.nivelViento.disabled = !state.wind;
    if (state.wind) {
      prefetchWind();
      allViews().forEach((v) => v.wind?.reset());
    }
    renderLegends();
    renderTooltip();
    saveHash();
    markDirty();
  });

  ui.nivelViento.addEventListener('change', () => {
    state.windLevel = ui.nivelViento.value;
    prefetchWind();
    allViews().forEach((v) => v.wind?.reset());
    renderLegends();
    saveHash();
    markDirty();
  });

  document.querySelectorAll('[data-toggle]').forEach((b) => {
    b.addEventListener('click', () => {
      const k = b.dataset.toggle;
      state[k] = !state[k];
      b.classList.toggle('is-on', state[k]);
      if (k === 'tooltip') renderTooltip();
      applyStyleUniforms();
    });
  });

  ui.btnPlay.addEventListener('click', () => setPlaying(!state.playing));
  $('btnMesAnterior').addEventListener('click', () => stepMonth(-1));
  $('btnMesSiguiente').addEventListener('click', () => stepMonth(1));
  ui.velocidad.addEventListener('change', () => { state.speed = Number(ui.velocidad.value); });
  ui.timeline.addEventListener('input', () => seek(Number(ui.timeline.value)));

  document.querySelectorAll('.btn-max').forEach((btn) => {
    btn.addEventListener('click', () => {
      const panel = btn.closest('.panel');
      const on = !panel.classList.contains('is-max');
      document.querySelectorAll('.panel.is-max').forEach((p) => p.classList.remove('is-max'));
      panel.classList.toggle('is-max', on);
      btn.title = on ? 'Reducir' : 'Ampliar';
      if (on) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });

  window.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'SELECT' || (tag === 'INPUT' && e.target.type !== 'range') || tag === 'TEXTAREA') return;
    if (e.code === 'Space') {
      e.preventDefault();
      setPlaying(!state.playing);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      stepMonth(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      stepMonth(-1);
    }
  });

  document.addEventListener('pointerdown', (e) => {
    if (!state.hover) return;
    if (e.target.closest('.view')) return;
    setHover(null);
  });

  window.addEventListener('scroll', () => { if (state.hover) setHover(null); }, { passive: true });
}

// ---------- Estado en la URL (para compartir) ----------

function saveHash() {
  const p = new URLSearchParams({
    a: state.periodA.inicio,
    b: state.periodB.inicio,
    v: state.variable,
    vista: state.view,
    viento: state.wind ? state.windLevel : 'no',
    paleta: state.paleta
  });
  history.replaceState(null, '', `#${p}`);
}

function loadHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const has = (y) => y && state.meta.anios[y] && state.meta.anios[String(Number(y) + 1)];
  if (has(p.get('a'))) ui.periodoA.value = p.get('a');
  if (has(p.get('b'))) ui.periodoB.value = p.get('b');
  if (p.get('v') === 'sst' || p.get('v') === 'anomaly') state.variable = p.get('v');
  if (p.get('vista') === 'globe' || p.get('vista') === '2d') state.view = p.get('vista');
  if (p.get('paleta') in CONFIG.palettes) state.paleta = p.get('paleta');
  const w = p.get('viento');
  if (w === 'no') state.wind = false;
  else if (w in CONFIG.windLevels) state.windLevel = w;
}

// =============================================================
// BUCLE DE RENDER
// =============================================================

let lastTime = performance.now();
let statusTimer = 0;

function loop(now) {
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;

  if (state.playing) advance(dt);
  updateTextures();

  if (state.view === 'globe') {
    let moved = false;
    for (const v of allViews()) moved = v.controls.update() || moved;
    if (moved) markDirty();
  }

  for (const v of allViews()) {
    if (!v.visible) continue;
    const animated = v.wind && state.wind;
    if (v.dirty || animated) v.render(dt);
  }

  statusTimer -= dt;
  if (statusTimer <= 0) {
    statusTimer = 0.5;
    const n = FrameStore.pendingCount;
    ui.status.textContent = n ? `Descargando ${n}…` : '';
  }

  requestAnimationFrame(loop);
}

// =============================================================
// INICIO
// =============================================================

async function iniciar() {
  try {
    const res = await fetch(CONFIG.metadataPath);
    if (!res.ok) throw new Error(`metadata.json: HTTP ${res.status}`);
    state.meta = await res.json();

    views = {
      A: new MapView($('viewA'), 'A'),
      B: new MapView($('viewB'), 'B'),
      D: new MapView($('viewD'), 'D')
    };

    buildPeriodOptions();
    ui.periodoA.value = '1982';
    ui.periodoB.value = '1997';
    loadHash();

    setSeg('segVariable', state.variable);
    setSeg('segVista', state.view);
    setSeg('segPaleta', state.paleta);
    ui.mostrarVientos.checked = state.wind;
    ui.nivelViento.value = state.windLevel;
    ui.nivelViento.disabled = !state.wind;

    buildPresets();
    bindUI();
    bindChart();
    applyStyleUniforms();
    setRegion('pacifico');
    onPeriodsChanged();
    onTimeChanged();

    requestAnimationFrame(loop);
    setPlaying(true);
  } catch (err) {
    console.error(err);
    ui.loader.classList.add('is-error');
    ui.loaderText.innerHTML =
      'No se pudo iniciar el visualizador.<br>Revisa <code>data/metadata.json</code> y abre la página mediante un servidor local (por ejemplo <code>python -m http.server</code>).<br>Se necesita un navegador con WebGL2.';
  }
}

iniciar();
