const CONFIG = {
  metadataPath: "data/metadata.json",

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
  ]
};


const elementos = {
  periodoA: document.getElementById("periodoA"),
  periodoB: document.getElementById("periodoB"),
  modoDatos: document.getElementById("modoDatos"),
  timeline: document.getElementById("timeline"),
  btnPlay: document.getElementById("btnPlay"),
  velocidad: document.getElementById("velocidad"),

  canvasA: document.getElementById("canvasA"),
  canvasB: document.getElementById("canvasB"),
  canvasDiff: document.getElementById("canvasDiff"),

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
  legendDiff: document.getElementById("legendDiff")
};


let metadata = null;
let aniosDisponibles = [];

let frameActual = 0;
let totalFrames = 0;
let reproduciendo = false;
let temporizador = null;


// ------------------------------------------------------------
// CACHÉS
// ------------------------------------------------------------

// Caché de imágenes descargadas/decodificadas por el navegador.
const cacheImagenes = new Map();

// Caché de imágenes convertidas a valores físicos.
const cacheValores = new Map();


// ------------------------------------------------------------
// BUFFER DE ANIMACIÓN
// ------------------------------------------------------------

// Número de frames que intentamos tener preparados
// por delante de la reproducción.
const BUFFER_FRAMES = 10;

const framesPrecargados = new Set();


// ------------------------------------------------------------
// TAMAÑO DE MAPAS
// ------------------------------------------------------------

const mapSize = document.getElementById("mapSize");
const mapSizeValue = document.getElementById("mapSizeValue");


// ------------------------------------------------------------
// INICIO
// ------------------------------------------------------------

async function iniciar() {
  try {
    const respuesta = await fetch(CONFIG.metadataPath);

    if (!respuesta.ok) {
      throw new Error(
        `No se pudo cargar metadata.json: ${respuesta.status}`
      );
    }

    metadata = await respuesta.json();

    aniosDisponibles = Object.keys(metadata.anios)
      .map(Number)
      .sort((a, b) => a - b);

    configurarSelectores();
    configurarEventos();
    configurarLeyendas();
    actualizarTamanoMapas();

    // Variable inicial.
    modoDatos.value = "anomaly";

    // Carga el primer frame.
    await actualizarComparacion();

    // --------------------------------------------------------
    // PRE-CARGA INICIAL
    // --------------------------------------------------------
    // Preparamos varios frames antes de comenzar la animación.
    await precargarBuffer(0);

    // Iniciar automáticamente.
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

    // Solo permitir años consecutivos.
    if (anio2 !== anio1 + 1) continue;

    const frames1 = obtenerNumeroFrames(anio1);
    const frames2 = obtenerNumeroFrames(anio2);

    if (frames1 > 0 && frames2 > 0) {

      pares.push({
        inicio: anio1,
        fin: anio2,
        frames: frames1 + frames2
      });
    }
  }

  for (const par of pares) {

    const valor = `${par.inicio}_${par.fin}`;
    const texto = `${par.inicio}–${par.fin}`;

    elementos.periodoA.add(
      new Option(texto, valor)
    );

    elementos.periodoB.add(
      new Option(texto, valor)
    );
  }

  if (pares.length === 0) {
    throw new Error(
      "No se encontraron pares de años consecutivos."
    );
  }

  // Valores iniciales.
  elementos.periodoA.value = "1982_1983";
  elementos.periodoB.value = "1997_1998";
}


function obtenerNumeroFrames(anio) {

  const info = metadata.anios[String(anio)];

  if (!info) return 0;

  const modo = elementos.modoDatos.value;

  return info[modo]?.frames ?? 0;
}


function leerPeriodo(valor) {

  const partes = valor
    .split("_")
    .map(Number);

  return {
    inicio: partes[0],
    fin: partes[1]
  };
}


// ------------------------------------------------------------
// EVENTOS
// ------------------------------------------------------------

