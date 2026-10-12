/* =============================================================
   SST EXPLORER · versión clásica (optimizada)
   -------------------------------------------------------------
   Mismo aspecto que la versión original, pero más rápida:
   - Solo se descargan los fotogramas mensuales; los intermedios
     se interpolan en el navegador (son interpolaciones lineales).
   - Los PNG se decodifican en Web Workers.
   - La paleta se aplica con tablas de color (LUT) sobre buffers
     reutilizados: sin objetos nuevos por píxel.
   - Las streamlines se calculan en Web Workers (en paralelo y por
     adelantado), se guardan en caché y se dibujan agrupadas por
     color: 6 trazos por mapa en lugar de miles.
   ============================================================= */

const CONFIG = {
  metadataPath: "data/metadata.json",
  windBasePath: "data/wind/",
  framesPerMonth: 10,

  // Colores para mostrar SST y anomalías.
  sstMin: 0,
  sstMax: 45,
  anomalyMin: -5,
  anomalyMax: 5,

  // Rango fijo para la diferencia B - A.
  differenceMin: -5,
  differenceMax: 5,

  // Colores SST: azul oscuro -> celeste -> amarillo -> rojo.
  sstColors: [
    [49, 54, 149],
    [69, 117, 180],
    [116, 173, 209],
    [171, 217, 233],
    [255, 255, 191],
    [253, 174, 97],
    [244, 109, 67],
    [215, 48, 39],
    [165, 0, 38]
  ],

  // Colores divergentes para anomalías y diferencias.
  anomalyColors: [
    [35, 55, 170],
    [90, 160, 220],
    [245, 245, 245],
    [240, 145, 75],
    [170, 20, 35]
  ],

  // Colores del viento por velocidad (< 2, < 7, resto).
  windColors: ["#c3c3c3", "#1f742e", "#1c2d9a"],
  windLineWidth: 0.7,
  windArrowWidth: 1.1,
  windCanvasScale: 2,

  // Cachés.
  monthCacheLimit: 140,
  streamCacheLimit: 100, // imágenes de ~1 MB cada una

  // Tiempo máximo que la animación espera a las streamlines
  // de un fotograma antes de continuar (ms).
  windWaitMs: 220
};

const elementos = {
  periodoA: document.getElementById("periodoA"),
  periodoB: document.getElementById("periodoB"),

  btnMesAnterior: document.getElementById("btnMesAnterior"),
  btnMesSiguiente: document.getElementById("btnMesSiguiente"),

  mostrarVientos: document.getElementById("mostrarVientos"),
  mostrarTooltip: document.getElementById("mostrarTooltip"),

  modoDatos: document.getElementById("modoDatos"),
  nivelViento: document.getElementById("nivelViento"),
  timeline: document.getElementById("timeline"),
  btnPlay: document.getElementById("btnPlay"),
  velocidad: document.getElementById("velocidad"),

  canvasA: document.getElementById("canvasA"),
  canvasB: document.getElementById("canvasB"),
  canvasDiff: document.getElementById("canvasDiff"),

  windA: document.getElementById("windA"),
  windB: document.getElementById("windB"),

  fechaA: document.getElementById("fechaA"),
  fechaB: document.getElementById("fechaB"),
  fechaDiff: document.getElementById("fechaDiff"),

  frameCounter: document.getElementById("frameCounter"),
  timelineStart: document.getElementById("timelineStart"),
  timelineEnd: document.getElementById("timelineEnd"),

  minA: document.getElementById("minA"),
  maxA: document.getElementById("maxA"),
  minB: document.getElementById("minB"),
  maxB: document.getElementById("maxB"),
  minDiff: document.getElementById("minDiff"),
  maxDiff: document.getElementById("maxDiff"),

  legendA: document.getElementById("legendA"),
  legendB: document.getElementById("legendB"),
  legendDiff: document.getElementById("legendDiff"),

  tooltipDatos: document.getElementById("tooltipDatos")
};

const mapSize = document.getElementById("mapSize");
const mapSizeValue = document.getElementById("mapSizeValue");

let metadata = null;
let aniosDisponibles = [];

let frameActual = 0;
let totalFrames = 0;
let reproduciendo = false;
let temporizador = null;

const BUFFER_FRAMES = 10;

// Identificadores para descartar resultados antiguos.
let solicitudFrame = 0;
let solicitudViento = 0;
let solicitudTooltip = 0;

// Estado del viento mostrado (para el tooltip).
let vientoActualA = null;
let vientoActualB = null;

let ultimoPunteroTooltip = null;
let canvasTooltipActivo = null;

// ------------------------------------------------------------
// WORKERS
// ------------------------------------------------------------

const workers = [];
const pendientesWorker = new Map();
let siguienteIdWorker = 1;
let turnoWorker = 0;
let decodificarEnWorker = true;

try {
  const cantidad = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
  for (let i = 0; i < cantidad; i++) {
    const w = new Worker("v1-worker.js");
    w.onmessage = (e) => {
      const p = pendientesWorker.get(e.data.id);
      if (!p) return;
      pendientesWorker.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data);
    };
    w.onerror = (e) => console.error("Error en worker:", e.message);
    workers.push(w);
  }
} catch (error) {
  console.warn("Web Workers no disponibles; se usará el hilo principal.", error);
}

function enviarWorker(mensaje, indice = null) {
  if (!workers.length) {
    return Promise.reject(new Error("Este navegador no permite Web Workers."));
  }
  return new Promise((resolve, reject) => {
    const id = siguienteIdWorker++;
    pendientesWorker.set(id, { resolve, reject });
    const i = indice ?? (turnoWorker++ % workers.length);
    workers[i % workers.length].postMessage({ ...mensaje, id });
  });
}

// ------------------------------------------------------------
// INICIO
// ------------------------------------------------------------

