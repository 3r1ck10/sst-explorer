/* =============================================================
   TIPOS DE EL NIÑO · esquemas didácticos
   -------------------------------------------------------------
   Todos los gráficos se generan a partir de data/esquemas/nino.json,
   calculado con scripts/generar_esquemas_nino.py desde los mismos
   datos del visualizador (SST, precipitación, vapor y viento).
   ============================================================= */

'use strict';

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const INI = ['E', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

const TIPOS = {
  oriental: { color: '#ff6b4a', corto: 'Pacífico oriental' },
  costero: { color: '#ffc23d', corto: 'Costero' },
  central: { color: '#b07cff', corto: 'Pacífico central' },
  canonico: { color: '#4fc3f7', corto: 'Canónico / mixto' }
};
const ORDEN = ['oriental', 'costero', 'central', 'canonico'];

const C12 = '#ff8a4c';
const C34 = '#5ad1ff';

// Color de cada mes del año (verano austral cálido, invierno frío).
const COLOR_MES = ['#ff5a4a', '#ff7a3d', '#ffa63d', '#ffd23d', '#9fd36a', '#4fd1b0',
  '#4fb6f0', '#5a8cff', '#7a6cff', '#a66cff', '#d46cd9', '#ff5a8c'];

const UMBRAL = [26, 27]; // °C, umbral aproximado de lluvias en la costa norte

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ok = (v) => v != null && Number.isFinite(v);

function fmt(v, d = 1, signed = true) {
  if (!ok(v)) return '—';
  const s = Math.abs(v).toFixed(d);
  if (v < 0 && Number(s) !== 0) return `−${s}`;
  return signed && v > 0 ? `+${s}` : s;
}

function lin(d0, d1, r0, r1) {
  const f = (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
  f.inv = (p) => d0 + ((p - r0) / (r1 - r0)) * (d1 - d0);
  return f;
}

let D = null;
const estado = { disp: 'nino', campo: 'sst', viento: true, evol: 'nino12_3m' };

// =============================================================
// UTILIDADES
// =============================================================

function idxDe(anio, mes) {
  const [a0, m0] = D.fechas[0];
  const i = (anio - a0) * 12 + (mes - m0);
  return i >= 0 && i < D.fechas.length ? i : -1;
}

function etiqueta(i) {
  const [a, m] = D.fechas[i];
  return `${MESES[m]} ${a}`;
}

function tamSvg(svg) {
  const r = svg.getBoundingClientRect();
  const W = Math.max(280, Math.round(r.width));
  const H = Math.max(160, Math.round(r.height));
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  return { W, H };
}

function estacion(m) {
  if (m === 11 || m <= 1) return 'verano austral';
  if (m <= 4) return 'otoño austral';
  if (m <= 7) return 'invierno austral';
  return 'primavera austral';
}

const tip = {
  el: null,
  show(html, x, y) {
    this.el = this.el || $('tooltip');
    this.el.innerHTML = html;
    this.el.hidden = false;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    let left = x + 14;
    let top = y + 14;
    if (left + w > innerWidth - 10) left = x - w - 14;
    if (top + h > innerHeight - 10) top = y - h - 14;
    this.el.style.left = `${clamp(left, 8, innerWidth - w - 8)}px`;
    this.el.style.top = `${clamp(top, 8, innerHeight - h - 8)}px`;
  },
  hide() {
    if (this.el) this.el.hidden = true;
  }
};

function eventosTipo(tipo, incluirActual = false) {
  return D.eventos.filter((e) => e.tipo === tipo && (incluirActual || !e.enCurso));
}

const promedio = (xs) => {
  const v = xs.filter(ok);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

// =============================================================
// CONTEXTO ACTUAL
// =============================================================

function analogos(ev) {
  const s = D.series;
  const [ya, ma] = D.fechas[D.fechas.length - 1];
  const res = [];
  for (const e of D.eventos) {
    if (e.enCurso) continue;
    let suma = 0;
    let n = 0;
    for (let m = 0; m <= ma; m++) {
      const i = idxDe(ya, m);
      const j = idxDe(e.anio0, m);
      if (i < 0 || j < 0) continue;
      for (const k of ['nino12_3m', 'nino34_3m']) {
        if (ok(s[k][i]) && ok(s[k][j])) {
          suma += (s[k][i] - s[k][j]) ** 2;
          n++;
        }
      }
    }
    if (n) res.push({ ev: e, rmse: Math.sqrt(suma / n) });
  }
  return res.sort((a, b) => a.rmse - b.rmse);
}

function renderActual() {
  const s = D.series;
  const last = D.fechas.length - 1;
  const [ya, ma] = D.fechas[last];
  const ev = D.eventos.find((e) => e.enCurso);
  const mesTxt = `${MESES[ma]} ${ya}`;

  if (!ev) {
    $('actualTitulo').textContent = `Condiciones a ${mesTxt}`;
    $('actualResumen').textContent = 'No hay un evento El Niño en curso según las reglas de esta página.';
  } else {
    const an = analogos(ev).slice(0, 2).map((a) => a.ev.id);
    const sst = s.sst12[last];
    const bajoUmbral = sst < UMBRAL[0];
    const tipoNombre = `tipo «${D.grupos[ev.tipo].nombre}»`;
    $('actualTitulo').textContent = `El Niño ${ev.anio0} (en curso)`;
    $('actualResumen').innerHTML = `
      Desde <b>${ev.inicio}</b> el mar frente a Perú y Ecuador está más cálido de lo normal${ev.inicioCostero
        ? `; el calentamiento <b>empezó en la costa</b> (Niño 1+2) ${ev.adelantoCosta} meses antes que en el Pacífico central` : ''}.
      En ${mesTxt}, Niño 1+2 llega a <b>${fmt(s.nino12_3m[last])} °C</b> y Niño 3.4 a <b>${fmt(s.nino34_3m[last])} °C</b>
      (media de 3 meses): por estos índices se comporta como un evento de <b>${tipoNombre}</b>.
      Su trayectoria se parece a la de <b>${an.join('</b> y <b>')}</b>.
      <br><br>
      Ahora es ${estacion(ma)}: la SST frente a la costa ronda <b>${fmt(sst, 1, false)} °C</b>,
      ${bajoUmbral
        ? `por debajo del umbral de lluvias (≈${UMBRAL[0]}–${UMBRAL[1]} °C). Por eso, a pesar de la gran anomalía, todavía no llueve en la costa norte (anomalía de lluvia: ${fmt(s.lluviaAnom[last])} mm/día). Que haya lluvias intensas dependerá de si el calentamiento persiste en <b>enero–abril</b>, cuando el ciclo estacional acerca el mar al umbral (sección 3).`
        : `por encima del umbral de lluvias (≈${UMBRAL[0]}–${UMBRAL[1]} °C), condición asociada en el pasado a lluvias intensas en la costa norte.`}`;
  }

  const kpis = [
    { l: 'Niño 1+2 (media 3 meses)', v: `${fmt(s.nino12_3m[last])} °C`, sub: `${mesTxt} · mensual ${fmt(s.nino12[last])} °C`, c: s.nino12_3m[last] >= 0.4 },
    { l: 'Niño 3.4 (media 3 meses)', v: `${fmt(s.nino34_3m[last])} °C`, sub: `${mesTxt} · mensual ${fmt(s.nino34[last])} °C`, c: s.nino34_3m[last] >= 0.5 },
    { l: 'Índice E (Pacífico este)', v: fmt(s.E[last], 2), sub: 'adimensional', c: s.E[last] >= 1 },
    { l: 'Índice C (Pacífico central)', v: fmt(s.C[last], 2), sub: 'adimensional', c: s.C[last] >= 1 },
    { l: 'SST absoluta Niño 1+2', v: `${fmt(s.sst12[last], 1, false)} °C`, sub: `normal en ${MESES[ma]}: ${fmt(D.clima.sst12[ma], 1, false)} °C` },
    { l: 'Lluvia costa norte (anomalía)', v: `${fmt(s.lluviaAnom[last])} mm/d`, sub: '4–6°S, 81–80°W · mes actual' }
  ];
  $('actualKpis').innerHTML = kpis.map((k) => `
    <div class="kpi ${k.c ? 'calido' : ''}">
      <div class="kpi-label">${k.l}</div>
      <div class="kpi-valor">${k.v}</div>
      <div class="kpi-sub">${k.sub}</div>
    </div>`).join('');
}

// =============================================================
// 1 · ESQUEMAS DE LOS TIPOS
// =============================================================

function nube(x, y, s = 1, lluvia = true) {
  const c = (dx, dy, r) => `<circle cx="${x + dx * s}" cy="${y + dy * s}" r="${r * s}"/>`;
  let g = `<g fill="#e8eef8" opacity="0.92">${c(-14, 4, 10)}${c(0, -4, 13)}${c(14, 4, 10)}${c(0, 8, 10)}</g>`;
  if (lluvia) {
    g += '<g stroke="#7cc4ff" stroke-width="1.6" stroke-linecap="round" opacity="0.85">';
    for (let k = -2; k <= 2; k++) {
      const xx = x + k * 7 * s;
      g += `<line x1="${xx}" y1="${y + 20 * s}" x2="${xx - 4 * s}" y2="${y + 34 * s}"/>`;
    }
    g += '</g>';
  }
  return g;
}

function flecha(d, color = '#cfd8e6', ancho = 2, dash = '') {
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${ancho}" ${dash ? `stroke-dasharray="${dash}"` : ''} marker-end="url(#fl)"/>`;
}

function esquema(tipo) {
  const W = 320;
  const H = 190;
  const SUP = 96; // superficie del mar
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Esquema ${tipo}">
    <defs>
      <linearGradient id="cielo-${tipo}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0b1424"/><stop offset="1" stop-color="#132036"/>
      </linearGradient>
      <linearGradient id="mar-${tipo}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0d2a4a"/><stop offset="1" stop-color="#06101f"/>
      </linearGradient>
      <radialGradient id="cal-${tipo}"><stop offset="0" stop-color="#ff5a3a" stop-opacity="0.95"/><stop offset="0.6" stop-color="#ff8a4c" stop-opacity="0.55"/><stop offset="1" stop-color="#ff8a4c" stop-opacity="0"/></radialGradient>
      <radialGradient id="tib-${tipo}"><stop offset="0" stop-color="#ffb03d" stop-opacity="0.6"/><stop offset="1" stop-color="#ffb03d" stop-opacity="0"/></radialGradient>
      <radialGradient id="fri-${tipo}"><stop offset="0" stop-color="#3fa2e0" stop-opacity="0.75"/><stop offset="1" stop-color="#3fa2e0" stop-opacity="0"/></radialGradient>
      <marker id="fl" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
        <path d="M0 0L10 5L0 10z" fill="#cfd8e6"/>
      </marker>
    </defs>
    <rect width="${W}" height="${SUP}" fill="url(#cielo-${tipo})"/>
    <rect y="${SUP}" width="${W}" height="${H - SUP}" fill="url(#mar-${tipo})"/>`;

  // Agua cálida / fría
  const blob = (id, cx, rx, ry) => `<ellipse cx="${cx}" cy="${SUP + 4}" rx="${rx}" ry="${ry}" fill="url(#${id}-${tipo})"/>`;
  if (tipo === 'neutral') s += blob('tib', 75, 80, 12) + blob('fri', 255, 60, 9);
  if (tipo === 'oriental') s += blob('cal', 215, 110, 15);
  if (tipo === 'central') s += blob('cal', 155, 62, 12) + blob('fri', 285, 32, 8);
  if (tipo === 'costero') s += blob('tib', 75, 80, 10) + blob('cal', 292, 34, 14);

  // Termoclina
  const termo = {
    neutral: 'M18 170 C 120 160, 220 130, 300 116',
    oriental: 'M18 158 C 120 156, 220 154, 300 150',
    central: 'M18 162 C 110 156, 190 146, 300 122',
    costero: 'M18 170 C 120 160, 230 132, 262 124 S 292 140, 300 142'
  }[tipo];
  s += `<path d="${termo}" fill="none" stroke="#5ad1ff" stroke-width="1.6" stroke-dasharray="5 4" opacity="0.8"/>
        <text x="24" y="${tipo === 'oriental' ? 151 : 182}" class="lbl-sm" style="fill:#5ad1ff">termoclina</text>`;

  // Circulación de Walker y vientos
  if (tipo === 'neutral') {
    s += flecha(`M250 ${SUP - 8} L95 ${SUP - 8}`) + flecha(`M70 ${SUP - 30} L70 30`) +
      flecha(`M95 22 L245 22`) + flecha(`M265 30 L265 ${SUP - 16}`);
    s += `<text x="140" y="${SUP - 13}" class="lbl-sm">alisios</text>`;
    s += nube(70, 46, 0.9);
  }
  if (tipo === 'oriental') {
    s += flecha(`M110 ${SUP - 8} L200 ${SUP - 8}`, '#ffb08a') + flecha(`M210 ${SUP - 30} L210 30`);
    s += `<text x="96" y="${SUP - 13}" class="lbl-sm" style="fill:#ffb08a">alisios débiles / vientos del oeste</text>`;
    s += nube(212, 46, 0.95) + nube(292, 50, 0.7);
  }
  if (tipo === 'central') {
    s += flecha(`M160 ${SUP - 30} L160 30`) + flecha(`M140 22 L70 22`) + flecha(`M180 22 L260 22`) +
      flecha(`M60 30 L60 ${SUP - 16}`) + flecha(`M270 30 L270 ${SUP - 16}`) +
      flecha(`M80 ${SUP - 8} L140 ${SUP - 8}`) + flecha(`M255 ${SUP - 8} L180 ${SUP - 8}`);
    s += nube(160, 46, 0.9);
  }
  if (tipo === 'costero') {
    s += flecha(`M250 ${SUP - 8} L95 ${SUP - 8}`, '#cfd8e6', 1.6, '4 3') + flecha(`M70 ${SUP - 30} L70 30`, '#cfd8e6', 1.6, '4 3');
    s += `<text x="120" y="${SUP - 13}" class="lbl-sm">Pacífico ~normal</text>`;
    s += nube(70, 48, 0.75, true) + nube(292, 48, 0.85);
  }

  // Tierras: Indonesia (oeste) y Sudamérica con los Andes (este)
  s += `<path d="M0 ${SUP - 6} L14 ${SUP - 10} L18 ${H} L0 ${H}z" fill="#2b3240"/>
        <path d="M${W} ${H} L${W} 28 L${W - 8} 44 L${W - 14} 70 L${W - 16} ${SUP - 2} L${W - 18} ${H}z" fill="#2b3240"/>
        <text x="4" y="14" class="lbl-sm">Indonesia</text>
        <text x="${W - 4}" y="14" class="lbl-sm" text-anchor="end">Perú</text>
        <line x1="0" y1="${SUP}" x2="${W}" y2="${SUP}" stroke="#4a7fb0" stroke-width="1"/>`;
  return s + '</svg>';
}

function renderTipos() {
  const c = D.clima.sst12;
  const tarjetas = [
    {
      tipo: 'neutral', color: '#8d9bb3', nombre: 'Condiciones normales',
      ej: 'Referencia',
      texto: 'Agua cálida en el oeste (Indonesia), agua fría frente a Perú por el afloramiento y los alisios. La convección (lluvias) está sobre el Pacífico occidental.',
      datos: [['SST Niño 1+2 en marzo', `${fmt(c[2], 1, false)} °C`], ['en septiembre', `${fmt(c[8], 1, false)} °C`], ['umbral de lluvias', `≈${UMBRAL[0]}–${UMBRAL[1]} °C`]],
      impacto: 'La costa norte solo se acerca al umbral de lluvias en febrero–abril.'
    },
    {
      tipo: 'oriental', nombre: D.grupos.oriental.nombre,
      texto: D.grupos.oriental.resumen + ' La termoclina se profundiza en el este y la convección llega hasta la costa.',
      impacto: 'Lluvias muy intensas en la costa norte en el verano (enero–abril); mar cálido durante más de un año.'
    },
    {
      tipo: 'central', nombre: D.grupos.central.nombre,
      texto: D.grupos.central.resumen + ' La convección se desplaza al Pacífico central y se forman dos celdas de circulación.',
      impacto: 'Poca lluvia extra en la costa norte, salvo que la costa también se caliente en verano (como en el verano de 1992).'
    },
    {
      tipo: 'costero', nombre: D.grupos.costero.nombre,
      texto: D.grupos.costero.resumen + ' Suele responder a cambios locales de vientos y a ondas Kelvin.',
      impacto: 'Si ocurre en verano puede causar lluvias extremas (2017); en otoño–invierno casi no llueve (2008, 2012).'
    }
  ];

  $('tiposGrid').innerHTML = tarjetas.map((t) => {
    const color = t.color || TIPOS[t.tipo].color;
    let datos = t.datos;
    let ej = t.ej;
    if (!datos) {
      const evs = eventosTipo(t.tipo);
      ej = `Eventos: ${evs.map((e) => e.id).join(', ')}`;
      datos = [
        ['máx. Niño 1+2', `${fmt(promedio(evs.map((e) => e.pico12)))} °C`],
        ['máx. Niño 3.4', `${fmt(promedio(evs.map((e) => e.pico34)))} °C`],
        ['lluvia costa norte', `${fmt(promedio(evs.map((e) => e.lluviaMax)))} mm/d`]
      ];
    }
    return `
      <article class="tipo-card" style="--c:${color}">
        ${esquema(t.tipo)}
        <div class="tipo-cuerpo">
          <h3>${t.nombre}</h3>
          <div class="ej">${ej}</div>
          <p>${t.texto}</p>
          <div class="tipo-datos">${datos.map(([l, v]) => `<div><b>${v}</b>${l}</div>`).join('')}</div>
          <div class="tipo-impacto"><strong>Impacto típico en el Perú:</strong>
            <p>${t.impacto}</p></div>
        </div>
      </article>`;
  }).join('');
}

// Mapa de las regiones Niño
function decodeMascara() {
  const bin = atob(D.dominio.mascara);
  const m = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) m[i] = bin.charCodeAt(i);
  return m;
}

function renderMapaRegiones() {
  const cv = $('mapaRegiones');
  const dom = D.dominio;
  const k = 4;
  cv.width = dom.ancho * k;
  cv.height = dom.alto * k;
  const ctx = cv.getContext('2d');
  const masc = decodeMascara();
  ctx.fillStyle = '#0f1a2b';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#3a4252';
  for (let j = 0; j < dom.alto; j++) {
    for (let i = 0; i < dom.ancho; i++) {
      if (!masc[j * dom.ancho + i]) ctx.fillRect(i * k, j * k, k, k);
    }
  }
  const X = (lon) => (lon - dom.lonO + 0.5) * k;
  const Y = (lat) => (dom.latN - lat + 0.5) * k;

  // Ecuador y retícula
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  for (let lon = 140; lon <= 280; lon += 20) {
    ctx.beginPath();
    ctx.moveTo(X(lon), 0);
    ctx.lineTo(X(lon), cv.height);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.beginPath();
  ctx.moveTo(0, Y(0));
  ctx.lineTo(cv.width, Y(0));
  ctx.stroke();

  const cajas = [
    ['nino4', '#b07cff', 'Niño 4'], ['nino3', '#ffc23d', 'Niño 3'],
    ['nino34', '#5ad1ff', 'Niño 3.4'], ['nino12', '#ff8a4c', 'Niño 1+2'],
    ['costa_norte', '#ffffff', 'Costa norte']
  ];
  ctx.font = '600 12px Inter, sans-serif';
  cajas.forEach(([id, color, nombre], n) => {
    const [la0, la1, lo0, lo1] = D.cajas[id];
    const x0 = X(lo0) - k / 2;
    const x1 = X(lo1) + k / 2;
    const y0 = Y(Math.max(la0, la1)) - k / 2;
    const y1 = Y(Math.min(la0, la1)) + k / 2;
    ctx.strokeStyle = color;
    ctx.lineWidth = id === 'nino34' || id === 'nino12' ? 2.5 : 1.5;
    if (id === 'costa_norte') ctx.setLineDash([3, 2]);
    ctx.strokeRect(x0 + n % 2, y0 + n % 2, x1 - x0, y1 - y0);
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    // Posición de cada etiqueta para que no se encimen.
    if (id === 'costa_norte') {
      // Etiqueta abajo a la derecha, con una línea guía hasta la caja.
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo((x0 + x1) / 2, y1);
      ctx.lineTo(cv.width - 50, Y(-17) - 12);
      ctx.stroke();
    }
    const pos = {
      nino12: [x0 - 4, y1 + 16, 'right'],
      costa_norte: [cv.width - 6, Y(-17), 'right'],
      nino3: [x0 + 3, y1 + 16, 'left'],
      nino34: [x0 + 3, y0 - 6, 'left'],
      nino4: [x0 + 3, y0 - 6, 'left']
    }[id];
    ctx.textAlign = pos[2];
    ctx.fillText(nombre, pos[0], pos[1]);
    ctx.textAlign = 'left';
  });

  ctx.fillStyle = 'rgba(233,240,251,0.6)';
  ctx.font = '11px JetBrains Mono, monospace';
  for (let lon = 140; lon <= 280; lon += 40) {
    const t = lon <= 180 ? `${lon}°E` : `${360 - lon}°W`;
    ctx.fillText(t, X(lon) + 3, cv.height - 6);
  }
  ctx.fillText('Ecuador', 6, Y(0) - 4);
}

// =============================================================
// 2 · CLASIFICACIÓN
// =============================================================

function renderDispersion() {
  const svg = $('dispersion');
  const { W, H } = tamSvg(svg);
  const pad = { l: 52, r: 18, t: 16, b: 44 };
  const s = D.series;
  const modoNino = estado.disp === 'nino';
  const evs = D.eventos.filter((e) => !e.enCurso);
  const actual = D.eventos.find((e) => e.enCurso);

  const px = (e) => (modoNino ? e.pico34 : e.C);
  const py = (e) => (modoNino ? e.pico12 : e.E);
  const tray = [];
  if (actual) {
    for (let i = actual.iInicio; i <= actual.iFin; i++) {
      tray.push({ i, x: modoNino ? s.nino34_3m[i] : s.C[i], y: modoNino ? s.nino12_3m[i] : s.E[i] });
    }
  }

  let x0; let x1; let y0; let y1;
  if (modoNino) {
    [x0, x1, y0, y1] = [-0.6, 3.2, -0.4, 4.9];
  } else {
    const xs = evs.map(px).concat(tray.map((t) => t.x));
    const ys = evs.map(py).concat(tray.map((t) => t.y));
    x0 = Math.floor(Math.min(0, ...xs) - 0.5);
    x1 = Math.ceil(Math.max(...xs) + 0.5);
    y0 = Math.floor(Math.min(0, ...ys) - 0.5);
    y1 = Math.ceil(Math.max(...ys) + 0.5);
  }
  const X = lin(x0, x1, pad.l, W - pad.r);
  const Y = lin(y0, y1, H - pad.b, pad.t);

  let g = '';
  for (let v = Math.ceil(x0); v <= x1; v++) {
    g += `<line class="${v === 0 ? 'eje' : 'grid-line'}" x1="${X(v)}" x2="${X(v)}" y1="${pad.t}" y2="${H - pad.b}"/>`;
    g += `<text x="${X(v)}" y="${H - pad.b + 16}" text-anchor="middle">${fmt(v, 0)}</text>`;
  }
  for (let v = Math.ceil(y0); v <= y1; v++) {
    g += `<line class="${v === 0 ? 'eje' : 'grid-line'}" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/>`;
    g += `<text x="${pad.l - 8}" y="${Y(v) + 3}" text-anchor="end">${fmt(v, 0)}</text>`;
  }
  g += `<text class="lbl-sm" x="${(pad.l + W - pad.r) / 2}" y="${H - 8}" text-anchor="middle">${modoNino ? 'Máximo de Niño 3.4 (°C) — Pacífico central-este →' : 'Índice C (Pacífico central) →'}</text>`;
  g += `<text class="lbl-sm" transform="translate(14 ${(pad.t + H - pad.b) / 2}) rotate(-90)" text-anchor="middle">${modoNino ? 'Máximo de Niño 1+2 (°C) — costa →' : 'Índice E (Pacífico este) →'}</text>`;

  if (modoNino) {
    // Guías de las reglas de clasificación
    g += `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(3.2)}" y2="${Y(3.2)}" stroke="rgba(255,255,255,0.25)" stroke-dasharray="4 4"/>`;
    g += `<text class="lbl-sm" x="${X(2.55)}" y="${Y(2.65)}" transform="rotate(-38 ${X(2.55)} ${Y(2.65)})">Niño 1+2 = Niño 3.4</text>`;
    g += `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(3.2)}" y2="${Y(0.6 * 3.2)}" stroke="${TIPOS.central.color}" stroke-opacity="0.45" stroke-dasharray="2 4"/>`;
    g += `<text class="lbl-sm" x="${X(2.6)}" y="${Y(0.6 * 2.6) + 14}" style="fill:${TIPOS.central.color}">Pacífico central ↓</text>`;
    g += `<line x1="${X(0)}" x2="${X(3.2)}" y1="${Y(3)}" y2="${Y(3)}" stroke="${TIPOS.oriental.color}" stroke-opacity="0.45" stroke-dasharray="2 4"/>`;
    g += `<text class="lbl-sm" x="${X(-0.5)}" y="${Y(3) - 6}" style="fill:${TIPOS.oriental.color}">Pacífico oriental fuerte ↑ (Niño 1+2 ≥ 3 °C)</text>`;
    g += `<line x1="${X(0.5)}" x2="${X(0.5)}" y1="${pad.t}" y2="${H - pad.b}" stroke="${TIPOS.costero.color}" stroke-opacity="0.4" stroke-dasharray="2 4"/>`;
    g += `<text class="lbl-sm" x="${X(0.47)}" y="${Y(4.6)}" text-anchor="end" style="fill:${TIPOS.costero.color}">← Costero (Niño 3.4 &lt; 0.5)</text>`;
  }

  // Trayectoria del evento en curso
  if (tray.length) {
    const d = tray.filter((t) => ok(t.x) && ok(t.y)).map((t, k) => `${k ? 'L' : 'M'}${X(t.x).toFixed(1)},${Y(t.y).toFixed(1)}`).join('');
    g += `<path d="${d}" fill="none" stroke="#fff" stroke-width="1.6" stroke-dasharray="4 3" opacity="0.8"/>`;
    tray.forEach((t, k) => {
      if (!ok(t.x) || !ok(t.y)) return;
      const ultimo = k === tray.length - 1;
      const [, m] = D.fechas[t.i];
      g += `<circle cx="${X(t.x)}" cy="${Y(t.y)}" r="${ultimo ? 7 : 3}" fill="${ultimo ? '#fff' : '#06101f'}" stroke="#fff" stroke-width="1.5" data-tray="${t.i}"/>`;
      g += ultimo
        ? `<text x="${X(t.x) + 10}" y="${Y(t.y) + 18}" style="fill:#fff;font-size:11px;font-weight:700">${actual.anio0} (${MESES[m]})</text>`
        : `<text x="${X(t.x) - 6}" y="${Y(t.y) - 5}" text-anchor="end" style="fill:#fff;font-size:9px;opacity:0.8">${INI[m]}</text>`;
    });
  }

  // Eventos (las etiquetas se colocan donde haya menos superposición)
  const usados = [];
  evs.forEach((e, n) => {
    const cx = X(px(e));
    const cy = Y(py(e));
    g += `<circle cx="${cx}" cy="${cy}" r="7" fill="${TIPOS[e.tipo].color}" fill-opacity="0.85" stroke="#06101f" stroke-width="1.5" data-ev="${n}" style="cursor:pointer"/>`;
    const opciones = [[10, -6, 'start'], [10, 14, 'start'], [-10, -6, 'end'], [-10, 14, 'end']];
    const choque = ([dx, dy, a]) => {
      const x = a === 'start' ? cx + dx : cx + dx - 46;
      const y = cy + dy;
      return usados.some((u) => Math.abs(u.x - x) < 46 && Math.abs(u.y - y) < 12) ||
        (tray.length && tray.some((t) => ok(t.x) && Math.abs(X(t.x) - (x + 23)) < 30 && Math.abs(Y(t.y) - y) < 10));
    };
    const [dx, dy, anchor] = opciones.find((o) => !choque(o)) || opciones[0];
    usados.push({ x: anchor === 'start' ? cx + dx : cx + dx - 46, y: cy + dy });
    g += `<text x="${cx + dx}" y="${cy + dy}" text-anchor="${anchor}" style="fill:${TIPOS[e.tipo].color};font-size:10.5px;font-weight:600">${e.id}</text>`;
  });

  svg.innerHTML = g;

  svg.onmousemove = (ev) => {
    const t = ev.target;
    if (t.dataset.ev !== undefined) {
      const e = evs[Number(t.dataset.ev)];
      tip.show(`<b>${e.id}</b> · <span style="color:${TIPOS[e.tipo].color}">${D.grupos[e.tipo].nombre}</span><br>
        ${e.inicio} – ${e.fin}<br>
        Máx. Niño 1+2: <b>${fmt(e.pico12)} °C</b> (${e.mesPico12})<br>
        Máx. Niño 3.4: <b>${fmt(e.pico34)} °C</b> (${e.mesPico34})<br>
        E máx: ${fmt(e.E, 2)} · C máx: ${fmt(e.C, 2)}`, ev.clientX, ev.clientY);
    } else if (t.dataset.tray !== undefined) {
      const i = Number(t.dataset.tray);
      tip.show(`<b>${etiqueta(i)}</b> (en curso)<br>Niño 1+2: ${fmt(s.nino12_3m[i])} °C · Niño 3.4: ${fmt(s.nino34_3m[i])} °C<br>E: ${fmt(s.E[i], 2)} · C: ${fmt(s.C[i], 2)}`, ev.clientX, ev.clientY);
    } else {
      tip.hide();
    }
  };
  svg.onmouseleave = () => tip.hide();

  $('dispTitulo').textContent = modoNino
    ? 'Niño 3.4 vs Niño 1+2 (máximos del evento, media 3 meses)'
    : 'Índices E y C (máximos del evento) · Takahashi et al. (2011)';
}

function renderGrupos() {
  const actual = D.eventos.find((e) => e.enCurso);
  $('gruposLeyenda').innerHTML = `
    <div class="panel-head"><div class="panel-title"><h2>Grupos</h2>
      <span class="panel-date">Reglas en la sección «Método»</span></div></div>
    ${ORDEN.map((g) => {
      const miembros = eventosTipo(g).map((e) => e.id);
      if (actual && actual.tipo === g) miembros.push(`${actual.anio0} (en curso)`);
      return `
        <div class="grupo-item" style="--c:${TIPOS[g].color}">
          <i></i>
          <div>
            <h4>${D.grupos[g].nombre}</h4>
            <p>${D.grupos[g].resumen}</p>
            <div class="miembros">${miembros.join(' · ')}</div>
          </div>
        </div>`;
    }).join('')}`;
}

function renderLineaTiempo() {
  const svg = $('lineaTiempo');
  const { W, H } = tamSvg(svg);
  const pad = { l: 40, r: 12, t: 12, b: 26 };
  const s = D.series;
  const n = D.fechas.length;
  const X = lin(0, n - 1, pad.l, W - pad.r);
  const Y = lin(-2.5, 4.8, H - pad.b, pad.t);

  let g = '';
  for (const e of D.eventos) {
    g += `<rect x="${X(e.iInicio)}" y="${pad.t}" width="${Math.max(2, X(e.iFin) - X(e.iInicio))}" height="${H - pad.b - pad.t}" fill="${TIPOS[e.tipo].color}" opacity="0.14"/>`;
    g += `<text x="${X(e.iInicio) + 2}" y="${pad.t + 10}" style="fill:${TIPOS[e.tipo].color};font-size:9px">${e.id}</text>`;
  }
  for (let v = -2; v <= 4; v++) {
    g += `<line class="${v === 0 ? 'eje' : 'grid-line'}" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/>`;
    g += `<text x="${pad.l - 6}" y="${Y(v) + 3}" text-anchor="end">${fmt(v, 0)}</text>`;
  }
  const paso = W < 700 ? 6 : 4;
  for (let i = 0; i < n; i++) {
    const [a, m] = D.fechas[i];
    if (m === 0 && a % paso === 0) {
      g += `<text x="${X(i)}" y="${H - 8}" text-anchor="middle">${a}</text>`;
    }
  }
  const linea = (serie, color) => {
    let d = '';
    serie.forEach((v, i) => {
      if (ok(v)) d += `${d && ok(serie[i - 1]) ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
    });
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"/>`;
  };
  g += linea(s.nino34_3m, C34) + linea(s.nino12_3m, C12);
  g += `<line id="ltCursor" y1="${pad.t}" y2="${H - pad.b}" stroke="rgba(255,255,255,0.5)" visibility="hidden"/>`;
  svg.innerHTML = g;

  svg.onmousemove = (ev) => {
    const r = svg.getBoundingClientRect();
    const i = clamp(Math.round(X.inv(((ev.clientX - r.left) / r.width) * W)), 0, n - 1);
    const cur = $('ltCursor');
    cur.setAttribute('x1', X(i));
    cur.setAttribute('x2', X(i));
    cur.setAttribute('visibility', 'visible');
    const evt = D.eventos.find((e) => i >= e.iInicio && i <= e.iFin);
    tip.show(`<b>${etiqueta(i)}</b>${evt ? ` · <span style="color:${TIPOS[evt.tipo].color}">${evt.id}</span>` : ''}<br>
      <span style="color:${C12}">Niño 1+2</span>: ${fmt(s.nino12_3m[i])} °C<br>
      <span style="color:${C34}">Niño 3.4</span>: ${fmt(s.nino34_3m[i])} °C`, ev.clientX, ev.clientY);
  };
  svg.onmouseleave = () => {
    tip.hide();
    $('ltCursor')?.setAttribute('visibility', 'hidden');
  };
}

function renderTabla() {
  $('tablaEventos').querySelector('tbody').innerHTML = D.eventos.map((e) => `
    <tr class="${e.enCurso ? 'en-curso' : ''}">
      <td><b>${e.id}</b>${e.enCurso ? ' <small>(en curso)</small>' : ''}</td>
      <td><span class="tag-tipo" style="--c:${TIPOS[e.tipo].color}">${TIPOS[e.tipo].corto}</span></td>
      <td>${e.inicio} – ${e.fin}</td>
      <td class="num">${fmt(e.pico12)} °C <small>(${e.mesPico12})</small></td>
      <td class="num">${fmt(e.pico34)} °C <small>(${e.mesPico34})</small></td>
      <td>${e.tipo === 'costero' ? 'solo costa' : e.inicioCostero ? `sí, ${e.adelantoCosta} meses antes` : 'no'}</td>
      <td class="num">${fmt(e.lluviaMax)} mm/d <small>(${e.mesLluviaMax})</small></td>
    </tr>`).join('');
}

// =============================================================
// 3 · DEPENDE DEL MES
// =============================================================

function renderCicloAnual() {
  const svg = $('cicloAnual');
  const { W, H } = tamSvg(svg);
  const pad = { l: 40, r: 48, t: 14, b: 28 };
  const X = lin(0, 11, pad.l, W - pad.r);
  const Y = lin(18, 30, H - pad.b, pad.t);
  const c = D.clima.sst12;
  const s = D.series;
  const last = D.fechas.length - 1;
  const [ya, ma] = D.fechas[last];

  let g = '';
  // Temporada de lluvias (ene–abr)
  g += `<rect x="${X(-0.4)}" y="${pad.t}" width="${X(3.4) - X(-0.4)}" height="${H - pad.b - pad.t}" fill="rgba(124,196,255,0.07)"/>`;
  g += `<text class="lbl-sm" x="${X(1.5)}" y="${pad.t + 12}" text-anchor="middle" style="fill:#7cc4ff">temporada de lluvias</text>`;
  // Umbral
  g += `<rect x="${pad.l}" y="${Y(UMBRAL[1])}" width="${W - pad.l - pad.r}" height="${Y(UMBRAL[0]) - Y(UMBRAL[1])}" fill="rgba(255,90,70,0.16)"/>`;
  g += `<text class="lbl-sm" x="${W - pad.r - 4}" y="${Y(UMBRAL[1]) - 4}" text-anchor="end" style="fill:#ff9a7a">umbral de lluvias ≈${UMBRAL[0]}–${UMBRAL[1]} °C</text>`;
  for (let v = 18; v <= 30; v += 2) {
    g += `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/>`;
    g += `<text x="${pad.l - 6}" y="${Y(v) + 3}" text-anchor="end">${v}</text>`;
  }
  for (let m = 0; m < 12; m++) g += `<text x="${X(m)}" y="${H - 9}" text-anchor="middle">${MESES[m]}</text>`;

  const path = (off) => c.map((v, m) => `${m ? 'L' : 'M'}${X(m).toFixed(1)},${Y(v + off).toFixed(1)}`).join('');
  [3, 2, 1].forEach((off) => {
    g += `<path d="${path(off)}" fill="none" stroke="#ff8a4c" stroke-opacity="${0.25 + off * 0.12}" stroke-width="1.3" stroke-dasharray="5 4"/>`;
    g += `<text x="${X(11) + 6}" y="${Y(c[11] + off) + 3}" style="fill:#ff8a4c">+${off} °C</text>`;
  });
  g += `<path d="${path(0)}" fill="none" stroke="#e9f0fb" stroke-width="2.4"/>`;
  g += `<text x="${X(11) + 6}" y="${Y(c[11]) + 3}" style="fill:#e9f0fb">normal</text>`;

  // Año en curso
  const pts = [];
  for (let m = 0; m <= ma; m++) {
    const i = idxDe(ya, m);
    if (i >= 0 && ok(s.sst12[i])) pts.push([m, s.sst12[i]]);
  }
  if (pts.length) {
    g += `<path d="${pts.map(([m, v], k) => `${k ? 'L' : 'M'}${X(m)},${Y(v)}`).join('')}" fill="none" stroke="#fff" stroke-width="1.8" stroke-dasharray="2 3"/>`;
    pts.forEach(([m, v]) => { g += `<circle cx="${X(m)}" cy="${Y(v)}" r="3.5" fill="#fff"/>`; });
    const [mu, vu] = pts[pts.length - 1];
    g += `<text x="${X(mu) + 8}" y="${Y(vu) - 6}" style="fill:#fff;font-size:11px;font-weight:600">${ya}</text>`;
  }
  svg.innerHTML = g;

  const conDos = c.map((v, m) => (v + 2 >= UMBRAL[0] ? MESES[m] : null)).filter(Boolean);
  $('cicloNota').innerHTML = `Con una anomalía de +2 °C, el mar frente a la costa supera ${UMBRAL[0]} °C solo en
    <b>${conDos.join(', ')}</b>. En ${MESES[ma]} ${ya} la SST de Niño 1+2 es ${fmt(s.sst12[last], 1, false)} °C
    (anomalía ${fmt(s.nino12[last])} °C): una anomalía muy grande, pero el mar sigue bajo el umbral porque es
    ${estacion(ma)}. La línea blanca muestra ${ya} mes a mes.`;
}

function renderUmbral() {
  const svg = $('umbral');
  const { W, H } = tamSvg(svg);
  const pad = { l: 40, r: 14, t: 14, b: 32 };
  const X = lin(18, 30, pad.l, W - pad.r);
  const Y = lin(0, 24, H - pad.b, pad.t);
  const s = D.series;
  const n = D.fechas.length;
  const ya = D.fechas[n - 1][0];

  let g = `<rect x="${X(UMBRAL[0])}" y="${pad.t}" width="${X(UMBRAL[1]) - X(UMBRAL[0])}" height="${H - pad.b - pad.t}" fill="rgba(255,90,70,0.14)"/>`;
  g += `<text class="lbl-sm" x="${X(UMBRAL[0]) - 4}" y="${pad.t + 12}" text-anchor="end" style="fill:#ff9a7a">umbral →</text>`;
  for (let v = 18; v <= 30; v += 2) {
    g += `<line class="grid-line" x1="${X(v)}" x2="${X(v)}" y1="${pad.t}" y2="${H - pad.b}"/>`;
    g += `<text x="${X(v)}" y="${H - pad.b + 14}" text-anchor="middle">${v}</text>`;
  }
  for (let v = 0; v <= 24; v += 4) {
    g += `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/>`;
    g += `<text x="${pad.l - 6}" y="${Y(v) + 3}" text-anchor="end">${v}</text>`;
  }
  g += `<text class="lbl-sm" x="${(pad.l + W) / 2}" y="${H - 4}" text-anchor="middle">SST absoluta en Niño 1+2 (°C)</text>`;
  g += `<text class="lbl-sm" transform="translate(12 ${(H - pad.b) / 2}) rotate(-90)" text-anchor="middle">Lluvia costa norte (mm/día)</text>`;

  for (let i = 0; i < n; i++) {
    const x = s.sst12[i];
    const y = s.lluvia[i];
    if (!ok(x) || !ok(y)) continue;
    const [a, m] = D.fechas[i];
    const actual = a === ya;
    g += `<circle cx="${X(x).toFixed(1)}" cy="${Y(Math.min(y, 24)).toFixed(1)}" r="${actual ? 4 : 2.8}" fill="${COLOR_MES[m]}" fill-opacity="${actual ? 1 : 0.7}" ${actual ? 'stroke="#fff" stroke-width="1.5"' : ''} data-i="${i}"/>`;
  }
  // Etiquetas de los meses más lluviosos
  const top = [...Array(n).keys()].filter((i) => ok(s.lluvia[i])).sort((a, b) => s.lluvia[b] - s.lluvia[a]).slice(0, 5);
  top.forEach((i, k) => {
    g += `<text x="${X(s.sst12[i]) - 8}" y="${Y(Math.min(s.lluvia[i], 24)) + (k % 2 ? 12 : -6)}" text-anchor="end" style="fill:#e9f0fb;font-size:10px">${etiqueta(i)}</text>`;
  });
  svg.innerHTML = g;

  svg.onmousemove = (ev) => {
    const i = ev.target.dataset.i;
    if (i === undefined) { tip.hide(); return; }
    tip.show(`<b>${etiqueta(Number(i))}</b><br>SST Niño 1+2: ${fmt(s.sst12[i], 1, false)} °C (anom. ${fmt(s.nino12[i])})<br>
      Lluvia costa norte (4–6°S, 81–80°W): ${fmt(s.lluvia[i], 1, false)} mm/día (anom. ${fmt(s.lluviaAnom[i])})`, ev.clientX, ev.clientY);
  };
  svg.onmouseleave = () => tip.hide();

  $('mesesLeyenda').innerHTML = MESES.map((m, k) => `<span><i style="background:${COLOR_MES[k]}"></i>${m}</span>`).join('') +
    `<span><i style="background:#fff;box-shadow:0 0 0 1.5px #fff"></i>${ya}</span>`;
}

function renderBarras() {
  const svg = $('barrasMes');
  const { W, H } = tamSvg(svg);
  const pad = { l: 40, r: 14, t: 22, b: 26 };
  const s = D.series;
  const datos = MESES.map((_, m) => {
    const vals = [];
    D.fechas.forEach(([, mm], i) => {
      if (mm === m && ok(s.nino12[i]) && s.nino12[i] >= 2 && ok(s.lluviaAnom[i])) vals.push(s.lluviaAnom[i]);
    });
    return { n: vals.length, v: promedio(vals) };
  });
  const vmax = Math.max(4, ...datos.map((d) => d.v || 0)) * 1.15;
  const X = lin(0, 12, pad.l, W - pad.r);
  const Y = lin(Math.min(0, ...datos.map((d) => d.v || 0)), vmax, H - pad.b, pad.t);
  const bw = (X(1) - X(0)) * 0.62;

  let g = '';
  for (let v = 0; v <= vmax; v += 4) {
    g += `<line class="${v === 0 ? 'eje' : 'grid-line'}" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/>`;
    g += `<text x="${pad.l - 6}" y="${Y(v) + 3}" text-anchor="end">${v}</text>`;
  }
  datos.forEach((d, m) => {
    const cx = X(m + 0.5);
    g += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${MESES[m]}</text>`;
    if (!d.n) {
      g += `<text x="${cx}" y="${Y(0) - 6}" text-anchor="middle" style="font-size:9px">sin casos</text>`;
      return;
    }
    const y = Y(Math.max(0, d.v));
    const h = Math.abs(Y(d.v) - Y(0));
    g += `<rect x="${cx - bw / 2}" y="${y}" width="${bw}" height="${Math.max(1, h)}" rx="3" fill="${COLOR_MES[m]}" fill-opacity="0.85"/>`;
    g += `<text x="${cx}" y="${y - 5}" text-anchor="middle" style="fill:#e9f0fb;font-size:10.5px;font-weight:600">${fmt(d.v)}</text>`;
    g += `<text x="${cx}" y="${Y(0) + 0}" dy="-${h + 18}" text-anchor="middle" style="font-size:8.5px">n=${d.n}</text>`;
  });
  svg.innerHTML = g;
}

// =============================================================
// 4 · HUELLAS (mapas compuestos)
// =============================================================

const PALETAS = {
  sst: { stops: ['#d6f1ff', '#74c6f2', '#2f8bd3', '#1f4f93', '#151b27', '#93302a', '#d24a2a', '#f39237', '#ffe7a0'], max: 3, nombre: 'Anomalía de SST', unidad: '°C' },
  precip: { stops: ['#5c3208', '#a8641e', '#d4a35a', '#2a2a26', '#151b27', '#1d3c6e', '#2f7bff', '#5aa7ff', '#bfe0ff'], max: 6, nombre: 'Anomalía de precipitación', unidad: 'mm/día' },
  vapor: { stops: ['#8c7400', '#b99b0a', '#d9c255', '#3a3622', '#151b27', '#4a505c', '#9aa1ad', '#d6dae1', '#ffffff'], max: 6, nombre: 'Anomalía de vapor de agua', unidad: 'kg/m²' }
};

function hexRgb(h) {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const lutCache = {};

function lut(campo) {
  if (lutCache[campo]) return lutCache[campo];
  const rgb = PALETAS[campo].stops.map(hexRgb);
  const out = [];
  for (let i = 0; i < 256; i++) {
    const p = (i / 255) * (rgb.length - 1);
    const j = Math.min(Math.floor(p), rgb.length - 2);
    const f = p - j;
    out.push(rgb[j].map((c, k) => Math.round(c + (rgb[j + 1][k] - c) * f)));
  }
  lutCache[campo] = out;
  return out;
}

const decodeCache = new Map();

function decode(b64, escala) {
  const clave = b64.slice(0, 32) + b64.length + escala;
  if (decodeCache.has(clave)) return decodeCache.get(clave);
  const bin = atob(b64);
  const out = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    let c = bin.charCodeAt(i);
    if (c > 127) c -= 256;
    out[i] = c === -128 ? NaN : c * escala;
  }
  decodeCache.set(clave, out);
  return out;
}

let mascaraCanvas = null;

function canvasMascara() {
  if (mascaraCanvas) return mascaraCanvas;
  const dom = D.dominio;
  const m = decodeMascara();
  const c = document.createElement('canvas');
  c.width = dom.ancho;
  c.height = dom.alto;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(dom.ancho, dom.alto);
  for (let i = 0; i < m.length; i++) {
    if (!m[i]) {
      img.data[i * 4] = 58;
      img.data[i * 4 + 1] = 66;
      img.data[i * 4 + 2] = 82;
      img.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  mascaraCanvas = c;
  return c;
}

function dibujarMapa(canvas, comp) {
  const dom = D.dominio;
  const campo = estado.campo;
  const pal = PALETAS[campo];
  const L = lut(campo);
  const vals = decode(comp[campo], dom.escalas[campo]);

  // Imagen del campo a resolución de los datos (1°)
  const base = document.createElement('canvas');
  base.width = dom.ancho;
  base.height = dom.alto;
  const bctx = base.getContext('2d');
  const img = bctx.createImageData(dom.ancho, dom.alto);
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    const o = i * 4;
    if (!Number.isFinite(v)) {
      img.data[o] = 58; img.data[o + 1] = 66; img.data[o + 2] = 82; img.data[o + 3] = 255;
      continue;
    }
    const k = clamp(Math.round(((v / pal.max) * 0.5 + 0.5) * 255), 0, 255);
    img.data[o] = L[k][0]; img.data[o + 1] = L[k][1]; img.data[o + 2] = L[k][2]; img.data[o + 3] = 255;
  }
  bctx.putImageData(img, 0, 0);

  // Escalado suave al tamaño de la celda
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(200, Math.round(canvas.clientWidth * dpr));
  const h = Math.round((w * dom.alto) / dom.ancho);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(base, 0, 0, w, h);

  // Tierra: opaca para SST; semitransparente para lluvia y vapor (hay datos sobre tierra)
  ctx.globalAlpha = campo === 'sst' ? 1 : 0.35;
  ctx.drawImage(canvasMascara(), 0, 0, w, h);
  ctx.globalAlpha = 1;

  const k = w / dom.ancho;
  const X = (lon) => (lon - dom.lonO + 0.5) * k;
  const Y = (lat) => (dom.latN - lat + 0.5) * k;

  // Ecuador y cajas
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = dpr;
  ctx.beginPath();
  ctx.moveTo(0, Y(0));
  ctx.lineTo(w, Y(0));
  ctx.stroke();
  for (const [id, color] of [['nino34', 'rgba(90,209,255,0.75)'], ['nino12', 'rgba(255,138,76,0.85)']]) {
    const [la0, la1, lo0, lo1] = D.cajas[id];
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2 * dpr;
    ctx.strokeRect(X(lo0) - k / 2, Y(Math.max(la0, la1)) - k / 2, (lo1 - lo0 + 1) * k, (Math.abs(la1 - la0) + 1) * k);
  }

  // Anomalía de viento
  if (estado.viento) {
    const u = decode(comp.u, dom.escalas.u);
    const v = decode(comp.v, dom.escalas.v);
    const { lat, lon } = dom.viento;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.1 * dpr;
    lat.forEach((la, j) => {
      lon.forEach((lo, i) => {
        const uu = u[j * lon.length + i];
        const vv = v[j * lon.length + i];
        if (!Number.isFinite(uu) || !Number.isFinite(vv)) return;
        const sp = Math.hypot(uu, vv);
        // Solo anomalías apreciables (≥ 0.8 m/s); flechas de hasta ~3.5°
        // (la rejilla de viento es de 4°).
        if (sp < 0.8) return;
        const L2 = clamp(sp * 1.0, 1.4, 3.5) * k;
        const ang = Math.atan2(-vv, uu);
        const x0 = X(lo);
        const y0 = Y(la);
        const x1 = x0 + Math.cos(ang) * L2;
        const y1 = y0 + Math.sin(ang) * L2;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        const hl = Math.min(L2 * 0.4, 1.6 * k);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - Math.cos(ang - 0.45) * hl, y1 - Math.sin(ang - 0.45) * hl);
        ctx.lineTo(x1 - Math.cos(ang + 0.45) * hl, y1 - Math.sin(ang + 0.45) * hl);
        ctx.closePath();
        ctx.fill();
      });
    });
  }

  canvas.onmousemove = (ev) => {
    const r = canvas.getBoundingClientRect();
    const lon = Math.round(dom.lonO + ((ev.clientX - r.left) / r.width) * dom.ancho - 0.5);
    const la = Math.round(dom.latN - ((ev.clientY - r.top) / r.height) * dom.alto + 0.5);
    const i = (dom.latN - la) * dom.ancho + (lon - dom.lonO);
    const val = vals[i];
    const lonTxt = lon <= 180 ? `${lon}°E` : `${360 - lon}°W`;
    const latTxt = `${Math.abs(la)}°${la >= 0 ? 'N' : 'S'}`;
    tip.show(`${latTxt}, ${lonTxt}<br>${pal.nombre}: <b>${Number.isFinite(val) ? `${fmt(val)} ${pal.unidad}` : 'tierra'}</b>`, ev.clientX, ev.clientY);
  };
  canvas.onmouseleave = () => tip.hide();
}

function renderLeyendaHuellas() {
  const p = PALETAS[estado.campo];
  const grad = `linear-gradient(90deg, ${p.stops.map((c, i) => `${c} ${(i / (p.stops.length - 1)) * 100}%`).join(', ')})`;
  $('huellasLeyenda').innerHTML = `
    <div class="legend-scale">
      <span class="legend-name">${p.nombre} (${p.unidad})</span>
      <div class="legend-bar-wrap">
        <div class="legend-bar" style="background:${grad}"></div>
        <div class="legend-ticks">
          <span style="left:0%">${fmt(-p.max, 0)}</span><span style="left:25%">${fmt(-p.max / 2)}</span>
          <span style="left:50%">0</span><span style="left:75%">${fmt(p.max / 2)}</span><span style="left:100%">${fmt(p.max, 0)}</span>
        </div>
      </div>
    </div>`;
}

function renderHuellas() {
  const cont = $('huellasGrid');
  const filas = ORDEN.map((g) => ({ id: g, nombre: D.grupos[g].nombre, color: TIPOS[g].color, miembros: D.grupos[g].miembros.join(', ') }));
  const actual = D.eventos.find((e) => e.enCurso);
  if (actual && D.compuestos.actual) {
    filas.push({ id: 'actual', nombre: `${actual.anio0} (en curso)`, color: '#ffffff', miembros: `inicio ${actual.inicio}` });
  }

  let html = '<div></div>' + D.ventanas.map((v) => `<div class="col-head"><b>${v.nombre}</b>${v.corto}</div>`).join('');
  filas.forEach((f) => {
    html += `<div class="fila-head" style="--c:${f.color}"><h4>${f.nombre}</h4><span>${f.miembros}</span></div>`;
    D.ventanas.forEach((v, k) => {
      let comp = D.compuestos[f.id]?.[v.id];
      let titulo = '';
      // Fila actual: la última columna muestra los meses más recientes.
      if (f.id === 'actual' && k === 2) {
        comp = D.compuestos.actual.ultimo;
        titulo = `<div class="celda-pie"><span>Último: <b>${D.compuestos.actual.ultimoNombre}</b></span></div>`;
      }
      if (!comp) {
        html += '<div class="celda celda-vacia">Sin datos todavía</div>';
        return;
      }
      html += `<div class="celda">
        ${titulo}
        <canvas data-fila="${f.id}" data-col="${k}"></canvas>
        <div class="celda-pie">
          <span>N1+2 <b>${fmt(comp.nino12)}</b></span>
          <span>N3.4 <b>${fmt(comp.nino34)}</b></span>
          <span title="Anomalía de lluvia en la costa norte (4–6°S, 81–80°W), mm/día">Lluvia CN <b>${fmt(comp.lluvia)}</b></span>
        </div>
      </div>`;
    });
  });
  cont.innerHTML = html;
  dibujarHuellas();
}

function dibujarHuellas() {
  renderLeyendaHuellas();
  document.querySelectorAll('#huellasGrid canvas').forEach((cv) => {
    const fila = cv.dataset.fila;
    const k = Number(cv.dataset.col);
    const comp = fila === 'actual' && k === 2 ? D.compuestos.actual.ultimo : D.compuestos[fila][D.ventanas[k].id];
    if (comp) dibujarMapa(cv, comp);
  });
}

// =============================================================
// 5 · EVOLUCIÓN
// =============================================================

function renderEvolucion() {
  const cont = $('evolucion-grid');
  const s = D.series;
  const actual = D.eventos.find((e) => e.enCurso);

  // Índice de las líneas finas (eventos individuales) y de la línea de 2026.
  const claveEv = estado.evol;
  const nombreEv = claveEv === 'nino34_3m' ? 'Niño 3.4' : 'Niño 1+2';
  const colorEv = claveEv === 'nino34_3m' ? 'rgba(140,215,255,0.75)' : 'rgba(255,175,130,0.75)';

  cont.innerHTML = ORDEN.map((g) => `
    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">
          <h2 style="color:${TIPOS[g].color}">${D.grupos[g].nombre}</h2>
          <span class="panel-date">Promedio de ${eventosTipo(g).length} eventos: ${D.grupos[g].miembros.join(' · ')}</span>
        </div>
      </div>
      <svg data-grupo="${g}" role="img" aria-label="Evolución del grupo ${D.grupos[g].nombre}"></svg>
    </div>`).join('');

  cont.querySelectorAll('svg').forEach((svg) => {
    const g = svg.dataset.grupo;
    const { W, H } = tamSvg(svg);
    const pad = { l: 38, r: 78, t: 14, b: 26 };
    const X = lin(0, 23, pad.l, W - pad.r);
    const Y = lin(-1.8, 4.8, H - pad.b, pad.t);
    const evs = eventosTipo(g);
    const serie = (clave, a0) => Array.from({ length: 24 }, (_, k) => {
      const i = idxDe(a0 + Math.floor(k / 12), k % 12);
      return i >= 0 ? s[clave][i] : null;
    });
    const media = (clave) => Array.from({ length: 24 }, (_, k) => promedio(evs.map((e) => serie(clave, e.anio0)[k])));
    const camino = (vals) => {
      let d = '';
      vals.forEach((v, k) => { if (ok(v)) d += `${d && ok(vals[k - 1]) ? 'L' : 'M'}${X(k).toFixed(1)},${Y(v).toFixed(1)}`; });
      return d;
    };
    const ultimoK = (vals) => vals.reduce((acc, v, k) => (ok(v) ? k : acc), -1);

    const m12 = media('nino12_3m');
    const m34 = media('nino34_3m');
    const evSeries = claveEv ? evs.map((e) => ({ e, vals: serie(claveEv, e.anio0) })) : [];
    const actualVals = actual ? serie(claveEv || 'nino12_3m', actual.anio0) : null;

    let o = '';
    // Temporada de lluvias en la costa (ene–abr)
    [0, 12].forEach((k0) => {
      o += `<rect x="${X(k0 - 0.4)}" y="${pad.t}" width="${X(k0 + 3.4) - X(k0 - 0.4)}" height="${H - pad.b - pad.t}" fill="rgba(124,196,255,0.08)"/>`;
    });
    for (let v = -1; v <= 4; v++) {
      o += `<line class="${v === 0 ? 'eje' : 'grid-line'}" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/>`;
      o += `<text x="${pad.l - 6}" y="${Y(v) + 3}" text-anchor="end">${fmt(v, 0)}</text>`;
    }
    o += `<text class="lbl-sm" transform="translate(11 ${(pad.t + H - pad.b) / 2}) rotate(-90)" text-anchor="middle">anomalía (°C)</text>`;
    for (let k = 0; k < 24; k++) {
      o += `<text x="${X(k)}" y="${H - 9}" text-anchor="middle" style="${k % 12 === 0 ? 'fill:#e9f0fb;font-weight:600' : ''}">${INI[k % 12]}</text>`;
    }
    o += `<text class="lbl-sm" x="${X(0) + 2}" y="${pad.t + 11}" style="fill:#e9f0fb">Año 0</text>`;
    o += `<text class="lbl-sm" x="${X(12) + 2}" y="${pad.t + 11}" style="fill:#e9f0fb">Año +1</text>`;

    // Eventos individuales (finas, con su nombre en el máximo)
    const etiquetas = [];
    evSeries.forEach(({ e, vals }, n) => {
      let kMax = 0;
      vals.forEach((v, k) => { if (ok(v) && (!ok(vals[kMax]) || v > vals[kMax])) kMax = k; });
      let ty = Y(vals[kMax]) - 6;
      while (etiquetas.some((p) => Math.abs(p.x - X(kMax)) < 44 && Math.abs(p.y - ty) < 11)) ty -= 11;
      etiquetas.push({ x: X(kMax), y: ty });
      const d = camino(vals);
      o += `<g class="evol-ev" data-n="${n}">
        <path d="${d}" fill="none" stroke="transparent" stroke-width="10"/>
        <path class="vis" d="${d}" fill="none" stroke="${colorEv}" stroke-width="1.3" stroke-opacity="0.55"/>
        <text x="${X(kMax)}" y="${ty}" text-anchor="middle" style="fill:${colorEv};font-size:9.5px;opacity:0.85">${e.id}</text>
      </g>`;
    });

    // Promedios del grupo (gruesas) con su etiqueta al final
    const kf = 23;
    o += `<path d="${camino(m34)}" fill="none" stroke="${C34}" stroke-width="2.8"/>`;
    o += `<path d="${camino(m12)}" fill="none" stroke="${C12}" stroke-width="2.8"/>`;
    const y12 = Y(m12[kf]);
    let y34 = Y(m34[kf]);
    if (Math.abs(y12 - y34) < 12) y34 = y12 + (y34 >= y12 ? 12 : -12);
    o += `<text x="${X(kf) + 6}" y="${y12 + 3}" style="fill:${C12};font-size:10px;font-weight:700">prom. N1+2</text>`;
    o += `<text x="${X(kf) + 6}" y="${y34 + 3}" style="fill:${C34};font-size:10px;font-weight:700">prom. N3.4</text>`;

    // Evento en curso
    if (actualVals) {
      o += `<path d="${camino(actualVals)}" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="4 3"/>`;
      const ku = ultimoK(actualVals);
      if (ku >= 0) {
        o += `<circle cx="${X(ku)}" cy="${Y(actualVals[ku])}" r="3.5" fill="#fff"/>`;
        o += `<text x="${X(ku) + 7}" y="${Y(actualVals[ku]) + 4}" style="fill:#fff;font-size:10.5px;font-weight:700">${actual.anio0} (${claveEv === 'nino34_3m' ? 'N3.4' : 'N1+2'})</text>`;
      }
    }

    o += `<line class="evol-cursor" y1="${pad.t}" y2="${H - pad.b}" stroke="rgba(255,255,255,0.45)" visibility="hidden"/>`;
    svg.innerHTML = o;

    // Valores del mes bajo el cursor
    const cursor = svg.querySelector('.evol-cursor');
    svg.onmousemove = (ev) => {
      const r = svg.getBoundingClientRect();
      const k = clamp(Math.round(X.inv(((ev.clientX - r.left) / r.width) * W)), 0, 23);
      cursor.setAttribute('x1', X(k));
      cursor.setAttribute('x2', X(k));
      cursor.setAttribute('visibility', 'visible');
      const fila = (color, nombre, v) => `<tr><td><span style="color:${color}">●</span> ${nombre}</td><td>${fmt(v)} °C</td></tr>`;
      let html = `<b>${MESES[k % 12]} del año ${k < 12 ? '0' : '+1'}</b><table class="tt-tabla">`;
      html += fila(C12, 'Promedio Niño 1+2', m12[k]);
      html += fila(C34, 'Promedio Niño 3.4', m34[k]);
      evSeries.forEach(({ e, vals }) => { html += fila(colorEv, `${e.id} (${nombreEv})`, vals[k]); });
      if (actualVals && ok(actualVals[k])) html += fila('#fff', `${actual.anio0} (${nombreEv})`, actualVals[k]);
      html += '</table>';
      tip.show(html, ev.clientX, ev.clientY);
      const n = ev.target.closest('.evol-ev')?.dataset.n;
      svg.querySelectorAll('.evol-ev').forEach((gr) => gr.classList.toggle('activo', gr.dataset.n === n));
    };
    svg.onmouseleave = () => {
      tip.hide();
      cursor.setAttribute('visibility', 'hidden');
      svg.querySelectorAll('.evol-ev').forEach((gr) => gr.classList.remove('activo'));
    };
  });
}

// =============================================================
// MÉTODO
// =============================================================

function renderMetodo() {
  $('reglasTipos').innerHTML = ORDEN.map((g) => `<li><b style="color:${TIPOS[g].color}">${D.grupos[g].nombre}:</b> ${D.grupos[g].regla}</li>`).join('') +
    `<li>Índices E y C: EOF de anomalías de SST en 10°S–10°N, 120°E–80°W (${D.climatologia.replace('-', '–')}); E = (PC1 − PC2)/√2, C = (PC1 + PC2)/√2.
      Control con estos datos: corr(E, Niño 1+2) = ${D.controlEC.E_nino12.toFixed(2)}, corr(C, Niño 4) = ${D.controlEC.C_nino4.toFixed(2)}.</li>`;
}

// =============================================================
// INICIO
// =============================================================

function renderTodo() {
  renderDispersion();
  renderLineaTiempo();
  renderCicloAnual();
  renderUmbral();
  renderBarras();
  renderEvolucion();
  dibujarHuellas();
}

async function iniciar() {
  try {
    const r = await fetch('data/esquemas/nino.json');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    D = await r.json();
  } catch (err) {
    console.error(err);
    $('actualResumen').textContent = 'No se pudo cargar data/esquemas/nino.json. Abre la página con un servidor local y genera los datos con scripts/generar_esquemas_nino.py.';
    return;
  }

  renderActual();
  renderTipos();
  renderMapaRegiones();
  renderGrupos();
  renderTabla();
  renderHuellas();
  renderMetodo();
  renderTodo();

  document.querySelectorAll('#segDisp button').forEach((b) => b.addEventListener('click', () => {
    estado.disp = b.dataset.value;
    document.querySelectorAll('#segDisp button').forEach((x) => x.classList.toggle('is-on', x === b));
    renderDispersion();
  }));
  document.querySelectorAll('#segCampo button').forEach((b) => b.addEventListener('click', () => {
    estado.campo = b.dataset.value;
    document.querySelectorAll('#segCampo button').forEach((x) => x.classList.toggle('is-on', x === b));
    dibujarHuellas();
  }));
  document.querySelectorAll('#segEvol button').forEach((b) => b.addEventListener('click', () => {
    estado.evol = b.dataset.value;
    document.querySelectorAll('#segEvol button').forEach((x) => x.classList.toggle('is-on', x === b));
    renderEvolucion();
  }));
  $('chkViento').addEventListener('change', (e) => {
    estado.viento = e.target.checked;
    dibujarHuellas();
  });

  let t = null;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(renderTodo, 150);
  });
}

iniciar();