function configurarEventos() {

  elementos.periodoA.addEventListener(
    "change",
    actualizarComparacion
  );

  elementos.periodoB.addEventListener(
    "change",
    actualizarComparacion
  );


  elementos.modoDatos.addEventListener(
    "change",
    async () => {

      detenerAnimacion();

      configurarLeyendas();

      await actualizarComparacion();

      await precargarBuffer(0);

      iniciarAnimacion();
    }
  );


  elementos.timeline.addEventListener(
    "input",
    async () => {

      detenerAnimacion();

      frameActual =
        Number(elementos.timeline.value);

      await mostrarFrameActual();

      // Preparamos frames cercanos al nuevo punto.
      await precargarBuffer(frameActual + 1);
    }
  );


  elementos.btnPlay.addEventListener(
    "click",
    () => {

      if (reproduciendo) {
        detenerAnimacion();
      } else {
        iniciarAnimacion();
      }
    }
  );


  elementos.velocidad.addEventListener(
    "change",
    () => {

      // No hace falta reiniciar la animación.
      // La nueva velocidad se utilizará en
      // el siguiente frame.
    }
  );


  mapSize.addEventListener(
    "input",
    () => {
      actualizarTamanoMapas();
    }
  );
}


// ------------------------------------------------------------
// COMPARACIÓN Y LÍNEA DE TIEMPO
// ------------------------------------------------------------

async function actualizarComparacion() {

  detenerAnimacion();

  // El buffer anterior ya no corresponde
  // necesariamente al nuevo periodo.
  framesPrecargados.clear();

  const periodoA =
    leerPeriodo(elementos.periodoA.value);

  const periodoB =
    leerPeriodo(elementos.periodoB.value);


  const framesA =
    obtenerFramesPeriodo(periodoA);

  const framesB =
    obtenerFramesPeriodo(periodoB);


  // Usa el tramo común de ambos periodos.
  totalFrames =
    Math.min(framesA, framesB);


  if (totalFrames <= 0) {

    throw new Error(
      "No hay frames disponibles para comparar."
    );
  }


  frameActual = 0;


  elementos.timeline.min = 0;

  elementos.timeline.max =
    totalFrames - 1;

  elementos.timeline.value = 0;


  elementos.timelineStart.textContent =
    `${periodoA.inicio} – ${periodoA.fin}`;


  elementos.timelineEnd.textContent =
    `${periodoB.inicio} – ${periodoB.fin}`;


  await mostrarFrameActual();
}


function obtenerFramesPeriodo(periodo) {

  const frames1 =
    obtenerNumeroFrames(periodo.inicio);

  const frames2 =
    obtenerNumeroFrames(periodo.fin);

  return frames1 + frames2;
}


// ------------------------------------------------------------
// CARGA DE IMÁGENES
// ------------------------------------------------------------

function rutaImagen(anio, modo, frame) {

  const numero =
    String(frame).padStart(4, "0");

  return `data/${modo}/${anio}/frame_${numero}.png`;
}


function cargarImagen(ruta) {

  if (cacheImagenes.has(ruta)) {
    return cacheImagenes.get(ruta);
  }


  const promesa =
    new Promise((resolve, reject) => {

      const imagen = new Image();


      imagen.onload = () => {
        resolve(imagen);
      };


      imagen.onerror = () => {

        reject(
          new Error(
            `No se pudo cargar la imagen: ${ruta}`
          )
        );

      };


      imagen.src = ruta;
    });


  cacheImagenes.set(
    ruta,
    promesa
  );


  return promesa;
}


async function obtenerImagenPeriodo(
  periodo,
  modo,
  frame
) {

  const framesPrimerAnio =
    obtenerNumeroFrames(periodo.inicio);


  let anio;
  let frameAnual;


  if (frame < framesPrimerAnio) {

    anio = periodo.inicio;

    frameAnual = frame;

  } else {

    anio = periodo.fin;

    frameAnual =
      frame - framesPrimerAnio;
  }


  const ruta =
    rutaImagen(
      anio,
      modo,
      frameAnual
    );


  const imagen =
    await cargarImagen(ruta);


  return {
    imagen,
    anio,
    frameAnual
  };
}


// ------------------------------------------------------------
// DECODIFICACIÓN PNG A VALORES
// ------------------------------------------------------------

function obtenerEscala(modo) {

  if (modo === "anomaly") {

    return {

      min:
        metadata.anomaly_min ??
        CONFIG.anomalyMin,

      max:
        metadata.anomaly_max ??
        CONFIG.anomalyMax
    };
  }


  return {

    min:
      metadata.sst_min ??
      CONFIG.sstMin,

    max:
      metadata.sst_max ??
      CONFIG.sstMax
  };
}