async function iniciar() {
  try {
    const respuesta = await fetch(CONFIG.metadataPath);

    if (!respuesta.ok) {
      throw new Error(`No se pudo cargar metadata.json: ${respuesta.status}`);
    }

    metadata = await respuesta.json();

    aniosDisponibles = Object.keys(metadata.anios)
      .map(Number)
      .sort((a, b) => a - b);

    configurarSelectores();
    configurarTooltip();
    configurarEventos();
    configurarLeyendas();
    actualizarTamanoMapas();

    elementos.modoDatos.value = "anomaly";
    construirTablasColor();

    await actualizarComparacion();
    await precargarBuffer(0);

    iniciarAnimacion();
  } catch (error) {
    console.error(error);
    alert(
      "No se pudo iniciar el dashboard. Revisa metadata.json y ejecuta la página mediante un servidor local."
    );
  }
}

// ------------------------------------------------------------
// SELECTORES DE PERIODOS
// ------------------------------------------------------------

function configurarSelectores() {
  elementos.periodoA.innerHTML = "";
  elementos.periodoB.innerHTML = "";

  const pares = [];

  for (let i = 0; i < aniosDisponibles.length - 1; i++) {
    const anio1 = aniosDisponibles[i];
    const anio2 = aniosDisponibles[i + 1];

    if (anio2 !== anio1 + 1) continue;

    if (obtenerNumeroFrames(anio1) > 0 && obtenerNumeroFrames(anio2) > 0) {
      pares.push({ inicio: anio1, fin: anio2 });
    }
  }

  for (const par of pares) {
    const valor = `${par.inicio}_${par.fin}`;
    const texto = `${par.inicio}–${par.fin}`;
    elementos.periodoA.add(new Option(texto, valor));
    elementos.periodoB.add(new Option(texto, valor));
  }

  if (pares.length === 0) {
    throw new Error("No se encontraron pares de años consecutivos.");
  }

  elementos.periodoA.value = "1982_1983";
  elementos.periodoB.value = "1997_1998";
}

function obtenerNumeroFrames(anio) {
  const info = metadata.anios[String(anio)];
  if (!info) return 0;
  return info[elementos.modoDatos.value]?.frames ?? 0;
}

function leerPeriodo(valor) {
  const partes = valor.split("_").map(Number);
  return { inicio: partes[0], fin: partes[1] };
}

// ------------------------------------------------------------
// EVENTOS
// ------------------------------------------------------------

function configurarEventos() {
  elementos.periodoA.addEventListener("change", actualizarComparacion);
  elementos.periodoB.addEventListener("change", actualizarComparacion);

  elementos.modoDatos.addEventListener("change", async () => {
    detenerAnimacion();
    construirTablasColor();
    configurarLeyendas();
    await actualizarComparacion();
    await precargarBuffer(0);
    iniciarAnimacion();
  });

  elementos.nivelViento.addEventListener("change", () => {
    actualizarViento();
    precargarViento(frameActual + 1);
  });

  elementos.mostrarVientos.addEventListener("change", () => {
    actualizarViento();
    if (elementos.mostrarVientos.checked) precargarViento(frameActual + 1);
  });

  elementos.mostrarTooltip.addEventListener("change", () => {
    solicitudTooltip++;

    if (!elementos.mostrarTooltip.checked) {
      elementos.tooltipDatos.hidden = true;
    } else if (ultimoPunteroTooltip && canvasTooltipActivo) {
      actualizarTooltip(ultimoPunteroTooltip, canvasTooltipActivo);
    }
  });

  elementos.btnMesAnterior.addEventListener("click", () => cambiarMes(-1));
  elementos.btnMesSiguiente.addEventListener("click", () => cambiarMes(1));

  elementos.timeline.addEventListener("input", () => {
    detenerAnimacion();
    frameActual = Number(elementos.timeline.value);
    mostrarFrameActual();
    precargarBuffer(frameActual + 1);
  });

  elementos.btnPlay.addEventListener("click", () => {
    if (reproduciendo) detenerAnimacion();
    else iniciarAnimacion();
  });

  mapSize.addEventListener("input", actualizarTamanoMapas);
}

// ------------------------------------------------------------
// COMPARACIÓN Y LÍNEA DE TIEMPO
// ------------------------------------------------------------

async function actualizarComparacion() {
  detenerAnimacion();

  const periodoA = leerPeriodo(elementos.periodoA.value);
  const periodoB = leerPeriodo(elementos.periodoB.value);

  totalFrames = Math.min(obtenerFramesPeriodo(periodoA), obtenerFramesPeriodo(periodoB));

  if (totalFrames <= 0) {
    throw new Error("No hay frames disponibles para comparar.");
  }

  frameActual = 0;
  elementos.timeline.min = 0;
  elementos.timeline.max = totalFrames - 1;
  elementos.timeline.value = 0;

  await mostrarFrameActual();

  // Descargar en segundo plano todos los meses de ambos periodos.
  precargarMesesPeriodo(periodoA);
  precargarMesesPeriodo(periodoB);
}

function obtenerFramesPeriodo(periodo) {
  return obtenerNumeroFrames(periodo.inicio) + obtenerNumeroFrames(periodo.fin);
}

// Traduce un frame del periodo a año, mes y fracción de interpolación.
function infoFrame(periodo, frame) {
  const framesPrimerAnio = obtenerNumeroFrames(periodo.inicio);

  let anio;
  let frameAnual;

  if (frame < framesPrimerAnio) {
    anio = periodo.inicio;
    frameAnual = frame;
  } else {
    anio = periodo.fin;
    frameAnual = frame - framesPrimerAnio;
  }

  const mes = Math.floor(frameAnual / CONFIG.framesPerMonth);
  let alpha = (frameAnual % CONFIG.framesPerMonth) / CONFIG.framesPerMonth;

  let anioSig = anio;
  let mesSig = mes + 1;

  if (mesSig > 11) {
    anioSig = anio + 1;
    mesSig = 0;
  }

  // Si el mes siguiente no existe, mostrar el mes actual.
  if (alpha > 0 && mesesDisponibles(anioSig) <= mesSig) {
    alpha = 0;
  }

  return { anio, frameAnual, mes, alpha, anioSig, mesSig };
}

