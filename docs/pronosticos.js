/* =============================================================
   PRONÓSTICOS ESTACIONALES · SST Explorer
   -------------------------------------------------------------
   Datos: data/pronosticos/indices.json y data/pronosticos/mapas/
   (generados con scripts/generar_pronosticos.py a partir de los
   NetCDF de C3S). Las observaciones son las del propio sitio.
   ============================================================= */

'use strict';

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const INI = ['E', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

const COLORES = {
  ecmwf: '#4fc3f7',
  ukmetoffice: '#ff6b9a',
  meteofrance: '#7cdb8a',
  dwd: '#ffc23d',
  cmcc: '#b07cff',
  eccc: '#e0e6ef',
  multimodelo: '#ff8a4c'
};

const INDICES = {
  nino34: { nombre: 'Niño 3.4', unidad: '°C', esc: 2, sst: true },
  nino12: { nombre: 'Niño 1+2', unidad: '°C', esc: 2, sst: true },
  nino3: { nombre: 'Niño 3', unidad: '°C', esc: 2, sst: true },
  nino4: { nombre: 'Niño 4', unidad: '°C', esc: 2, sst: true },
  precipCN: { nombre: 'Lluvia costa norte (4–6°S, 81–80°W)', corto: 'Lluvia costa norte', unidad: 'mm/día', esc: 6 },
  vaporCN: { nombre: 'Vapor de agua costa norte', corto: 'Vapor costa norte', unidad: 'kg/m²', esc: 6 },
  t2mCN: { nombre: 'Temperatura 2 m costa norte', corto: 'T 2 m costa norte', unidad: '°C', esc: 3 }
};

const VARMAPA = {
  sst: { nombre: 'Anomalía de SST', unidad: '°C', max: 3, stops: ['#d6f1ff', '#74c6f2', '#2f8bd3', '#1f4f93', '#151b27', '#93302a', '#d24a2a', '#f39237', '#ffe7a0'] },
  precip: { nombre: 'Anomalía de precipitación', unidad: 'mm/día', max: 6, stops: ['#5c3208', '#a8641e', '#d4a35a', '#2a2a26', '#151b27', '#1d3c6e', '#2f7bff', '#5aa7ff', '#bfe0ff'] },
  vapor: { nombre: 'Anomalía de vapor de agua', unidad: 'kg/m²', max: 6, stops: ['#8c7400', '#b99b0a', '#d9c255', '#3a3622', '#151b27', '#4a505c', '#9aa1ad', '#d6dae1', '#ffffff'] },
  t2m: { nombre: 'Anomalía de temperatura a 2 m', unidad: '°C', max: 4, stops: ['#d6f1ff', '#74c6f2', '#2f8bd3', '#1f4f93', '#151b27', '#93302a', '#d24a2a', '#f39237', '#ffe7a0'] }
};

const REGIONES = {
  pacifico: { lonO: 120, lonE: 290, latN: 30, latS: -40 },
  global: { lonO: 0, lonE: 360, latN: 90, latS: -90 }
};

const UMBRAL_LLUVIA = 26; // °C, SST de Niño 1+2 a partir de la cual llueve en la costa norte (ver Análisis El Niño)

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

const promedio = (xs) => {
  const v = xs.filter(ok);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

function tamSvg(svg) {
  const r = svg.getBoundingClientRect();
  const W = Math.max(280, Math.round(r.width));
  const H = Math.max(160, Math.round(r.height));
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  return { W, H };
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
  hide() { if (this.el) this.el.hidden = true; }
};

// =============================================================
// DATOS Y FECHAS
// =============================================================

let P = null;
const st = {
  indice: 'nino34', iInicio: 0, anteriores: true,
  metrica: 'mae', ajuste: false, modeloMatriz: 'multimodelo',
  varMapa: 'sst', modeloMapa: 'multimodelo', inicioMapa: null, leadMapa: 1, region: 'pacifico'
};

const ym = (a, m) => a * 12 + m;
const deYm = (k) => [Math.floor(k / 12), k % 12];
const etiquetaYm = (k) => { const [a, m] = deYm(k); return `${MESES[m]} ${a}`; };
const inicioYm = (ini) => { const [a, m] = ini.split('-').map(Number); return ym(a, m - 1); };
const etiquetaInicio = (k) => { const [a, m] = deYm(k); return `${a}-${String(m + 1).padStart(2, '0')}`; };

let obsIndex = new Map(); // ym -> posición en P.observado
let ultimoObs = 0;

function modelosIndividuales() {
  return P.modelos.filter((m) => m.id !== 'multimodelo');
}

function nombreModelo(id) {
  return P.modelos.find((m) => m.id === id)?.nombre || id;
}

function valorObs(indice, k) {
  if (INDICES[indice].sinObs) return null;
  const i = obsIndex.get(k);
  if (i === undefined) return null;
  const v = P.observado.series[indice]?.[i];
  if (!ok(v)) return null;
  if (st.ajuste && INDICES[indice].sst) {
    const [, m] = deYm(k);
    return v - (P.desfase9316[indice]?.[m] || 0);
  }
  return v;
}

// ¿Hay observaciones de esta variable de mapa en el sitio?
// (la SST siempre; precip, vapor y t2m si se generaron sus capas)
function obsDisponible(variable) {
  return variable === 'sst' || !!P.observado.series[`${variable}CN`];
}

function valoresFc(modelo, ini, indice) {
  return P.pronostico[modelo]?.[ini]?.[indice] || null;
}

// =============================================================
// RESUMEN
// =============================================================

function renderResumen() {
  const ini = P.inicios[P.inicios.length - 1];
  const k0 = inicioYm(ini);
  const ind = modelosIndividuales().filter((m) => m.inicios.includes(ini));
  const filas = ['nino34', 'nino12', 'precipCN'];

  const rango = (indice, L) => {
    const vals = ind.map((m) => valoresFc(m.id, ini, indice)?.[L]).filter(ok);
    return vals.length ? [Math.min(...vals), Math.max(...vals)] : null;
  };

  let html = '<thead><tr><th>Promedio (rango)</th>';
  for (let L = 0; L < 6; L++) html += `<th>${etiquetaYm(k0 + L)}</th>`;
  html += '</tr></thead><tbody>';
  for (const indice of filas) {
    const mm = valoresFc('multimodelo', ini, indice) || [];
    html += `<tr><td><b style="font-family:var(--font);font-size:0.8rem">${INDICES[indice].corto || INDICES[indice].nombre}</b><small>${INDICES[indice].unidad}</small></td>`;
    for (let L = 0; L < 6; L++) {
      const r = rango(indice, L);
      // Temperatura: cálido = rojo; lluvia: más lluvia = azul, menos = marrón.
      const esLluvia = indice === 'precipCN';
      const cls = mm[L] >= 0.5 ? (esLluvia ? 'humedo' : 'calido') : mm[L] <= -0.5 ? (esLluvia ? 'seco' : 'frio') : '';
      html += `<td class="${cls}"><b>${fmt(mm[L])}</b><small>${r ? `${fmt(r[0])} a ${fmt(r[1])}` : ''}</small></td>`;
    }
    html += '</tr>';
  }
  html += '</tbody>';
  $('resTabla').innerHTML = html;

  // Texto
  const n34 = valoresFc('multimodelo', ini, 'nino34') || [];
  const n12 = valoresFc('multimodelo', ini, 'nino12') || [];
  const Lmax = n34.reduce((a, v, L) => (ok(v) && v > (n34[a] ?? -99) ? L : a), 0);
  const r34 = rango('nino34', Lmax);

  // Meses de verano (ene–abr) dentro del horizonte
  const verano = [];
  for (let L = 0; L < 6; L++) {
    const [, m] = deYm(k0 + L);
    if (m <= 3 && ok(n12[L])) verano.push({ L, m, abs: P.climaSst12[m] + n12[L], anom: n12[L] });
  }

  // Sesgo observado de Niño 1+2 con lead 1–3 (todos los modelos)
  const errs12 = [];
  for (const m of modelosIndividuales()) {
    for (const i of m.inicios) {
      const v = valoresFc(m.id, i, 'nino12');
      if (!v) continue;
      for (let L = 0; L < 3; L++) {
        const o = valorObs('nino12', inicioYm(i) + L);
        if (ok(o) && ok(v[L])) errs12.push(v[L] - o);
      }
    }
  }
  const sesgo12 = promedio(errs12);

  $('resTitulo').textContent = `Inicio ${etiquetaYm(k0)} · ${ind.length} modelos`;
  let txt = `El promedio de los modelos lleva <b>Niño 3.4 a ${fmt(n34[Lmax])} °C en ${etiquetaYm(k0 + Lmax)}</b>
    ${r34 ? `(entre ${fmt(r34[0])} y ${fmt(r34[1])} °C según el modelo)` : ''}.`;
  if (verano.length) {
    const v = verano.reduce((a, b) => (b.abs > a.abs ? b : a));
    const pos = v.abs >= UMBRAL_LLUVIA + 1 ? 'por encima del' : v.abs >= UMBRAL_LLUVIA ? 'dentro del' : 'por debajo del';
    txt += ` Para el verano, Niño 1+2 tendría una anomalía de <b>${fmt(v.anom)} °C en ${etiquetaYm(k0 + v.L)}</b>;
      sumada a la temperatura normal de ese mes (${fmt(P.climaSst12[v.m], 1, false)} °C), el mar frente a la costa estaría
      en <b>~${fmt(v.abs, 1, false)} °C</b>, ${pos} umbral de lluvias de la costa norte (~26–27 °C,
      ver <a href="tipos-nino.html#estacion">Análisis El Niño</a>).`;
  }
  if (ok(sesgo12)) {
    txt += ` Ojo con la confianza: en los meses ya observados de 2026, los modelos ${sesgo12 > 0 ? 'sobreestimaron' : 'subestimaron'}
      Niño 1+2 en promedio <b>${fmt(Math.abs(sesgo12), 2, false)} °C</b> con 1 a 3 meses de anticipación (sección 2).`;
  }
  $('resTexto').innerHTML = txt;
}

// =============================================================
// 1 · PLUMA
// =============================================================

function renderLeyendaModelos() {
  $('leyendaModelos').innerHTML =
    '<span><i style="background:#fff;height:3px"></i>Observado (SST Explorer)</span>' +
    modelosIndividuales().map((m) => `<span><i style="background:${COLORES[m.id]}"></i>${m.nombre}</span>`).join('') +
    `<span><i style="background:${COLORES.multimodelo};height:4px"></i>Promedio de los modelos</span>` +
    '<span><i style="background:rgba(255,138,76,0.25);height:10px"></i>Rango entre modelos</span>' +
    (st.anteriores ? '<span><i style="background:rgba(255,138,76,0.35);height:1.5px"></i>Promedio de inicios anteriores</span>' : '');
}

function renderPluma() {
  const svg = $('graficoPluma');
  const { W, H } = tamSvg(svg);
  const pad = { l: 46, r: 16, t: 18, b: 34 };
  const ini = P.inicios[st.iInicio];
  const kIni = inicioYm(ini);
  const indice = st.indice;
  const def = INDICES[indice];

  const k0 = ym(2025, 0);
  const k1 = Math.max(...P.inicios.map(inicioYm)) + 5;
  const X = lin(k0, k1, pad.l, W - pad.r);

  // Rango vertical con todos los datos visibles
  const vals = [0];
  for (let k = k0; k <= k1; k++) { const o = valorObs(indice, k); if (ok(o)) vals.push(o); }
  for (const m of P.modelos) for (const i of m.inicios) (valoresFc(m.id, i, indice) || []).forEach((v) => ok(v) && vals.push(v));
  const span = Math.max(...vals) - Math.min(...vals);
  const y0 = Math.floor(Math.min(...vals) - span * 0.06);
  const y1 = Math.ceil(Math.max(...vals) + span * 0.06);
  const Y = lin(y0, y1, H - pad.b, pad.t);
  const paso = y1 - y0 > 8 ? 2 : 1;

  let g = '';
  // Zona sin observaciones
  if (ultimoObs < k1) {
    g += `<rect x="${X(ultimoObs + 0.5)}" y="${pad.t}" width="${X(k1) - X(ultimoObs + 0.5)}" height="${H - pad.b - pad.t}" fill="rgba(90,209,255,0.05)"/>`;
    g += `<text class="lbl-sm" x="${X(ultimoObs + 0.5) + 6}" y="${H - pad.b - 8}" style="fill:#7cc4ff">sin observación todavía →</text>`;
  }
  for (let v = Math.ceil(y0 / paso) * paso; v <= y1; v += paso) {
    g += `<line class="${v === 0 ? 'eje' : 'grid-line'}" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/>`;
    g += `<text x="${pad.l - 7}" y="${Y(v) + 3}" text-anchor="end">${fmt(v, 0)}</text>`;
  }
  for (let k = k0; k <= k1; k++) {
    const [a, m] = deYm(k);
    g += `<text x="${X(k)}" y="${H - 18}" text-anchor="middle" style="${m === 0 ? 'fill:#e9f0fb;font-weight:600' : ''}">${INI[m]}</text>`;
    if (m === 0) g += `<text x="${X(k)}" y="${H - 4}" text-anchor="middle" style="fill:#e9f0fb">${a}</text>`;
  }
  g += `<text class="lbl-sm" transform="translate(13 ${(pad.t + H - pad.b) / 2}) rotate(-90)" text-anchor="middle">${def.nombre} (${def.unidad})</text>`;

  const camino = (puntos) => puntos.filter(([, v]) => ok(v)).map(([k, v], n) => `${n ? 'L' : 'M'}${X(k).toFixed(1)},${Y(v).toFixed(1)}`).join('');

  // Inicios anteriores (promedio de los modelos)
  if (st.anteriores) {
    for (let j = 0; j < st.iInicio; j++) {
      const i = P.inicios[j];
      const v = valoresFc('multimodelo', i, indice);
      if (!v) continue;
      const kk = inicioYm(i);
      const op = 0.12 + 0.3 * (j / Math.max(1, st.iInicio));
      g += `<path d="${camino(v.map((x, L) => [kk + L, x]))}" fill="none" stroke="${COLORES.multimodelo}" stroke-opacity="${op.toFixed(2)}" stroke-width="1.4"/>`;
      if (ok(v[5])) g += `<text x="${X(kk + 5) + 3}" y="${Y(v[5]) + 3}" style="fill:${COLORES.multimodelo};opacity:${(op + 0.2).toFixed(2)};font-size:8.5px">${INI[deYm(kk)[1]]}</text>`;
    }
  }

  // Rango entre modelos del inicio elegido
  const indiv = modelosIndividuales().filter((m) => valoresFc(m.id, ini, indice));
  if (indiv.length > 1) {
    const sup = [];
    const inf = [];
    for (let L = 0; L < 6; L++) {
      const vs = indiv.map((m) => valoresFc(m.id, ini, indice)[L]).filter(ok);
      if (vs.length) { sup.push([kIni + L, Math.max(...vs)]); inf.push([kIni + L, Math.min(...vs)]); }
    }
    const d = sup.map(([k, v], n) => `${n ? 'L' : 'M'}${X(k)},${Y(v)}`).join('') +
      inf.reverse().map(([k, v]) => `L${X(k)},${Y(v)}`).join('') + 'Z';
    g += `<path d="${d}" fill="rgba(255,138,76,0.16)"/>`;
  }

  // Modelos
  for (const m of indiv) {
    const v = valoresFc(m.id, ini, indice);
    g += `<path d="${camino(v.map((x, L) => [kIni + L, x]))}" fill="none" stroke="${COLORES[m.id]}" stroke-width="1.6"/>`;
    v.forEach((x, L) => { if (ok(x)) g += `<circle cx="${X(kIni + L)}" cy="${Y(x)}" r="2.4" fill="${COLORES[m.id]}"/>`; });
  }
  const mm = valoresFc('multimodelo', ini, indice);
  if (mm) {
    g += `<path d="${camino(mm.map((x, L) => [kIni + L, x]))}" fill="none" stroke="${COLORES.multimodelo}" stroke-width="3.4"/>`;
  }

  // Observado
  const obs = [];
  for (let k = k0; k <= ultimoObs; k++) obs.push([k, valorObs(indice, k)]);
  if (!def.sinObs) {
    g += `<path d="${camino(obs)}" fill="none" stroke="#fff" stroke-width="2.4"/>`;
    obs.forEach(([k, v]) => { if (ok(v)) g += `<circle cx="${X(k)}" cy="${Y(v)}" r="2.6" fill="#fff"/>`; });
  } else {
    g += `<text class="lbl-sm" x="${X(k0) + 6}" y="${Y(0) - 8}" style="fill:#fff">Sin observaciones de este índice en el sitio</text>`;
  }

  // Marca del inicio
  g += `<line x1="${X(kIni)}" x2="${X(kIni)}" y1="${pad.t}" y2="${H - pad.b}" stroke="rgba(255,255,255,0.4)" stroke-dasharray="3 3"/>`;
  g += `<text class="lbl" x="${X(kIni) - 6}" y="${pad.t + 12}" text-anchor="end">inicio ${etiquetaYm(kIni)}</text>`;
  g += `<line id="plumaCursor" y1="${pad.t}" y2="${H - pad.b}" stroke="rgba(255,255,255,0.5)" visibility="hidden"/>`;

  svg.innerHTML = g;

  svg.onmousemove = (ev) => {
    const r = svg.getBoundingClientRect();
    const k = clamp(Math.round(X.inv(((ev.clientX - r.left) / r.width) * W)), k0, k1);
    const cur = $('plumaCursor');
    cur.setAttribute('x1', X(k));
    cur.setAttribute('x2', X(k));
    cur.setAttribute('visibility', 'visible');
    const L = k - kIni;
    let html = `<b>${etiquetaYm(k)}</b>${L >= 0 && L < 6 ? ` · lead ${L + 1}` : ''}<table class="tt-tabla">`;
    const o = valorObs(indice, k);
    if (ok(o)) html += `<tr><td><span style="color:#fff">●</span> Observado</td><td>${fmt(o, 2)}</td></tr>`;
    if (L >= 0 && L < 6) {
      for (const m of indiv) html += `<tr><td><span style="color:${COLORES[m.id]}">●</span> ${m.nombre}</td><td>${fmt(valoresFc(m.id, ini, indice)[L], 2)}</td></tr>`;
      if (mm) html += `<tr><td><span style="color:${COLORES.multimodelo}">●</span> <b>Promedio</b></td><td><b>${fmt(mm[L], 2)}</b></td></tr>`;
    }
    html += `</table><small>${def.unidad}</small>`;
    tip.show(html, ev.clientX, ev.clientY);
  };
  svg.onmouseleave = () => { tip.hide(); $('plumaCursor')?.setAttribute('visibility', 'hidden'); };

  $('lblInicio').textContent = etiquetaYm(kIni);
}

// =============================================================
// 2 · VERIFICACIÓN
// =============================================================

function errores(modelo, indice) {
  const porLead = [[], [], [], [], [], []];
  const m = P.modelos.find((x) => x.id === modelo);
  for (const ini of m.inicios) {
    const v = valoresFc(modelo, ini, indice);
    if (!v) continue;
    for (let L = 0; L < 6; L++) {
      const o = valorObs(indice, inicioYm(ini) + L);
      if (ok(o) && ok(v[L])) porLead[L].push(v[L] - o);
    }
  }
  return porLead;
}

function renderError() {
  const svg = $('graficoError');
  const { W, H } = tamSvg(svg);
  const pad = { l: 46, r: 16, t: 16, b: 46 };
  const indice = st.indice;
  const def = INDICES[indice];
  const esMae = st.metrica === 'mae';

  $('tituloError').textContent = `${esMae ? 'Error medio absoluto' : 'Sesgo medio'} según el lead · ${def.corto || def.nombre}`;
  $('subError').textContent = esMae
    ? `Promedio de |pronóstico − observado| (${def.unidad}); más bajo = mejor`
    : `Promedio de (pronóstico − observado) (${def.unidad}); > 0 = el modelo pronosticó más`;

  if (def.sinObs) {
    svg.innerHTML = `<text class="lbl-sm" x="${W / 2}" y="${H / 2}" text-anchor="middle">Sin observaciones para verificar este índice todavía.</text>`;
    return;
  }

  const series = P.modelos.map((m) => {
    const e = errores(m.id, indice);
    return {
      m,
      n: e.map((a) => a.length),
      v: e.map((a) => (a.length ? (esMae ? promedio(a.map(Math.abs)) : promedio(a)) : null))
    };
  });
  const todos = series.flatMap((s) => s.v).filter(ok);
  const y0 = esMae ? 0 : Math.min(0, Math.floor(Math.min(...todos) * 2) / 2);
  const y1 = Math.max(0.5, Math.ceil(Math.max(...todos) * 2) / 2);
  const X = lin(0.6, 6.4, pad.l, W - pad.r);
  const Y = lin(y0, y1, H - pad.b, pad.t);
  const paso = y1 - y0 > 3 ? 1 : 0.5;

  let g = '';
  for (let v = Math.ceil(y0 / paso) * paso; v <= y1 + 1e-9; v += paso) {
    g += `<line class="${Math.abs(v) < 1e-9 ? 'eje' : 'grid-line'}" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/>`;
    g += `<text x="${pad.l - 7}" y="${Y(v) + 3}" text-anchor="end">${fmt(v, 1, !esMae)}</text>`;
  }
  const mmN = series.find((s) => s.m.id === 'multimodelo').n;
  for (let L = 1; L <= 6; L++) {
    g += `<text x="${X(L)}" y="${H - pad.b + 16}" text-anchor="middle" style="fill:#e9f0fb">${L}</text>`;
    g += `<text x="${X(L)}" y="${H - pad.b + 28}" text-anchor="middle" style="font-size:8.5px">n=${mmN[L - 1]}</text>`;
  }
  g += `<text class="lbl-sm" x="${(pad.l + W - pad.r) / 2}" y="${H - 4}" text-anchor="middle">Lead (meses desde el inicio; 1 = mismo mes)</text>`;

  for (const s of series) {
    const mm = s.m.id === 'multimodelo';
    const d = s.v.map((v, L) => (ok(v) ? [L + 1, v] : null)).filter(Boolean)
      .map(([L, v], n) => `${n ? 'L' : 'M'}${X(L)},${Y(v)}`).join('');
    g += `<path d="${d}" fill="none" stroke="${COLORES[s.m.id]}" stroke-width="${mm ? 3.4 : 1.6}"/>`;
    s.v.forEach((v, L) => { if (ok(v)) g += `<circle cx="${X(L + 1)}" cy="${Y(v)}" r="${mm ? 3.6 : 2.6}" fill="${COLORES[s.m.id]}" data-m="${s.m.id}" data-l="${L}"/>`; });
  }
  svg.innerHTML = g;

  svg.onmousemove = (ev) => {
    const r = svg.getBoundingClientRect();
    const L = clamp(Math.round(X.inv(((ev.clientX - r.left) / r.width) * W)), 1, 6) - 1;
    let html = `<b>Lead ${L + 1}</b><table class="tt-tabla">`;
    for (const s of series) {
      html += `<tr><td><span style="color:${COLORES[s.m.id]}">●</span> ${s.m.nombre} <small>(n=${s.n[L]})</small></td><td>${fmt(s.v[L], 2, !esMae)}</td></tr>`;
    }
    html += `</table><small>${def.unidad}</small>`;
    tip.show(html, ev.clientX, ev.clientY);
  };
  svg.onmouseleave = () => tip.hide();
}

function colorError(e, esc) {
  // Divergente: azul (pronosticó menos) — neutro — rojo (pronosticó más)
  const t = clamp(e / esc, -1, 1);
  const neutro = [42, 50, 66];
  const azul = [47, 139, 211];
  const rojo = [210, 74, 42];
  const c = t < 0 ? azul : rojo;
  const f = Math.abs(t);
  return `rgb(${neutro.map((n, i) => Math.round(n + (c[i] - n) * f)).join(',')})`;
}

function renderMatriz() {
  const indice = st.indice;
  const def = INDICES[indice];
  const modelo = st.modeloMatriz;
  const m = P.modelos.find((x) => x.id === modelo);
  const esc = def.esc;
  const kMin = Math.min(...P.inicios.map(inicioYm));
  const kMax = Math.max(...P.inicios.map(inicioYm)) + 5;

  let html = '<thead><tr><th>Inicio \\ mes</th>';
  for (let k = kMin; k <= kMax; k++) {
    const [a, mm] = deYm(k);
    html += `<th>${MESES[mm]}${mm === 0 || k === kMin ? `<br>${a}` : ''}</th>`;
  }
  html += '</tr></thead><tbody>';

  if (!def.sinObs) {
    html += '<tr class="fila-obs"><th>Observado</th>';
    for (let k = kMin; k <= kMax; k++) {
      const o = valorObs(indice, k);
      html += ok(o) ? `<td>${fmt(o)}</td>` : '<td class="futuro">·</td>';
    }
    html += '</tr>';
  }

  for (const ini of P.inicios) {
    const kIni = inicioYm(ini);
    const v = m.inicios.includes(ini) ? valoresFc(modelo, ini, indice) : null;
    html += `<tr><th>${etiquetaYm(kIni)}</th>`;
    for (let k = kMin; k <= kMax; k++) {
      const L = k - kIni;
      if (!v || L < 0 || L > 5 || !ok(v[L])) { html += '<td></td>'; continue; }
      const o = valorObs(indice, k);
      if (ok(o)) {
        const e = v[L] - o;
        html += `<td style="background:${colorError(e, esc)}" title="Lead ${L + 1}: pronóstico ${fmt(v[L], 2)}, observado ${fmt(o, 2)}, error ${fmt(e, 2)} ${def.unidad}">${fmt(v[L])}</td>`;
      } else {
        html += `<td class="futuro" title="Lead ${L + 1}: pronóstico ${fmt(v[L], 2)} ${def.unidad} (aún sin observación)">${fmt(v[L])}</td>`;
      }
    }
    html += '</tr>';
  }
  html += '</tbody>';
  $('matriz').innerHTML = html;

  $('matrizLeyenda').innerHTML = `Error: <span>${fmt(-esc, 0)}</span>
    <div class="legend-bar" style="background:linear-gradient(90deg, ${colorError(-esc, esc)}, ${colorError(0, esc)}, ${colorError(esc, esc)})"></div>
    <span>${fmt(esc, 0)} ${def.unidad}</span>
    <span>· azul = pronosticó menos · rojo = pronosticó más · borde punteado = aún sin observar</span>`;
}

// =============================================================
// 3 · MAPAS
// =============================================================

const cacheGris = new Map();

function cargarGris(url) {
  if (cacheGris.has(url)) return cacheGris.get(url);
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const g = new Uint8Array(c.width * c.height);
      for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = d[j + 3] === 0 ? 0 : d[j];
      resolve({ w: c.width, h: c.height, g });
    };
    img.onerror = () => reject(new Error(`No se pudo cargar ${url}`));
    img.src = url;
  });
  p.catch(() => cacheGris.delete(url));
  cacheGris.set(url, p);
  return p;
}