async function decodificarImagen(
  imagen,
  modo,
  claveCache
) {

  if (cacheValores.has(claveCache)) {

    return cacheValores.get(
      claveCache
    );
  }


  const ancho =
    imagen.naturalWidth;

  const alto =
    imagen.naturalHeight;


  const canvas =
    document.createElement("canvas");

  canvas.width = ancho;
  canvas.height = alto;


  const ctx =
    canvas.getContext(
      "2d",
      {
        willReadFrequently: true
      }
    );


  ctx.drawImage(
    imagen,
    0,
    0
  );


  const pixels =
    ctx.getImageData(
      0,
      0,
      ancho,
      alto
    ).data;


  const valores =
    new Float32Array(
      ancho * alto
    );


  const escala =
    obtenerEscala(modo);


  const rango =
    escala.max - escala.min;


  for (
    let i = 0;
    i < valores.length;
    i++
  ) {

    const indice =
      i * 4;


    const alpha =
      pixels[indice + 3];


    // Dato faltante.
    if (alpha === 0) {

      valores[i] = NaN;

      continue;
    }


    // El PNG está codificado en escala de grises.
    const gris =
      pixels[indice];


    // 0 = faltante
    // 1..255 = valores físicos.
    if (gris === 0) {

      valores[i] = NaN;

    } else {

      valores[i] =
        escala.min +
        ((gris - 1) / 254) *
        rango;
    }
  }


  const resultado = {

    valores,
    ancho,
    alto
  };


  cacheValores.set(
    claveCache,
    resultado
  );


  return resultado;
}


async function obtenerValoresPeriodo(
  periodo,
  modo,
  frame
) {

  const datos =
    await obtenerImagenPeriodo(
      periodo,
      modo,
      frame
    );


  const clave =
    `${modo}/${datos.anio}/frame_${datos.frameAnual}`;


  const decodificado =
    await decodificarImagen(
      datos.imagen,
      modo,
      clave
    );


  return {

    ...decodificado,

    anio:
      datos.anio,

    frameAnual:
      datos.frameAnual
  };
}


// ------------------------------------------------------------
// PRECARGA DE FRAMES
// ------------------------------------------------------------

async function precargarFrame(frame) {

  if (
    frame < 0 ||
    frame >= totalFrames
  ) {
    return;
  }


  if (
    framesPrecargados.has(frame)
  ) {
    return;
  }


  const periodoA =
    leerPeriodo(
      elementos.periodoA.value
    );


  const periodoB =
    leerPeriodo(
      elementos.periodoB.value
    );


  const modo =
    elementos.modoDatos.value;


  try {

    // IMPORTANTE:
    // precargamos valores ya decodificados,
    // no solamente las imágenes.
    await Promise.all([

      obtenerValoresPeriodo(
        periodoA,
        modo,
        frame
      ),

      obtenerValoresPeriodo(
        periodoB,
        modo,
        frame
      )

    ]);


    framesPrecargados.add(
      frame
    );

  } catch (error) {

    console.error(
      `Error precargando frame ${frame}:`,
      error
    );
  }
}


async function precargarBuffer(
  frameInicial
) {

  if (
    totalFrames <= 0
  ) {
    return;
  }


  const tareas = [];


  for (
    let i = 0;
    i < BUFFER_FRAMES;
    i++
  ) {

    let frame =
      frameInicial + i;


    // Si llegamos al final,
    // continuamos desde el principio.
    if (
      frame >= totalFrames
    ) {

      frame -= totalFrames;
    }


    tareas.push(
      precargarFrame(frame)
    );
  }


  await Promise.all(
    tareas
  );
}


// ------------------------------------------------------------
// MOSTRAR FRAME
// ------------------------------------------------------------

async function mostrarFrameActual() {

  const periodoA =
    leerPeriodo(
      elementos.periodoA.value
    );


  const periodoB =
    leerPeriodo(
      elementos.periodoB.value
    );


  const modo =
    elementos.modoDatos.value;


  try {

    const [
      datosA,
      datosB
    ] = await Promise.all([

      obtenerValoresPeriodo(
        periodoA,
        modo,
        frameActual
      ),

      obtenerValoresPeriodo(
        periodoB,
        modo,
        frameActual
      )

    ]);


    dibujarCampo(

      elementos.canvasA,

      datosA.valores,

      datosA.ancho,

      datosA.alto,

      modo
    );


    dibujarCampo(

      elementos.canvasB,

      datosB.valores,

      datosB.ancho,

      datosB.alto,

      modo
    );


    const diferencia =
      calcularDiferencia(
        datosA.valores,
        datosB.valores
      );


    dibujarCampo(

      elementos.canvasDiff,

      diferencia,

      datosA.ancho,

      datosA.alto,

      "difference"
    );


    const fechaA =
      obtenerEtiquetaFecha(
        periodoA,
        frameActual
      );


    const fechaB =
      obtenerEtiquetaFecha(
        periodoB,
        frameActual
      );


    elementos.fechaA.textContent =
      fechaA;


    elementos.fechaB.textContent =
      fechaB;


    elementos.fechaDiff.textContent =
      `${fechaB} − ${fechaA}`;


    elementos.frameCounter.textContent =
      `Frame ${frameActual + 1} / ${totalFrames}`;


  } catch (error) {

    console.error(error);

    detenerAnimacion();
  }
}