function mesesDisponibles(anio) {
  return Math.ceil(obtenerNumeroFrames(anio) / CONFIG.framesPerMonth);
}

// ------------------------------------------------------------
// CARGA DE IMÁGENES MENSUALES
// ------------------------------------------------------------

function rutaImagen(anio, modo, frame) {
  const numero = String(frame).padStart(4, "0");
  return `data/${modo}/${anio}/frame_${numero}.png`;
}

let canvasDecodificacion = null;

async function decodificarEnHiloPrincipal(url) {
  const respuesta = await fetch(url);
  if (!respuesta.ok) throw new Error(`No se pudo cargar la imagen: ${url}`);

  const bmp = await createImageBitmap(await respuesta.blob(), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none"
  });

  if (!canvasDecodificacion) canvasDecodificacion = document.createElement("canvas");
  canvasDecodificacion.width = bmp.width;
  canvasDecodificacion.height = bmp.height;

  const ctx = canvasDecodificacion.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, bmp.width, bmp.height);
  ctx.drawImage(bmp, 0, 0);

  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const data = new Uint8Array(bmp.width * bmp.height);

  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = px[j + 3] === 0 ? 0 : px[j];
  }

  return { data, w: bmp.width, h: bmp.height };
}

async function decodificarPNG(ruta) {
  const url = new URL(ruta, location.href).href;

  if (workers.length && decodificarEnWorker) {
    try {
      return await enviarWorker({ type: "decode", url });
    } catch (error) {
      if (!String(error.message).includes("NO_OFFSCREEN")) throw error;
      decodificarEnWorker = false;
    }
  }

  return decodificarEnHiloPrincipal(url);
}

// Caché de meses: valores en escala de grises (0 = sin dato).
const cacheMeses = new Map();

function cargarMes(modo, anio, mes) {
  const clave = `${modo}/${anio}/${mes}`;

  if (cacheMeses.has(clave)) {
    const entrada = cacheMeses.get(clave);
    cacheMeses.delete(clave);
    cacheMeses.set(clave, entrada);
    return entrada.promesa;
  }

  const entrada = { datos: null, promesa: null };

  entrada.promesa = decodificarPNG(rutaImagen(anio, modo, mes * CONFIG.framesPerMonth))
    .then((r) => {
      entrada.datos = r;
      return r;
    })
    .catch((error) => {
      cacheMeses.delete(clave);
      throw error;
    });

  cacheMeses.set(clave, entrada);

  while (cacheMeses.size > CONFIG.monthCacheLimit) {
    cacheMeses.delete(cacheMeses.keys().next().value);
  }

  return entrada.promesa;
}

async function obtenerDatosFrame(periodo, modo, frame) {
  const info = infoFrame(periodo, frame);

  const tareas = [cargarMes(modo, info.anio, info.mes)];
  if (info.alpha > 0) tareas.push(cargarMes(modo, info.anioSig, info.mesSig));

  const [d0, d1] = await Promise.all(tareas);

  return {
    g0: d0.data,
    g1: d1 ? d1.data : null,
    alpha: d1 ? info.alpha : 0,
    ancho: d0.w,
    alto: d0.h,
    anio: info.anio,
    frameAnual: info.frameAnual
  };
}

function precargarMesesPeriodo(periodo) {
  const modo = elementos.modoDatos.value;
  for (const anio of [periodo.inicio, periodo.fin]) {
    const meses = mesesDisponibles(anio);
    for (let m = 0; m < meses; m++) {
      cargarMes(modo, anio, m).catch(() => {});
    }
  }
}

// ------------------------------------------------------------
// PRECARGA DE FRAMES
// ------------------------------------------------------------

function framesSiguientes(frameInicial) {
  const frames = [];
  for (let i = 0; i < BUFFER_FRAMES; i++) {
    let frame = frameInicial + i;
    if (frame >= totalFrames) frame -= totalFrames;
    if (frame >= 0 && frame < totalFrames) frames.push(frame);
  }
  return frames;
}

async function precargarBuffer(frameInicial) {
  if (totalFrames <= 0) return;

  const periodoA = leerPeriodo(elementos.periodoA.value);
  const periodoB = leerPeriodo(elementos.periodoB.value);
  const modo = elementos.modoDatos.value;

  precargarViento(frameInicial);

  const tareas = [];
  for (const frame of framesSiguientes(frameInicial)) {
    tareas.push(obtenerDatosFrame(periodoA, modo, frame));
    tareas.push(obtenerDatosFrame(periodoB, modo, frame));
  }

  try {
    await Promise.all(tareas);
  } catch (error) {
    console.error("Error precargando frames:", error);
  }
}

function precargarViento(frameInicial) {
  if (!elementos.mostrarVientos.checked || totalFrames <= 0) return;

  const periodoA = leerPeriodo(elementos.periodoA.value);
  const periodoB = leerPeriodo(elementos.periodoB.value);
  const nivel = elementos.nivelViento.value;

  for (const frame of framesSiguientes(frameInicial)) {
    solicitarStreamlines(periodoA, frame, nivel).catch(() => {});
    solicitarStreamlines(periodoB, frame, nivel).catch(() => {});
  }
}

// ------------------------------------------------------------
// MOSTRAR FRAME
// ------------------------------------------------------------