function decodificar(g, enc) {
  if (g === 0) return NaN;
  if (enc.type === 'linear') return enc.min + ((g - 1) / 254) * (enc.max - enc.min);
  const s = (g - 128) / 127;
  if (enc.type === 'signed-linear') return s * enc.max;
  return Math.sign(s) * s * s * enc.max;
}

let metaSitio = null;
const metaCapas = {};

async function campoPronostico(modelo, variable, ini, L) {
  const enc = P.variables[variable].encoding;
  const im = await cargarGris(`data/pronosticos/mapas/${modelo}/${variable}_${ini}.png`);
  const n = 360 * 180;
  const out = new Float32Array(n);
  const off = L * n;
  for (let i = 0; i < n; i++) out[i] = decodificar(im.g[off + i], enc);
  return out;
}

// Observado llevado a la rejilla del pronóstico (centros en .5°)
async function campoObservado(variable, k) {
  if (!obsDisponible(variable) || k > ultimoObs) return null;
  const [a, m] = deYm(k);
  const out = new Float32Array(360 * 180);
  if (variable === 'sst') {
    if (!metaSitio) metaSitio = await (await fetch('data/metadata.json')).json();
    const im = await cargarGris(`data/anomaly/${a}/frame_${String(m * 10).padStart(4, '0')}.png`);
    const lo = metaSitio.anomaly_min ?? -5;
    const hi = metaSitio.anomaly_max ?? 5;
    for (let j = 0; j < 180; j++) {
      for (let i = 0; i < 360; i++) {
        const g = im.g[(2 * j + 1) * im.w + (2 * i + 1)];
        out[j * 360 + i] = g === 0 ? NaN : lo + ((g - 1) / 254) * (hi - lo);
      }
    }
    return out;
  }
  if (!metaCapas[variable]) metaCapas[variable] = await (await fetch(`data/${variable}/metadata.json`)).json();
  const enc = metaCapas[variable].anomaly.encoding;
  const im = await cargarGris(`data/${variable}/anomaly/${a}/${String(m + 1).padStart(2, '0')}.png`);
  for (let j = 0; j < 180; j++) {
    for (let i = 0; i < 360; i++) {
      const i2 = (i + 1) % 360;
      const vals = [im.g[j * 360 + i], im.g[j * 360 + i2], im.g[(j + 1) * 360 + i], im.g[(j + 1) * 360 + i2]]
        .map((g) => decodificar(g, enc));
      out[j * 360 + i] = promedio(vals) ?? NaN;
    }
  }
  return out;
}