// ------------------------------------------------------------
// CÁLCULO B - A
// ------------------------------------------------------------

function calcularDiferencia(
  valoresA,
  valoresB
) {

  const resultado =
    new Float32Array(
      valoresA.length
    );


  for (
    let i = 0;
    i < valoresA.length;
    i++
  ) {

    const a =
      valoresA[i];

    const b =
      valoresB[i];


    if (
      !Number.isFinite(a) ||
      !Number.isFinite(b)
    ) {

      resultado[i] = NaN;

    } else {

      resultado[i] =
        b - a;
    }
  }


  return resultado;
}


// ------------------------------------------------------------
// FECHAS
// ------------------------------------------------------------

const NOMBRES_MESES = [

  "Ene",
  "Feb",
  "Mar",
  "Abr",
  "May",
  "Jun",
  "Jul",
  "Ago",
  "Sep",
  "Oct",
  "Nov",
  "Dic"

];


function obtenerEtiquetaFecha(
  periodo,
  frame
) {

  const framesPrimerAnio =
    obtenerNumeroFrames(
      periodo.inicio
    );


  let anio;
  let frameAnual;


  if (
    frame < framesPrimerAnio
  ) {

    anio =
      periodo.inicio;

    frameAnual =
      frame;

  } else {

    anio =
      periodo.fin;

    frameAnual =
      frame -
      framesPrimerAnio;
  }


  const mes =
    Math.min(
      11,
      Math.floor(
        frameAnual /
        CONFIG.framesPerMonth
      )
    );


  return `${NOMBRES_MESES[mes]} ${anio}`;
}


// ------------------------------------------------------------
// DIBUJO DE MAPAS Y PALETAS
// ------------------------------------------------------------

function dibujarCampo(
  canvas,
  valores,
  ancho,
  alto,
  modo
) {

  canvas.width =
    ancho;

  canvas.height =
    alto;


  const ctx =
    canvas.getContext("2d");


  const imagen =
    ctx.createImageData(
      ancho,
      alto
    );


  const escala =
    obtenerEscalaDibujo(
      modo
    );


  for (
    let i = 0;
    i < valores.length;
    i++
  ) {

    const valor =
      valores[i];


    const indice =
      i * 4;


    if (
      !Number.isFinite(valor)
    ) {

      imagen.data[indice] = 0;

      imagen.data[indice + 1] = 0;

      imagen.data[indice + 2] = 0;

      imagen.data[indice + 3] = 0;

      continue;
    }


    const normalizado =
      limitar(

        (valor - escala.min) /
        (escala.max - escala.min),

        0,
        1
      );


    const color =
      interpolarPaleta(
        normalizado,
        escala.colores
      );


    imagen.data[indice] =
      color[0];

    imagen.data[indice + 1] =
      color[1];

    imagen.data[indice + 2] =
      color[2];

    imagen.data[indice + 3] =
      255;
  }


  ctx.putImageData(
    imagen,
    0,
    0
  );
}


function obtenerEscalaDibujo(
  modo
) {

  if (
    modo === "difference"
  ) {

    return {

      min:
        CONFIG.differenceMin,

      max:
        CONFIG.differenceMax,

      colores:
        CONFIG.anomalyColors
    };
  }


  if (
    modo === "anomaly"
  ) {

    const escala =
      obtenerEscala(
        "anomaly"
      );


    return {

      ...escala,

      colores:
        CONFIG.anomalyColors
    };
  }


  const escala =
    obtenerEscala(
      "sst"
    );


  return {

    ...escala,

    colores:
      CONFIG.sstColors
  };
}