async function mostrarFrameActual() {
  const id = ++solicitudFrame;
  solicitudTooltip++;

  const periodoA = leerPeriodo(elementos.periodoA.value);
  const periodoB = leerPeriodo(elementos.periodoB.value);
  const modo = elementos.modoDatos.value;
  const frame = frameActual;

  try {
    const [datosA, datosB] = await Promise.all([
      obtenerDatosFrame(periodoA, modo, frame),
      obtenerDatosFrame(periodoB, modo, frame)
    ]);

    // Un frame más reciente ya fue solicitado.
    if (id !== solicitudFrame) return;

    datosActualesA = datosA;
    datosActualesB = datosB;

    dibujarCampo(elementos.canvasA, datosA);
    dibujarCampo(elementos.canvasB, datosB);
    dibujarDiferencia(elementos.canvasDiff, datosA, datosB);

    const fechaA = obtenerEtiquetaFecha(periodoA, frame);
    const fechaB = obtenerEtiquetaFecha(periodoB, frame);

    elementos.fechaA.textContent = fechaA;
    elementos.fechaB.textContent = fechaB;
    elementos.fechaDiff.textContent = `${fechaB} − ${fechaA}`;
    elementos.frameCounter.textContent = `${fechaA} | ${fechaB}`;

    await actualizarViento(CONFIG.windWaitMs);

    if (ultimoPunteroTooltip && canvasTooltipActivo) {
      actualizarTooltip(ultimoPunteroTooltip, canvasTooltipActivo);
    }
  } catch (error) {
    console.error(error);
    detenerAnimacion();
  }
}

async function cambiarMes(direccion) {
  if (totalFrames <= 0) return;

  detenerAnimacion();

  const framesPorMes = CONFIG.framesPerMonth;
  const mesesTotales = Math.ceil(totalFrames / framesPorMes);
  const mesActual = Math.floor(frameActual / framesPorMes);
  const mesNuevo = (mesActual + direccion + mesesTotales) % mesesTotales;

  frameActual = mesNuevo * framesPorMes;
  elementos.timeline.value = frameActual;

  await mostrarFrameActual();
  precargarBuffer(frameActual + 1);
}

// ------------------------------------------------------------
// FECHAS
// ------------------------------------------------------------

const NOMBRES_MESES = [
  "Ene", "Feb", "Mar", "Abr", "May", "Jun",
  "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"
];

function obtenerEtiquetaFecha(periodo, frame) {
  const info = infoFrame(periodo, frame);
  return `${NOMBRES_MESES[Math.min(11, info.mes)]} ${info.anio}`;
}

// ------------------------------------------------------------
// TABLAS DE COLOR (LUT)
// ------------------------------------------------------------

// Escala de decodificación del PNG (gris 1..255 -> valor físico).
function obtenerEscala(modo) {
  if (modo === "anomaly") {
    return {
      min: metadata.anomaly_min ?? CONFIG.anomalyMin,
      max: metadata.anomaly_max ?? CONFIG.anomalyMax
    };
  }
  return {
    min: metadata.sst_min ?? CONFIG.sstMin,
    max: metadata.sst_max ?? CONFIG.sstMax
  };
}

function interpolarPaleta(valor, paleta) {
  const posicion = valor * (paleta.length - 1);
  const indice = Math.floor(posicion);
  const fraccion = posicion - indice;

  if (indice >= paleta.length - 1) return paleta[paleta.length - 1];

  const c1 = paleta[indice];
  const c2 = paleta[indice + 1];

  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * fraccion),
    Math.round(c1[1] + (c2[1] - c1[1]) * fraccion),
    Math.round(c1[2] + (c2[2] - c1[2]) * fraccion)
  ];
}