function hexRgb(h) {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

const lutCache = {};
function lut(variable) {
  if (lutCache[variable]) return lutCache[variable];
  const rgb = VARMAPA[variable].stops.map(hexRgb);
  const out = [];
  for (let i = 0; i < 256; i++) {
    const p = (i / 255) * (rgb.length - 1);
    const j = Math.min(Math.floor(p), rgb.length - 2);
    const f = p - j;
    out.push(rgb[j].map((c, k) => Math.round(c + (rgb[j + 1][k] - c) * f)));
  }
  lutCache[variable] = out;
  return out;
}

function dibujarCampo(canvas, campo, variable, mascara) {
  const R = REGIONES[st.region];
  const ancho = R.lonE - R.lonO;
  const alto = R.latN - R.latS;
  const j0 = 90 - R.latN;
  const i0 = R.lonO;
  const L = lut(variable);
  const max = VARMAPA[variable].max;

  const base = document.createElement('canvas');
  base.width = ancho;
  base.height = alto;
  const bctx = base.getContext('2d');
  const img = bctx.createImageData(ancho, alto);
  for (let j = 0; j < alto; j++) {
    for (let i = 0; i < ancho; i++) {
      const idx = (j0 + j) * 360 + ((i0 + i) % 360);
      const v = campo[idx];
      const o = (j * ancho + i) * 4;
      const tierra = mascara && !Number.isFinite(mascara[idx]);
      if (!Number.isFinite(v)) {
        img.data[o] = 58; img.data[o + 1] = 66; img.data[o + 2] = 82; img.data[o + 3] = 255;
        continue;
      }
      const k = clamp(Math.round(((v / max) * 0.5 + 0.5) * 255), 0, 255);
      let [r, g, b] = L[k];
      if (tierra) { r = r * 0.65 + 58 * 0.35; g = g * 0.65 + 66 * 0.35; b = b * 0.65 + 82 * 0.35; }
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  }
  bctx.putImageData(img, 0, 0);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(240, Math.round(canvas.clientWidth * dpr));
  const h = Math.round((w * alto) / ancho);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(base, 0, 0, w, h);

  const k = w / ancho;
  const X = (lon) => (lon - R.lonO) * k;
  const Y = (lat) => (R.latN - lat) * k;
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = dpr;
  ctx.beginPath();
  ctx.moveTo(0, Y(0));
  ctx.lineTo(w, Y(0));
  ctx.stroke();
  const cajas = [['nino34', 'rgba(90,209,255,0.8)'], ['nino12', 'rgba(255,138,76,0.9)']];
  for (const [id, color] of cajas) {
    const [la0, la1, lo0, lo1] = P.indices[id].caja;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2 * dpr;
    ctx.strokeRect(X(lo0), Y(Math.max(la0, la1)), (lo1 - lo0) * k, Math.abs(la1 - la0) * k);
  }
}

function etiquetaModeloInicio() {
  const kIni = inicioYm(st.inicioMapa);
  return `${nombreModelo(st.modeloMapa)} · inicio ${etiquetaYm(kIni)} · ${etiquetaYm(kIni + st.leadMapa - 1)} (lead ${st.leadMapa})`;
}

let solicitudMapa = 0;

async function renderMapas() {
  const id = ++solicitudMapa;
  const variable = st.varMapa;
  const modelo = st.modeloMapa;
  const ini = st.inicioMapa;
  const L = st.leadMapa - 1;
  const kObj = inicioYm(ini) + L;
  const vm = VARMAPA[variable];
  const mInfo = P.modelos.find((m) => m.id === modelo);

  renderLeyendaMapa();
  $('tMapaFc').textContent = `Pronóstico · ${vm.nombre.replace('Anomalía de ', '')}`;
  $('sMapaFc').textContent = etiquetaModeloInicio();

  if (!mInfo.variables.includes(variable) || !mInfo.inicios.includes(ini)) {
    $('sMapaFc').textContent = `${nombreModelo(modelo)} no tiene esta variable o este inicio.`;
    ['mapaFc', 'mapaObs', 'mapaDif'].forEach((c) => { $(c).width = 0; $(c).height = 0; });
    return;
  }

  try {
    const [fc, obs, mascara] = await Promise.all([
      campoPronostico(modelo, variable, ini, L),
      campoObservado(variable, kObj),
      variable === 'sst' ? null : campoPronostico(modelo, 'sst', ini, L)
    ]);
    if (id !== solicitudMapa) return;

    dibujarCampo($('mapaFc'), fc, variable, mascara);
    estado.mapas = { fc, obs, variable };

    const sinObs = !obs;
    $('mapaObs').hidden = sinObs;
    $('mapaDif').hidden = sinObs;
    $('vacioObs').hidden = !sinObs;
    $('vacioDif').hidden = !sinObs;
    if (sinObs) {
      const motivo = !obsDisponible(variable)
        ? 'Esta variable todavía no tiene observaciones en el sitio.'
        : `${etiquetaYm(kObj)} aún no tiene observación (último mes observado: ${etiquetaYm(ultimoObs)}).`;
      // Atajo: el último mes observado, pronosticado con 3 meses de anticipación.
      const iniAtajo = etiquetaInicio(ultimoObs - 2);
      const puede = obsDisponible(variable) && P.modelos.find((m) => m.id === modelo).inicios.includes(iniAtajo);
      $('vacioObs').innerHTML = `<div>${motivo}${puede
        ? `<br><button type="button" id="btnAtajo">Ver ${etiquetaYm(ultimoObs)} pronosticado desde ${etiquetaYm(ultimoObs - 2)}</button>`
        : ''}</div>`;
      if (puede) {
        $('btnAtajo').onclick = () => {
          st.inicioMapa = iniAtajo;
          st.leadMapa = 3;
          actualizarInicioMapa();
          renderMapas();
        };
      }
      $('vacioDif').textContent = 'Sin observación para comparar.';
      $('sMapaObs').textContent = '';
      $('sMapaDif').textContent = '';
      estado.mapas.dif = null;
      return;
    }

    const dif = new Float32Array(fc.length);
    let suma = 0;
    let n = 0;
    for (let i = 0; i < fc.length; i++) {
      dif[i] = fc[i] - obs[i];
      // Error medio en el Pacífico tropical (20°N–20°S, 120°E–80°W) como referencia
      const j = Math.floor(i / 360);
      const lon = (i % 360) + 0.5;
      const lat = 89.5 - j;
      if (Math.abs(lat) <= 20 && lon >= 120 && lon <= 280 && Number.isFinite(dif[i])) { suma += Math.abs(dif[i]); n++; }
    }
    estado.mapas.dif = dif;
    dibujarCampo($('mapaObs'), obs, variable, mascara);
    dibujarCampo($('mapaDif'), dif, variable, mascara);
    $('sMapaObs').textContent = `${variable === 'sst' ? 'SST Explorer' : 'ERA5'} · ${etiquetaYm(kObj)}`;
    $('sMapaDif').textContent = `Error absoluto medio en el Pacífico tropical: ${fmt(n ? suma / n : null, 2, false)} ${vm.unidad}`;
  } catch (err) {
    console.error(err);
    $('sMapaFc').textContent = 'No se pudo cargar el mapa.';
  }
}

const estado = { mapas: null };

function renderLeyendaMapa() {
  const v = VARMAPA[st.varMapa];
  const grad = `linear-gradient(90deg, ${v.stops.map((c, i) => `${c} ${(i / (v.stops.length - 1)) * 100}%`).join(', ')})`;
  $('leyendaMapa').innerHTML = `
    <div class="legend-scale">
      <span class="legend-name">${v.nombre} (${v.unidad})</span>
      <div class="legend-bar-wrap">
        <div class="legend-bar" style="background:${grad}"></div>
        <div class="legend-ticks">
          <span style="left:0%">${fmt(-v.max, 0)}</span><span style="left:25%">${fmt(-v.max / 2)}</span>
          <span style="left:50%">0</span><span style="left:75%">${fmt(v.max / 2)}</span><span style="left:100%">${fmt(v.max, 0)}</span>
        </div>
      </div>
    </div>`;
}

function hoverMapas() {
  ['mapaFc', 'mapaObs', 'mapaDif'].forEach((id) => {
    const cv = $(id);
    cv.onmousemove = (ev) => {
      if (!estado.mapas) return;
      const R = REGIONES[st.region];
      const r = cv.getBoundingClientRect();
      const lon = R.lonO + ((ev.clientX - r.left) / r.width) * (R.lonE - R.lonO);
      const lat = R.latN - ((ev.clientY - r.top) / r.height) * (R.latN - R.latS);
      const i = clamp(Math.floor(lon), 0, 359);
      const j = clamp(Math.floor(90 - lat), 0, 179);
      const idx = j * 360 + i;
      const u = VARMAPA[estado.mapas.variable].unidad;
      const lonTxt = lon <= 180 ? `${lon.toFixed(1)}°E` : `${(360 - lon).toFixed(1)}°W`;
      const latTxt = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
      let html = `${latTxt}, ${lonTxt}<table class="tt-tabla">`;
      html += `<tr><td>Pronóstico</td><td>${fmt(estado.mapas.fc[idx], 2)}</td></tr>`;
      if (estado.mapas.obs) html += `<tr><td>Observado</td><td>${fmt(estado.mapas.obs[idx], 2)}</td></tr>`;
      if (estado.mapas.dif) html += `<tr><td>Pron. − obs.</td><td>${fmt(estado.mapas.dif[idx], 2)}</td></tr>`;
      html += `</table><small>${u}</small>`;
      tip.show(html, ev.clientX, ev.clientY);
    };
    cv.onmouseleave = () => tip.hide();
  });
}

function llenarSelectoresMapa() {
  const selM = $('selModeloMapa');
  selM.innerHTML = P.modelos.map((m) => `<option value="${m.id}">${m.nombre}</option>`).join('');
  selM.value = st.modeloMapa;
  actualizarInicioMapa();
}

function actualizarInicioMapa() {
  const m = P.modelos.find((x) => x.id === st.modeloMapa);
  const sel = $('selInicioMapa');
  sel.innerHTML = m.inicios.map((i) => `<option value="${i}">${etiquetaYm(inicioYm(i))}</option>`).join('');
  if (!m.inicios.includes(st.inicioMapa)) st.inicioMapa = m.inicios[m.inicios.length - 1];
  sel.value = st.inicioMapa;
  actualizarLeadMapa();
}

function actualizarLeadMapa() {
  const kIni = inicioYm(st.inicioMapa);
  const sel = $('selLeadMapa');
  sel.innerHTML = [1, 2, 3, 4, 5, 6].map((L) => {
    const k = kIni + L - 1;
    return `<option value="${L}">${etiquetaYm(k)} · lead ${L}${k <= ultimoObs ? ' ✓ obs.' : ''}</option>`;
  }).join('');
  sel.value = String(st.leadMapa);
}

// =============================================================
// 1 · ANIMACIÓN (observado → pronóstico, interpolada)
// =============================================================

const anim = {
  var: 'sst', modelo: 'multimodelo', inicio: null, nObs: 6, region: 'pacifico',
  frames: [], t: 0, playing: true, speed: 1, mascara: null, espera: 0,
  base: null, bctx: null, img: null, dims: null, visible: true, sucio: true, solicitud: 0
};

function dibujarCajas(ctx, R, k, dpr) {
  const X = (lon) => (lon - R.lonO) * k;
  const Y = (lat) => (R.latN - lat) * k;
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = dpr;
  ctx.beginPath();
  ctx.moveTo(0, Y(0));
  ctx.lineTo(ctx.canvas.width, Y(0));
  ctx.stroke();
  for (const [id, color] of [['nino34', 'rgba(90,209,255,0.85)'], ['nino12', 'rgba(255,138,76,0.9)']]) {
    const [la0, la1, lo0, lo1] = P.indices[id].caja;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4 * dpr;
    ctx.strokeRect(X(lo0), Y(Math.max(la0, la1)), (lo1 - lo0) * k, Math.abs(la1 - la0) * k);
  }
}

function llenarSelectoresAnim() {
  $('selModeloAnim').innerHTML = P.modelos.map((m) => `<option value="${m.id}">${m.nombre}</option>`).join('');
  $('selModeloAnim').value = anim.modelo;
  const m = P.modelos.find((x) => x.id === anim.modelo);
  if (!m.inicios.includes(anim.inicio)) anim.inicio = m.inicios[m.inicios.length - 1];
  $('selInicioAnim').innerHTML = m.inicios.map((i) => `<option value="${i}">${etiquetaYm(inicioYm(i))}</option>`).join('');
  $('selInicioAnim').value = anim.inicio;
}

async function prepararAnimacion() {
  const id = ++anim.solicitud;
  const cargando = $('animCargando');
  const mInfo = P.modelos.find((m) => m.id === anim.modelo);
  if (!mInfo.variables.includes(anim.var)) {
    cargando.hidden = false;
    cargando.textContent = `${mInfo.nombre} no incluye esta variable.`;
    anim.frames = [];
    return;
  }
  cargando.textContent = 'Cargando mapas…';
  cargando.hidden = false;

  const kIni = inicioYm(anim.inicio);
  const lista = [];
  if (obsDisponible(anim.var)) {
    for (let k = kIni - anim.nObs; k < kIni; k++) {
      if (k <= ultimoObs && obsIndex.has(k)) lista.push({ k, tipo: 'obs' });
    }
  }
  for (let L = 0; L < 6; L++) lista.push({ k: kIni + L, tipo: 'fc', L });

  try {
    const [campos, mascara] = await Promise.all([
      Promise.all(lista.map((f) => (f.tipo === 'obs'
        ? campoObservado(anim.var, f.k)
        : campoPronostico(anim.modelo, anim.var, anim.inicio, f.L)))),
      anim.var === 'sst' ? null : campoPronostico(anim.modelo, 'sst', anim.inicio, 0)
    ]);
    if (id !== anim.solicitud) return;
    anim.frames = lista.map((f, i) => ({ ...f, campo: campos[i] })).filter((f) => f.campo);
    anim.mascara = mascara;
    anim.t = 0;
    anim.espera = 0;
    dimensionarAnim();
    construirTicksAnim();
    renderLeyendaAnim();
    anim.sucio = true;
    cargando.hidden = true;
  } catch (err) {
    console.error(err);
    if (id === anim.solicitud) cargando.textContent = 'No se pudieron cargar los mapas.';
  }
}

function dimensionarAnim() {
  const R = REGIONES[anim.region];
  const ancho = R.lonE - R.lonO;
  const alto = R.latN - R.latS;
  if (!anim.base || anim.base.width !== ancho || anim.base.height !== alto) {
    anim.base = document.createElement('canvas');
    anim.base.width = ancho;
    anim.base.height = alto;
    anim.bctx = anim.base.getContext('2d');
    anim.img = anim.bctx.createImageData(ancho, alto);
  }
  const cv = $('animCanvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(300, Math.round(cv.clientWidth * dpr));
  cv.width = w;
  cv.height = Math.round((w * alto) / ancho);
  anim.dims = { R, ancho, alto, dpr, k: w / ancho };
  anim.sucio = true;
}

function construirTicksAnim() {
  const n = anim.frames.length;
  const rango = $('animRango');
  rango.max = Math.max(0, n - 1);
  rango.value = anim.t;
  let html = '';
  const iFc = anim.frames.findIndex((f) => f.tipo === 'fc');
  anim.frames.forEach((f, i) => {
    const [a, m] = deYm(f.k);
    const left = n > 1 ? (i / (n - 1)) * 100 : 0;
    html += `<span class="${f.tipo}" style="left:${left}%">${INI[m]}${m === 0 ? ` ${String(a).slice(2)}` : ''}</span>`;
  });
  if (iFc > 0 && n > 1) {
    html += `<span class="corte" style="left:${((iFc - 0.5) / (n - 1)) * 100}%" title="Inicio del pronóstico"></span>`;
  }
  $('animTicks').innerHTML = html;
}

function renderLeyendaAnim() {
  const v = VARMAPA[anim.var];
  const grad = `linear-gradient(90deg, ${v.stops.map((c, i) => `${c} ${(i / (v.stops.length - 1)) * 100}%`).join(', ')})`;
  $('leyendaAnim').innerHTML = `
    <div class="legend-scale">
      <span class="legend-name">${v.nombre} (${v.unidad})</span>
      <div class="legend-bar-wrap">
        <div class="legend-bar" style="background:${grad}"></div>
        <div class="legend-ticks">
          <span style="left:0%">${fmt(-v.max, 0)}</span><span style="left:25%">${fmt(-v.max / 2)}</span>
          <span style="left:50%">0</span><span style="left:75%">${fmt(v.max / 2)}</span><span style="left:100%">${fmt(v.max, 0)}</span>
        </div>
      </div>
    </div>`;
}

// Valor interpolado en el instante t para un índice (observado o pronosticado).
function indiceAnim(indice, f) {
  if (f.tipo === 'obs') return valorObs(indice, f.k);
  return valoresFc(anim.modelo, anim.inicio, indice)?.[f.L] ?? null;
}

function valorInterpolado(a, b, f) {
  const oa = Number.isFinite(a);
  const ob = Number.isFinite(b);
  if (oa && ob) return a + (b - a) * f;
  if (oa && f < 0.5) return a;
  if (ob && f >= 0.5) return b;
  return NaN;
}

function dibujarAnim() {
  const n = anim.frames.length;
  if (!n || !anim.dims) return;
  const { R, ancho, alto, dpr, k } = anim.dims;
  const i0 = Math.floor(anim.t);
  const i1 = Math.min(i0 + 1, n - 1);
  const f = anim.t - i0;
  const A = anim.frames[i0].campo;
  const B = anim.frames[i1].campo;
  const masc = anim.mascara;
  const L = lut(anim.var);
  const max = VARMAPA[anim.var].max;
  const data = anim.img.data;
  const j0 = 90 - R.latN;

  for (let j = 0; j < alto; j++) {
    const fila = (j0 + j) * 360;
    for (let i = 0; i < ancho; i++) {
      const idx = fila + ((R.lonO + i) % 360);
      const v = valorInterpolado(A[idx], B[idx], f);
      const o = (j * ancho + i) * 4;
      if (!Number.isFinite(v)) {
        data[o] = 58; data[o + 1] = 66; data[o + 2] = 82; data[o + 3] = 255;
        continue;
      }
      const c = L[clamp(Math.round(((v / max) * 0.5 + 0.5) * 255), 0, 255)];
      if (masc && !Number.isFinite(masc[idx])) {
        data[o] = c[0] * 0.65 + 20; data[o + 1] = c[1] * 0.65 + 23; data[o + 2] = c[2] * 0.65 + 29;
      } else {
        data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2];
      }
      data[o + 3] = 255;
    }
  }
  anim.bctx.putImageData(anim.img, 0, 0);

  const cv = $('animCanvas');
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(anim.base, 0, 0, cv.width, cv.height);
  dibujarCajas(ctx, R, k, dpr);

  // Indicadores
  const actual = anim.frames[f < 0.5 ? i0 : i1];
  $('animFecha').textContent = etiquetaYm(actual.k);
  const tipo = $('animTipo');
  tipo.className = `anim-tipo ${actual.tipo}`;
  tipo.textContent = actual.tipo === 'obs'
    ? 'Observado'
    : `Pronóstico ${nombreModelo(anim.modelo)} · lead ${actual.L + 1}`;
  const a0 = anim.frames[i0];
  const a1 = anim.frames[i1];
  const ind = ['nino34', 'nino12'].map((id) => {
    const v = valorInterpolado(indiceAnim(id, a0) ?? NaN, indiceAnim(id, a1) ?? NaN, f);
    return `<div><b>${fmt(v)}</b>${INDICES[id].nombre} (°C)</div>`;
  });
  $('animIndices').innerHTML = ind.join('');

  const rango = $('animRango');
  rango.value = anim.t;
  anim.sucio = false;
  tooltipAnim();
}

// Valor bajo el ratón en el instante actual de la animación.
// Se llama al mover el ratón y en cada cuadro, para que el valor
// cambie mientras la animación avanza.
function tooltipAnim() {
  if (!anim.raton || !anim.frames.length || !anim.dims) return;
  const { R } = anim.dims;
  const r = $('animCanvas').getBoundingClientRect();
  const { x, y } = anim.raton;
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return;
  const lon = R.lonO + ((x - r.left) / r.width) * (R.lonE - R.lonO);
  const lat = R.latN - ((y - r.top) / r.height) * (R.latN - R.latS);
  const idx = clamp(Math.floor(90 - lat), 0, 179) * 360 + (clamp(Math.floor(lon), 0, 359) % 360);
  const n = anim.frames.length;
  const i0 = Math.floor(anim.t);
  const i1 = Math.min(i0 + 1, n - 1);
  const f = anim.t - i0;
  const v = valorInterpolado(anim.frames[i0].campo[idx], anim.frames[i1].campo[idx], f);
  const actual = anim.frames[f < 0.5 ? i0 : i1];
  const lonTxt = lon <= 180 ? `${lon.toFixed(1)}°E` : `${(360 - lon).toFixed(1)}°W`;
  const latTxt = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
  tip.show(`<b>${etiquetaYm(actual.k)}</b> · ${actual.tipo === 'obs' ? 'observado' : `pronóstico, lead ${actual.L + 1}`}<br>
    ${latTxt}, ${lonTxt}<br>${VARMAPA[anim.var].nombre}: <b>${fmt(v, 2)} ${VARMAPA[anim.var].unidad}</b>`, x, y);
}

let ultimoCuadro = performance.now();

function bucleAnim(ahora) {
  const dt = Math.min(0.1, (ahora - ultimoCuadro) / 1000);
  ultimoCuadro = ahora;
  const n = anim.frames.length;
  if (anim.playing && n > 1 && anim.visible) {
    if (anim.t >= n - 1) {
      // Pausa breve al final antes de reiniciar.
      anim.espera += dt;
      if (anim.espera > 1.5) { anim.t = 0; anim.espera = 0; anim.sucio = true; }
    } else {
      anim.t = Math.min(n - 1, anim.t + dt * anim.speed * 0.8);
      anim.sucio = true;
    }
  }
  if (anim.sucio && anim.visible) dibujarAnim();
  requestAnimationFrame(bucleAnim);
}

function setPlayAnim(p) {
  anim.playing = p;
  $('animPlay').classList.toggle('is-playing', p);
  $('animPlay').setAttribute('aria-label', p ? 'Pausar' : 'Reproducir');
}

function bindAnimacion() {
  bindSeg('segVarAnim', (v) => { anim.var = v; prepararAnimacion(); });
  bindSeg('segRegionAnim', (v) => { anim.region = v; dimensionarAnim(); });
  $('selModeloAnim').addEventListener('change', (e) => { anim.modelo = e.target.value; llenarSelectoresAnim(); prepararAnimacion(); });
  $('selInicioAnim').addEventListener('change', (e) => { anim.inicio = e.target.value; prepararAnimacion(); });
  $('selObsAnim').addEventListener('change', (e) => { anim.nObs = Number(e.target.value); prepararAnimacion(); });
  $('animPlay').addEventListener('click', () => setPlayAnim(!anim.playing));
  $('animVel').addEventListener('change', (e) => { anim.speed = Number(e.target.value); });
  $('animRango').addEventListener('input', (e) => {
    setPlayAnim(false);
    anim.t = Number(e.target.value);
    anim.sucio = true;
  });

  const cv = $('animCanvas');
  cv.addEventListener('mousemove', (ev) => {
    anim.raton = { x: ev.clientX, y: ev.clientY };
    tooltipAnim();
  });
  cv.addEventListener('mouseleave', () => {
    anim.raton = null;
    tip.hide();
  });

  new IntersectionObserver((e) => { anim.visible = e[0].isIntersecting; if (anim.visible) anim.sucio = true; })
    .observe($('animacion'));
}

// =============================================================
// INICIO
// =============================================================

function renderIndice() {
  renderLeyendaModelos();
  renderPluma();
  renderError();
  renderMatriz();
  const def = INDICES[st.indice];
  $('notaIndiceVerif').textContent = `Índice: ${def.nombre}`;
}

function bindSeg(id, fn) {
  document.querySelectorAll(`#${id} button`).forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll(`#${id} button`).forEach((x) => x.classList.toggle('is-on', x === b));
    fn(b.dataset.value);
  }));
}