function interpolarPaleta(
  valor,
  paleta
) {

  const posicion =
    valor *
    (paleta.length - 1);


  const indice =
    Math.floor(
      posicion
    );


  const fraccion =
    posicion - indice;


  if (
    indice >=
    paleta.length - 1
  ) {

    return paleta[
      paleta.length - 1
    ];
  }


  const c1 =
    paleta[indice];


  const c2 =
    paleta[indice + 1];


  return [

    Math.round(
      c1[0] +
      (c2[0] - c1[0]) *
      fraccion
    ),

    Math.round(
      c1[1] +
      (c2[1] - c1[1]) *
      fraccion
    ),

    Math.round(
      c1[2] +
      (c2[2] - c1[2]) *
      fraccion
    )

  ];
}


function limitar(
  valor,
  min,
  max
) {

  return Math.max(
    min,
    Math.min(max, valor)
  );
}


// ------------------------------------------------------------
// LEYENDAS
// ------------------------------------------------------------

function configurarLeyendas() {

  const modo =
    elementos.modoDatos.value;


  let min;
  let max;
  let gradiente;


  if (
    modo === "anomaly"
  ) {

    min =
      CONFIG.anomalyMin;

    max =
      CONFIG.anomalyMax;

    gradiente =
      CONFIG.anomalyColors;

  } else {

    min =
      CONFIG.sstMin;

    max =
      CONFIG.sstMax;

    gradiente =
      CONFIG.sstColors;
  }


  const cssGradiente =
    crearGradienteCSS(
      gradiente
    );


  for (
    const elemento of [

      elementos.legendA,
      elementos.legendB

    ]
  ) {

    elemento.style.background =
      cssGradiente;
  }


  elementos.legendDiff.style.background =
    crearGradienteCSS(
      CONFIG.anomalyColors
    );


  elementos.minA.textContent =
    `${min} °C`;

  elementos.maxA.textContent =
    `${max} °C`;

  elementos.minB.textContent =
    `${min} °C`;

  elementos.maxB.textContent =
    `${max} °C`;


  elementos.minDiff.textContent =
    `${CONFIG.differenceMin} °C`;


  elementos.maxDiff.textContent =
    `${CONFIG.differenceMax} °C`;
}


function crearGradienteCSS(
  paleta
) {

  const paradas =
    paleta.map(
      (color, i) => {

        const porcentaje =
          (i /
            (paleta.length - 1)) *
          100;


        return `rgb(${color.join(",")}) ${porcentaje}%`;
      }
    );


  return `linear-gradient(to right, ${paradas.join(", ")})`;
}


// ------------------------------------------------------------
// ANIMACIÓN
// ------------------------------------------------------------

async function reproducirSiguienteFrame() {

  if (!reproduciendo) {
    return;
  }


  if (
    frameActual >=
    totalFrames - 1
  ) {

    frameActual = 0;

  } else {

    frameActual++;
  }


  elementos.timeline.value =
    frameActual;


  // Esperamos a que el frame termine
  // de procesarse antes de continuar.
  await mostrarFrameActual();


  if (!reproduciendo) {
    return;
  }


  // Mientras mostramos el frame actual,
  // preparamos los siguientes.
  //
  // No esperamos aquí para que la animación
  // no se detenga.
  precargarBuffer(
    frameActual + 1
  );


  if (!reproduciendo) {
    return;
  }


  temporizador =
    setTimeout(
      reproducirSiguienteFrame,
      Number(
        elementos.velocidad.value
      )
    );
}


async function iniciarAnimacion() {

  if (reproduciendo) {
    return;
  }


  reproduciendo = true;

  elementos.btnPlay.textContent =
    "⏸ Pausar";


  // Antes de comenzar, aseguramos que
  // haya algunos frames preparados.
  await precargarBuffer(
    frameActual + 1
  );


  if (!reproduciendo) {
    return;
  }


  reproducirSiguienteFrame();
}


function detenerAnimacion() {

  reproduciendo = false;


  if (
    temporizador !== null
  ) {

    clearTimeout(
      temporizador
    );

    temporizador = null;
  }


  elementos.btnPlay.textContent =
    "▶ Reproducir";
}


// ------------------------------------------------------------
// TAMAÑO DE MAPAS
// ------------------------------------------------------------

function actualizarTamanoMapas() {

  const altura =
    Number(
      mapSize.value
    );


  document.documentElement.style.setProperty(
    "--map-height",
    `${altura}px`
  );


  mapSizeValue.textContent =
    `${altura} px`;
}


// ------------------------------------------------------------
// EJECUTAR
// ------------------------------------------------------------

iniciar();