function empaquetarColor(c) {
  // ImageData en memoria little-endian: 0xAABBGGRR
  return ((255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;
}

const LUT_DIFF_SIZE = 1024;
let lutCampo = new Uint32Array(1021);
let lutDiferencia = new Uint32Array(LUT_DIFF_SIZE);
let escalaActual = { min: -5, max: 5 };

// LUT del campo indexada por gris*4 (resolución de 1/4 de nivel
// para que la interpolación entre meses sea suave).
function construirTablasColor() {
  const modo = elementos.modoDatos.value;
  const escala = obtenerEscala(modo);
  const paleta = modo === "anomaly" ? CONFIG.anomalyColors : CONFIG.sstColors;
  escalaActual = escala;

  lutCampo = new Uint32Array(1021);
  for (let k = 4; k <= 1020; k++) {
    const gris = k / 4;
    const valor = escala.min + ((gris - 1) / 254) * (escala.max - escala.min);
    const n = limitar((valor - escala.min) / (escala.max - escala.min), 0, 1);
    lutCampo[k] = empaquetarColor(interpolarPaleta(n, paleta));
  }

  lutDiferencia = new Uint32Array(LUT_DIFF_SIZE);
  for (let k = 0; k < LUT_DIFF_SIZE; k++) {
    const n = k / (LUT_DIFF_SIZE - 1);
    lutDiferencia[k] = empaquetarColor(interpolarPaleta(n, CONFIG.anomalyColors));
  }
}

function limitar(valor, min, max) {
  return Math.max(min, Math.min(max, valor));
}

// ------------------------------------------------------------
// DIBUJO DE MAPAS
// ------------------------------------------------------------

let datosActualesA = null;
let datosActualesB = null;

// Buffers de imagen reutilizados por canvas.
const buffersCanvas = new WeakMap();

function bufferPara(canvas, ancho, alto) {
  let b = buffersCanvas.get(canvas);

  if (!b || b.ancho !== ancho || b.alto !== alto) {
    canvas.width = ancho;
    canvas.height = alto;
    const ctx = canvas.getContext("2d");
    const imagen = ctx.createImageData(ancho, alto);
    b = {
      ancho,
      alto,
      ctx,
      imagen,
      pixeles: new Uint32Array(imagen.data.buffer)
    };
    buffersCanvas.set(canvas, b);
  }

  return b;
}

// Gris interpolado entre dos meses (0 = sin dato).
function grisInterpolado(g0, g1, alpha, i) {
  const a = g0[i];
  if (alpha === 0) return a;
  const b = g1[i];
  if (a === 0 || b === 0) return alpha < 0.5 ? a : b;
  return a + (b - a) * alpha;
}

function dibujarCampo(canvas, d) {
  const b = bufferPara(canvas, d.ancho, d.alto);
  const px = b.pixeles;
  const lut = lutCampo;
  const g0 = d.g0;
  const n = px.length;

  if (d.alpha === 0) {
    for (let i = 0; i < n; i++) {
      px[i] = lut[g0[i] << 2];
    }
  } else {
    const g1 = d.g1;
    const a = d.alpha;
    for (let i = 0; i < n; i++) {
      const x = g0[i];
      const y = g1[i];
      if (x === 0 || y === 0) {
        px[i] = lut[(a < 0.5 ? x : y) << 2];
      } else {
        px[i] = lut[Math.round((x + (y - x) * a) * 4)];
      }
    }
  }

  b.ctx.putImageData(b.imagen, 0, 0);
}

function dibujarDiferencia(canvas, dA, dB) {
  const b = bufferPara(canvas, dA.ancho, dA.alto);
  const px = b.pixeles;
  const lut = lutDiferencia;
  const n = Math.min(px.length, dA.g0.length, dB.g0.length);

  // Diferencia física = (grisB − grisA) · rango / 254
  const factor = (escalaActual.max - escalaActual.min) / 254;
  const dmin = CONFIG.differenceMin;
  const escalaLut = (LUT_DIFF_SIZE - 1) / (CONFIG.differenceMax - CONFIG.differenceMin);
  const max = LUT_DIFF_SIZE - 1;

  for (let i = 0; i < n; i++) {
    const a = grisInterpolado(dA.g0, dA.g1, dA.alpha, i);
    const c = grisInterpolado(dB.g0, dB.g1, dB.alpha, i);

    if (a === 0 || c === 0) {
      px[i] = 0;
      continue;
    }

    let k = Math.round(((c - a) * factor - dmin) * escalaLut);
    if (k < 0) k = 0;
    else if (k > max) k = max;
    px[i] = lut[k];
  }

  b.ctx.putImageData(b.imagen, 0, 0);
}

// ------------------------------------------------------------
// LEYENDAS
// ------------------------------------------------------------

function configurarLeyendas() {
  const modo = elementos.modoDatos.value;

  const min = modo === "anomaly" ? CONFIG.anomalyMin : CONFIG.sstMin;
  const max = modo === "anomaly" ? CONFIG.anomalyMax : CONFIG.sstMax;
  const gradiente = modo === "anomaly" ? CONFIG.anomalyColors : CONFIG.sstColors;

  const cssGradiente = crearGradienteCSS(gradiente);

  elementos.legendA.style.background = cssGradiente;
  elementos.legendB.style.background = cssGradiente;
  elementos.legendDiff.style.background = crearGradienteCSS(CONFIG.anomalyColors);

  elementos.minA.textContent = `${min} °C`;
  elementos.maxA.textContent = `${max} °C`;
  elementos.minB.textContent = `${min} °C`;
  elementos.maxB.textContent = `${max} °C`;
  elementos.minDiff.textContent = `${CONFIG.differenceMin} °C`;
  elementos.maxDiff.textContent = `${CONFIG.differenceMax} °C`;
}

function crearGradienteCSS(paleta) {
  const paradas = paleta.map((color, i) => {
    const porcentaje = (i / (paleta.length - 1)) * 100;
    return `rgb(${color.join(",")}) ${porcentaje}%`;
  });
  return `linear-gradient(to right, ${paradas.join(", ")})`;
}

// ------------------------------------------------------------
// ANIMACIÓN
// ------------------------------------------------------------

async function reproducirSiguienteFrame() {
  if (!reproduciendo) return;

  const inicio = performance.now();

  frameActual = frameActual >= totalFrames - 1 ? 0 : frameActual + 1;
  elementos.timeline.value = frameActual;

  await mostrarFrameActual();

  if (!reproduciendo) return;

  // Preparar los siguientes frames sin detener la animación.
  precargarBuffer(frameActual + 1);

  // Descontar el tiempo de dibujo del intervalo elegido.
  const espera = Math.max(0, Number(elementos.velocidad.value) - (performance.now() - inicio));
  temporizador = setTimeout(reproducirSiguienteFrame, espera);
}

async function iniciarAnimacion() {
  if (reproduciendo) return;

  reproduciendo = true;
  elementos.btnPlay.textContent = "⏸ Pausar";

  await precargarBuffer(frameActual + 1);

  if (!reproduciendo) return;

  reproducirSiguienteFrame();
}

function detenerAnimacion() {
  reproduciendo = false;

  if (temporizador !== null) {
    clearTimeout(temporizador);
    temporizador = null;
  }

  elementos.btnPlay.textContent = "▶ Reproducir";
}

// ------------------------------------------------------------
// TAMAÑO DE MAPAS
// ------------------------------------------------------------

function actualizarTamanoMapas() {
  const altura = Number(mapSize.value);
  document.documentElement.style.setProperty("--map-height", `${altura}px`);
  mapSizeValue.textContent = `${altura} px`;
}

// ============================================================
// VIENTO / STREAMLINES
// ============================================================

const cacheStreamlines = new Map();
const streamlinesPendientes = new Map();

function claveStreamlines(periodo, frame, nivel) {
  const info = infoFrame(periodo, frame);
  return { clave: `${nivel}|${info.anio}|${info.frameAnual}`, info };
}

function solicitarStreamlines(periodo, frame, nivel) {
  const { clave, info } = claveStreamlines(periodo, frame, nivel);

  if (cacheStreamlines.has(clave)) {
    const r = cacheStreamlines.get(clave);
    cacheStreamlines.delete(clave);
    cacheStreamlines.set(clave, r);
    return Promise.resolve(r);
  }

  if (streamlinesPendientes.has(clave)) {
    return streamlinesPendientes.get(clave);
  }

  const promesa = enviarWorker({
    type: "stream",
    level: nivel,
    year: info.anio,
    month: info.mes,
    alpha: info.alpha,
    nextYear: info.anioSig,
    nextMonth: info.mesSig,
    style: {
      scale: CONFIG.windCanvasScale,
      lineWidth: CONFIG.windLineWidth,
      arrowWidth: CONFIG.windArrowWidth,
      colors: CONFIG.windColors
    }
  })
    .then((r) => {
      r.clave = clave;
      cacheStreamlines.set(clave, r);
      while (cacheStreamlines.size > CONFIG.streamCacheLimit) {
        const antigua = cacheStreamlines.keys().next().value;
        cacheStreamlines.get(antigua).bitmap?.close();
        cacheStreamlines.delete(antigua);
      }
      return r;
    })
    .finally(() => {
      streamlinesPendientes.delete(clave);
    });

  streamlinesPendientes.set(clave, promesa);
  return promesa;
}

function obtenerStreamlinesEnCache(periodo, frame, nivel) {
  return cacheStreamlines.get(claveStreamlines(periodo, frame, nivel).clave) || null;
}

// Respaldo (si el worker no puede dibujar): Path2D agrupados por color.
function rutasStreamlines(r) {
  if (r.rutas) return r.rutas;

  const lineas = r.runs.map(({ coords, lens }) => {
    const p = new Path2D();
    let k = 0;
    for (let j = 0; j < lens.length; j++) {
      p.moveTo(coords[k], coords[k + 1]);
      k += 2;
      for (let q = 1; q < lens[j]; q++, k += 2) p.lineTo(coords[k], coords[k + 1]);
    }
    return p;
  });

  const flechas = [new Path2D(), new Path2D(), new Path2D()];
  const a = r.arrows;
  for (let i = 0; i < a.length; i += 7) {
    const p = flechas[a[i + 6]];
    p.moveTo(a[i], a[i + 1]);
    p.lineTo(a[i + 2], a[i + 3]);
    p.lineTo(a[i + 4], a[i + 5]);
  }

  r.rutas = { lineas, flechas };
  return r.rutas;
}

function prepararCanvasViento(canvas, ancho, alto) {
  const escala = CONFIG.windCanvasScale;
  const w = ancho * escala;
  const h = alto * escala;

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.setTransform(escala, 0, 0, escala, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  return ctx;
}

function dibujarStreamlines(canvas, r) {
  if (!canvas || !r) return;

  const ctx = prepararCanvasViento(canvas, r.width, r.height);

  // Caso normal: imagen ya dibujada por el worker.
  if (r.bitmap) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(r.bitmap, 0, 0);
    return;
  }

  const { lineas, flechas } = rutasStreamlines(r);

  ctx.lineJoin = "miter";
  ctx.lineWidth = CONFIG.windLineWidth;
  for (let c = 0; c < 3; c++) {
    ctx.strokeStyle = CONFIG.windColors[c];
    ctx.stroke(lineas[c]);
  }

  ctx.lineJoin = "round";
  ctx.lineWidth = CONFIG.windArrowWidth;
  for (let c = 0; c < 3; c++) {
    ctx.strokeStyle = CONFIG.windColors[c];
    ctx.stroke(flechas[c]);
  }
}

function limpiarCanvasViento(canvas) {
  if (!canvas) return;
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------
// ACTUALIZAR VIENTO
// ------------------------------------------------------------

async function actualizarViento(esperaMaxima = Infinity) {
  const idSolicitud = ++solicitudViento;

  if (!elementos.mostrarVientos.checked) {
    vientoActualA = null;
    vientoActualB = null;

    limpiarCanvasViento(elementos.windA);
    limpiarCanvasViento(elementos.windB);

    if (ultimoPunteroTooltip && canvasTooltipActivo) {
      actualizarTooltip(ultimoPunteroTooltip, canvasTooltipActivo);
    }
    return;
  }

  const nivel = elementos.nivelViento.value;
  const periodoA = leerPeriodo(elementos.periodoA.value);
  const periodoB = leerPeriodo(elementos.periodoB.value);
  const frame = frameActual;

  vientoActualA = { periodo: periodoA, frame, nivel };
  vientoActualB = { periodo: periodoB, frame, nivel };

  const tareas = [
    [elementos.windA, periodoA],
    [elementos.windB, periodoB]
  ].map(([canvas, periodo]) => {
    const enCache = obtenerStreamlinesEnCache(periodo, frame, nivel);

    if (enCache) {
      dibujarStreamlines(canvas, enCache);
      return Promise.resolve();
    }

    // Se dibuja en cuanto llegue, si sigue siendo el frame actual.
    return solicitarStreamlines(periodo, frame, nivel)
      .then((r) => {
        if (
          idSolicitud === solicitudViento ||
          (frame === frameActual && nivel === elementos.nivelViento.value &&
           elementos.mostrarVientos.checked)
        ) {
          dibujarStreamlines(canvas, r);
        }
      })
      .catch((error) => {
        if (idSolicitud === solicitudViento) {
          console.error("Error cargando viento:", error);
        }
      });
  });

  const todas = Promise.all(tareas);

  if (Number.isFinite(esperaMaxima)) {
    await Promise.race([todas, esperar(esperaMaxima)]);
  } else {
    await todas;
  }

  if (idSolicitud === solicitudViento && ultimoPunteroTooltip && canvasTooltipActivo) {
    actualizarTooltip(ultimoPunteroTooltip, canvasTooltipActivo);
  }
}

// ------------------------------------------------------------
// VIENTO PARA EL TOOLTIP (lectura directa del binario)
// ------------------------------------------------------------

const metadataVientoTooltip = new Map();
const datosVientoTooltip = new Map();

function cargarPerezoso(mapa, clave, cargador) {
  let e = mapa.get(clave);
  if (!e) {
    e = { listo: false, valor: null };
    mapa.set(clave, e);
    cargador().then(
      (v) => {
        e.valor = v;
        e.listo = true;
        if (ultimoPunteroTooltip && canvasTooltipActivo) {
          actualizarTooltip(ultimoPunteroTooltip, canvasTooltipActivo);
        }
      },
      (error) => {
        console.error(error);
        mapa.delete(clave);
      }
    );
  }
  return e;
}

function metaVientoTooltip(nivel) {
  return cargarPerezoso(metadataVientoTooltip, nivel, async () => {
    const r = await fetch(`${CONFIG.windBasePath}${nivel}/metadata.json`);
    if (!r.ok) throw new Error(`No se pudo cargar metadata del viento: ${nivel}`);
    return r.json();
  });
}

function anioVientoTooltip(nivel, anio) {
  const e = cargarPerezoso(datosVientoTooltip, `${nivel}/${anio}`, async () => {
    const r = await fetch(`${CONFIG.windBasePath}${nivel}/${anio}.bin`);
    if (!r.ok) throw new Error(`No se pudo cargar viento: ${nivel}/${anio}`);
    return new Int16Array(await r.arrayBuffer());
  });
  while (datosVientoTooltip.size > 8) {
    datosVientoTooltip.delete(datosVientoTooltip.keys().next().value);
  }
  return e;
}

function obtenerVelocidadViento(estado, nx, ny) {
  if (!estado) return null;

  const meta = metaVientoTooltip(estado.nivel);
  if (!meta.listo) return null;

  const m = meta.valor;
  const info = infoFrame(estado.periodo, estado.frame);
  const dA = anioVientoTooltip(estado.nivel, info.anio);
  if (!dA.listo) return null;

  let dB = null;
  if (info.alpha > 0) {
    const e = info.anioSig === info.anio ? dA : anioVientoTooltip(estado.nivel, info.anioSig);
    if (!e.listo) return null;
    dB = e.valor;
  }

  const W = m.width;
  const H = m.height;
  const n = W * H;
  const escala = m.encoding.scale;
  const faltante = m.encoding.missingValue;

  let x = nx * (W - 1);
  const y = ny * (H - 1);
  x = ((x % W) + W) % W;
  if (y < 0 || y >= H - 1) return null;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = (x0 + 1) % W;
  const y1 = Math.min(y0 + 1, H - 1);
  const fx = x - x0;
  const fy = y - y0;
  const indices = [y0 * W + x0, y0 * W + x1, y1 * W + x0, y1 * W + x1];
  const pesos = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];

  const leer = (datos, mes) => {
    const off = mes * n * 2;
    if (off + n * 2 > datos.length) return null;
    let u = 0;
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const uu = datos[off + indices[k]];
      const vv = datos[off + n + indices[k]];
      if (uu === faltante || vv === faltante) return null;
      u += uu * pesos[k];
      v += vv * pesos[k];
    }
    return { u: u * escala, v: v * escala };
  };

  let r = leer(dA.valor, info.mes);
  if (!r) return null;

  if (dB) {
    const s = leer(dB, info.mesSig);
    if (!s) return null;
    r = {
      u: r.u * (1 - info.alpha) + s.u * info.alpha,
      v: r.v * (1 - info.alpha) + s.v * info.alpha
    };
  }

  return { u: r.u, v: r.v, velocidad: Math.hypot(r.u, r.v) };
}

// ============================================================
// TOOLTIP
// ============================================================

function numeroTooltip(valor, decimales = 2, unidad = "") {
  if (!Number.isFinite(valor)) return "Sin datos";
  return `${valor.toFixed(decimales)}${unidad}`;
}

function muestrearSST(datos, nx, ny) {
  if (!datos) return NaN;

  const x = Math.max(0, Math.min(datos.ancho - 1, Math.round(nx * (datos.ancho - 1))));
  const y = Math.max(0, Math.min(datos.alto - 1, Math.round(ny * (datos.alto - 1))));
  const gris = grisInterpolado(datos.g0, datos.g1, datos.alpha, y * datos.ancho + x);

  if (gris === 0) return NaN;

  return escalaActual.min + ((gris - 1) / 254) * (escalaActual.max - escalaActual.min);
}

function obtenerAreaImagen(canvas) {
  const rect = canvas.getBoundingClientRect();

  if (rect.width <= 0 || rect.height <= 0 || canvas.width <= 0 || canvas.height <= 0) {
    return null;
  }

  const proporcionImagen = canvas.width / canvas.height;
  const proporcionCanvas = rect.width / rect.height;

  let ancho;
  let alto;

  if (proporcionImagen > proporcionCanvas) {
    ancho = rect.width;
    alto = ancho / proporcionImagen;
  } else {
    alto = rect.height;
    ancho = alto * proporcionImagen;
  }

  return {
    left: rect.left + (rect.width - ancho) / 2,
    top: rect.top + (rect.height - alto) / 2,
    width: ancho,
    height: alto
  };
}

function actualizarTooltip(evento, canvas) {
  solicitudTooltip++;
  const tooltip = elementos.tooltipDatos;

  if (!elementos.mostrarTooltip.checked) {
    tooltip.hidden = true;
    return;
  }

  const area = obtenerAreaImagen(canvas);

  if (
    !area ||
    evento.clientX < area.left ||
    evento.clientX >= area.left + area.width ||
    evento.clientY < area.top ||
    evento.clientY >= area.top + area.height
  ) {
    tooltip.hidden = true;
    return;
  }

  const nx = (evento.clientX - area.left) / area.width;
  const ny = (evento.clientY - area.top) / area.height;

  const longitud360 = nx * 360;
  const longitud = ((longitud360 + 180) % 360) - 180;
  const latitud = 90 - ny * 180;

  const modo = elementos.modoDatos.value;
  const nivel = elementos.nivelViento.value;
  const periodoA = leerPeriodo(elementos.periodoA.value);
  const periodoB = leerPeriodo(elementos.periodoB.value);

  if (!datosActualesA || !datosActualesB) return;

  const valorCampoA = muestrearSST(datosActualesA, nx, ny);
  const valorCampoB = muestrearSST(datosActualesB, nx, ny);

  const vientoA = obtenerVelocidadViento(vientoActualA, nx, ny);
  const vientoB = obtenerVelocidadViento(vientoActualB, nx, ny);

  const velocidadA = vientoA?.velocidad ?? NaN;
  const velocidadB = vientoB?.velocidad ?? NaN;

  const etiquetaVariable = modo === "anomaly" ? "Anomalía SST" : "SST absoluta";
  const unidadTemperatura = " °C";

  tooltip.innerHTML = `
  <div class="tooltip-coordenadas">
    <span>Lat: <strong>${latitud.toFixed(2)}°</strong></span>
    <span>Lon: <strong>${longitud.toFixed(2)}°</strong></span>
  </div>

  <div class="tooltip-comparacion">
    <div class="tooltip-columna">
      <div class="tooltip-periodo">Periodo A</div>
      <div class="tooltip-anio">${periodoA.inicio}–${periodoA.fin}</div>
      <div class="tooltip-dato">
        ${etiquetaVariable}
        <strong>${numeroTooltip(valorCampoA, 2, unidadTemperatura)}</strong>
      </div>
      <div class="tooltip-dato">
        Velocidad del viento (${nivel})
        <strong>${numeroTooltip(velocidadA, 2, " m/s")}</strong>
      </div>
      <div class="tooltip-dato">
        U (este-oeste)
        <strong>${numeroTooltip(vientoA?.u ?? NaN, 2, " m/s")}</strong>
      </div>
      <div class="tooltip-dato">
        V (norte-sur)
        <strong>${numeroTooltip(vientoA?.v ?? NaN, 2, " m/s")}</strong>
      </div>
    </div>

    <div class="tooltip-columna">
      <div class="tooltip-periodo">Periodo B</div>
      <div class="tooltip-anio">${periodoB.inicio}–${periodoB.fin}</div>
      <div class="tooltip-dato">
        ${etiquetaVariable}
        <strong>${numeroTooltip(valorCampoB, 2, unidadTemperatura)}</strong>
      </div>
      <div class="tooltip-dato">
        Velocidad del viento (${nivel})
        <strong>${numeroTooltip(velocidadB, 2, " m/s")}</strong>
      </div>
      <div class="tooltip-dato">
        U (este-oeste)
        <strong>${numeroTooltip(vientoB?.u ?? NaN, 2, " m/s")}</strong>
      </div>
      <div class="tooltip-dato">
        V (norte-sur)
        <strong>${numeroTooltip(vientoB?.v ?? NaN, 2, " m/s")}</strong>
      </div>
    </div>
  </div>

  <div class="tooltip-diferencia">
    <strong>Diferencia (B − A)</strong>
    <div class="tooltip-diferencia-fila">
      <span>${etiquetaVariable}</span>
      <strong>${numeroTooltip(valorCampoB - valorCampoA, 2, unidadTemperatura)}</strong>
    </div>
    <div class="tooltip-diferencia-fila">
      <span>Velocidad del viento (${nivel})</span>
      <strong>${numeroTooltip(velocidadB - velocidadA, 2, " m/s")}</strong>
    </div>
  </div>

  <div class="tooltip-nota">
    ${modo === "anomaly"
      ? "Anomalía respecto a la climatología."
      : "Temperatura superficial del mar absoluta."}
  </div>
`;

  tooltip.hidden = false;

  const margen = 12;
  const ancho = tooltip.offsetWidth;
  const alto = tooltip.offsetHeight;

  const izquierda = Math.max(
    margen,
    Math.min(evento.clientX + 14, window.innerWidth - ancho - margen)
  );

  const arriba = Math.max(
    margen,
    Math.min(evento.clientY + 14, window.innerHeight - alto - margen)
  );

  tooltip.style.left = `${izquierda}px`;
  tooltip.style.top = `${arriba}px`;
}

function configurarTooltip() {
  const tooltip = elementos.tooltipDatos;

  // En móviles, cerrar el tooltip al tocar fuera de los mapas.
  document.addEventListener("pointerdown", (evento) => {
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    if (tooltip.hidden) return;

    if (evento.target.closest("#canvasA, #canvasB, #windA, #windB")) return;

    ultimoPunteroTooltip = null;
    canvasTooltipActivo = null;
    solicitudTooltip++;
    tooltip.hidden = true;
  });

  // Limitar las actualizaciones del tooltip a una por fotograma.
  let pendiente = false;

  const programar = (evento, canvas) => {
    ultimoPunteroTooltip = { clientX: evento.clientX, clientY: evento.clientY };
    canvasTooltipActivo = canvas;

    if (pendiente) return;
    pendiente = true;

    requestAnimationFrame(() => {
      pendiente = false;
      if (ultimoPunteroTooltip && canvasTooltipActivo) {
        actualizarTooltip(ultimoPunteroTooltip, canvasTooltipActivo);
      }
    });
  };

  [elementos.canvasA, elementos.canvasB].forEach((canvas) => {
    canvas.addEventListener("pointermove", (evento) => {
      if (evento.pointerType === "touch") evento.preventDefault();
      programar(evento, canvas);
    });

    canvas.addEventListener("pointerleave", (evento) => {
      if (evento.pointerType === "touch") return;

      if (canvasTooltipActivo === canvas) {
        ultimoPunteroTooltip = null;
        canvasTooltipActivo = null;
        solicitudTooltip++;
        tooltip.hidden = true;
      }
    });

    canvas.addEventListener("pointerdown", (evento) => {
      if (evento.pointerType !== "touch") return;
      programar(evento, canvas);
    });

    canvas.addEventListener("pointerup", (evento) => {
      if (evento.pointerType !== "touch") return;
      programar(evento, canvas);
    });
  });
}

// ------------------------------------------------------------
// EJECUTAR
// ------------------------------------------------------------

iniciar();