async function iniciar() {
  try {
    const r = await fetch('data/pronosticos/indices.json');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    P = await r.json();
  } catch (err) {
    console.error(err);
    $('resTitulo').textContent = 'No se pudieron cargar los pronósticos';
    $('resTexto').textContent = 'No se pudieron cargar los datos de pronósticos. Intenta recargar la página.';
    return;
  }

  P.observado.fechas.forEach(([a, m], i) => obsIndex.set(ym(a, m), i));
  // Índices sin serie observada (p. ej. si falta alguna capa de ERA5)
  for (const [k, d] of Object.entries(INDICES)) d.sinObs = !P.observado.series[k];
  ultimoObs = Math.max(...obsIndex.keys());
  st.iInicio = P.inicios.length - 1;
  st.inicioMapa = P.inicios[P.inicios.length - 1];

  $('listaModelos').textContent = modelosIndividuales().map((m) => m.nombre).join(', ');
  $('desfaseMax').textContent = Math.max(...P.desfase9316.nino34.map(Math.abs)).toFixed(2);

  // Controles de índice
  $('selIndice').innerHTML = Object.entries(INDICES).map(([k, d]) => `<option value="${k}">${d.nombre}</option>`).join('');
  $('selIndice').value = st.indice;
  $('selIndice').addEventListener('change', (e) => { st.indice = e.target.value; renderIndice(); });

  const rng = $('rngInicio');
  rng.max = P.inicios.length - 1;
  rng.value = st.iInicio;
  rng.addEventListener('input', () => { st.iInicio = Number(rng.value); renderPluma(); });

  let timer = null;
  $('btnPlayInicio').addEventListener('click', () => {
    if (timer) { clearInterval(timer); timer = null; return; }
    st.iInicio = 0;
    timer = setInterval(() => {
      rng.value = st.iInicio;
      renderPluma();
      if (st.iInicio >= P.inicios.length - 1) { clearInterval(timer); timer = null; return; }
      st.iInicio++;
    }, 900);
  });

  $('chkAnteriores').addEventListener('change', (e) => { st.anteriores = e.target.checked; renderLeyendaModelos(); renderPluma(); });
  bindSeg('segMetrica', (v) => { st.metrica = v; renderError(); });
  $('chkAjuste').addEventListener('change', (e) => { st.ajuste = e.target.checked; renderIndice(); renderResumen(); });

  const selMM = $('selModeloMatriz');
  selMM.innerHTML = P.modelos.map((m) => `<option value="${m.id}">${m.nombre}</option>`).join('');
  selMM.value = st.modeloMatriz;
  selMM.addEventListener('change', () => { st.modeloMatriz = selMM.value; renderMatriz(); });

  // Mapas
  llenarSelectoresMapa();
  bindSeg('segVarMapa', (v) => { st.varMapa = v; renderMapas(); });
  bindSeg('segRegion', (v) => { st.region = v; renderMapas(); });
  $('selModeloMapa').addEventListener('change', (e) => { st.modeloMapa = e.target.value; actualizarInicioMapa(); renderMapas(); });
  $('selInicioMapa').addEventListener('change', (e) => { st.inicioMapa = e.target.value; actualizarLeadMapa(); renderMapas(); });
  $('selLeadMapa').addEventListener('change', (e) => { st.leadMapa = Number(e.target.value); renderMapas(); });
  hoverMapas();

  // Animación
  anim.inicio = P.inicios[P.inicios.length - 1];
  llenarSelectoresAnim();
  bindAnimacion();
  setPlayAnim(true);
  prepararAnimacion();
  requestAnimationFrame(bucleAnim);

  renderResumen();
  renderIndice();
  renderMapas();

  let t = null;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => { dimensionarAnim(); renderPluma(); renderError(); renderMapas(); }, 150);
  });
}

iniciar();
