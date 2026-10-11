const CONFIG = {
  metadataPath: "data/metadata.json",
  //windMetadataPath: "data/wind/metadata.json",
  //windPath: "data/wind/",
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
  ]
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


let metadata = null;
let aniosDisponibles = [];

let frameActual = 0;
let totalFrames = 0;
let reproduciendo = false;
let temporizador = null;

let tooltipOcupado = false;
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
// VIENTO
// ------------------------------------------------------------

// Metadatos independientes para cada nivel.
const cacheMetadataViento = new Map();

// Caché de archivos binarios por nivel y año.
const cacheViento = new Map();

// Identificador para descartar actualizaciones antiguas.
let solicitudViento = 0;

// Campos de viento actualmente mostrados.
let vientoActualA = null;
let vientoActualB = null;

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

    // --------------------------------------------------------
    // METADATA DEL VIENTO
    // --------------------------------------------------------


    /////////////////////////////////////////////////////////////////

    aniosDisponibles = Object.keys(metadata.anios)
      .map(Number)
      .sort((a, b) => a - b);

    configurarSelectores();
    configurarTooltip();
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

  elementos.nivelViento.addEventListener(
  "change",
  async () => {
    // Actualizar únicamente el viento.
    // No hace falta reiniciar la animación SST.
    await actualizarViento();
  }
  );

  // Activar o desactivar la capa de viento.
  elementos.mostrarVientos.addEventListener(
    "change",
    () => {
      actualizarViento();
    }
  );

  // Activar o desactivar el tooltip.
  elementos.mostrarTooltip.addEventListener(
    "change",
    () => {
      solicitudTooltip++;

      if (!elementos.mostrarTooltip.checked) {
        elementos.tooltipDatos.hidden = true;
      } else if (ultimoPunteroTooltip && canvasTooltipActivo) {
        actualizarTooltip(
          ultimoPunteroTooltip,
          canvasTooltipActivo
        );
      }
    }
  );

  elementos.btnMesAnterior.addEventListener("click", () => {
  cambiarMes(-1);
});

elementos.btnMesSiguiente.addEventListener("click", () => {
  cambiarMes(1);
});

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


  //elementos.timelineStart.textContent =
  //  `${periodoA.inicio} – ${periodoA.fin}`;


  //elementos.timelineEnd.textContent =
  //  `${periodoB.inicio} – ${periodoB.fin}`;


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
  solicitudTooltip++;

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
      `${fechaA} | ${fechaB}`;
    
    await actualizarViento();
    // Refrescar el tooltip si el mouse sigue sobre un mapa.
    if (ultimoPunteroTooltip && canvasTooltipActivo) {
      actualizarTooltip(
        ultimoPunteroTooltip,
        canvasTooltipActivo
      );
    }
  } catch (error) {

    console.error(error);

    detenerAnimacion();
  }
}

async function cambiarMes(direccion) {
  if (totalFrames <= 0) return;

  // Detener la reproducción continua al navegar manualmente.
  detenerAnimacion();

  const framesPorMes = CONFIG.framesPerMonth;
  const mesesTotales = Math.ceil(totalFrames / framesPorMes);

  // Identificar el mes al que pertenece el frame actual.
  const mesActual = Math.floor(frameActual / framesPorMes);

  // Avanzar o retroceder exactamente un mes.
  const mesNuevo =
    (mesActual + direccion + mesesTotales) % mesesTotales;

  // Ir al primer frame del mes: dato mensual original.
  frameActual = mesNuevo * framesPorMes;

  // Mantener sincronizada la línea de tiempo.
  elementos.timeline.value = frameActual;

  // Mostrar los mapas, las fechas y el viento para ese mes.
  await mostrarFrameActual();

  // Preparar los siguientes frames para cuando se reanude
  // la animación continua.
  await precargarBuffer(frameActual + 1);
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
// ============================================================
// VIENTO / STREAMLINES
// ============================================================
async function cargarMetadataViento(nivel) {
  if (cacheMetadataViento.has(nivel)) {
    return cacheMetadataViento.get(nivel);
  }

  const ruta =
    `${CONFIG.windBasePath}${nivel}/metadata.json`;

  const promesa = (async () => {
    const respuesta = await fetch(ruta);

    if (!respuesta.ok) {
      throw new Error(
        `No se pudo cargar metadata del viento: ${ruta}`
      );
    }

    return await respuesta.json();
  })();

  cacheMetadataViento.set(nivel, promesa);

  try {
    return await promesa;
  } catch (error) {
    cacheMetadataViento.delete(nivel);
    throw error;
  }
}
// ------------------------------------------------------------
// CARGAR ARCHIVO BINARIO DE UN AÑO
// ------------------------------------------------------------

async function cargarVientoAnio(anio, nivel) {
  const clave = `${nivel}/${anio}`;

  if (cacheViento.has(clave)) {
    return cacheViento.get(clave);
  }

  const ruta =
    `${CONFIG.windBasePath}${nivel}/${anio}.bin`;

  const promesa = (async () => {
    const respuesta = await fetch(ruta);

    if (!respuesta.ok) {
      throw new Error(
        `No se pudo cargar viento: ${ruta}`
      );
    }

    const buffer = await respuesta.arrayBuffer();

    if (buffer.byteLength % Int16Array.BYTES_PER_ELEMENT !== 0) {
      throw new Error(
        `Tamaño binario inválido: ${ruta}`
      );
    }

    return new Int16Array(buffer);
  })();

  cacheViento.set(clave, promesa);

  try {
    return await promesa;
  } catch (error) {
    cacheViento.delete(clave);
    throw error;
  }
}


// ------------------------------------------------------------
// OBTENER CAMPO U/V DE UN MES
// ------------------------------------------------------------

function obtenerCampoViento(datos, mes, metadataNivel) {
  const width = metadataNivel.width;
  const height = metadataNivel.height;

  const cantidad = width * height;

  const scale = metadataNivel.encoding.scale;
  const missingValue = metadataNivel.encoding.missingValue;

  /*
    Formato del .bin:

    U enero, V enero,
    U febrero, V febrero,
    ...
    U diciembre, V diciembre.
  */

  const offset = mes * cantidad * 2;

  if (offset + cantidad * 2 > datos.length) {
    throw new Error(
      `El archivo de viento no contiene datos suficientes para el mes ${mes + 1}.`
    );
  }

  const U = new Float32Array(cantidad);
  const V = new Float32Array(cantidad);

  for (let i = 0; i < cantidad; i++) {
    const valorU = datos[offset + i];
    const valorV = datos[offset + cantidad + i];

    U[i] =
      valorU === missingValue ? NaN : valorU * scale;

    V[i] =
      valorV === missingValue ? NaN : valorV * scale;
  }

  return {
    U,
    V,
    width,
    height
  };
}


// ------------------------------------------------------------
// OBTENER VIENTO DE UN FRAME
// ------------------------------------------------------------

async function obtenerVientoFrame(periodo, frame, nivel) {
  const metadataNivel = await cargarMetadataViento(nivel);

  const framesPrimerAnio =
    obtenerNumeroFrames(periodo.inicio);

  let anio;
  let frameAnual;

  if (frame < framesPrimerAnio) {
    anio = periodo.inicio;
    frameAnual = frame;
  } else {
    anio = periodo.fin;
    frameAnual = frame - framesPrimerAnio;
  }

  // Cada 10 frames corresponde a un mes.
  const mes = Math.floor(
    frameAnual / CONFIG.framesPerMonth
  );

  const frameDentroMes =
    frameAnual % CONFIG.framesPerMonth;

  const alpha =
    frameDentroMes / CONFIG.framesPerMonth;

  const datosActual =
    await cargarVientoAnio(anio, nivel);

  const campoActual =
    obtenerCampoViento(
      datosActual,
      mes,
      metadataNivel
    );
  // Si estamos en el primer frame del mes,
  // mostrar directamente el promedio mensual del viento.
  // Esto evita intentar cargar el mes siguiente cuando
  // todavía no está disponible, como octubre de 2026.
if (frameDentroMes === 0) {
  return {
    U: campoActual.U,
    V: campoActual.V,
    width: campoActual.width,
    height: campoActual.height
  };
}

  let campoSiguiente;

  if (mes < 11) {
    campoSiguiente = obtenerCampoViento(
      datosActual,
      mes + 1,
      metadataNivel
    );
  } else {
    const datosSiguiente =
      await cargarVientoAnio(anio + 1, nivel);

    campoSiguiente = obtenerCampoViento(
      datosSiguiente,
      0,
      metadataNivel
    );
  }

  if (
    campoActual.width !== campoSiguiente.width ||
    campoActual.height !== campoSiguiente.height
  ) {
    throw new Error(
      `Las dimensiones del viento no coinciden en ${nivel}, año ${anio}.`
    );
  }

  const cantidad =
    campoActual.width * campoActual.height;

  const U = new Float32Array(cantidad);
  const V = new Float32Array(cantidad);

  for (let i = 0; i < cantidad; i++) {
    const u1 = campoActual.U[i];
    const u2 = campoSiguiente.U[i];
    const v1 = campoActual.V[i];
    const v2 = campoSiguiente.V[i];

    if (
      !Number.isFinite(u1) ||
      !Number.isFinite(u2) ||
      !Number.isFinite(v1) ||
      !Number.isFinite(v2)
    ) {
      U[i] = NaN;
      V[i] = NaN;
    } else {
      U[i] = u1 * (1 - alpha) + u2 * alpha;
      V[i] = v1 * (1 - alpha) + v2 * alpha;
    }
  }

  return {
    U,
    V,
    width: campoActual.width,
    height: campoActual.height
  };
}


// ------------------------------------------------------------
// MUESTREAR VIENTO CON INTERPOLACIÓN BILINEAL
// ------------------------------------------------------------

function muestrearViento(
  campo,
  x,
  y
  ) {

  const width =
    campo.width;

  const height =
    campo.height;


  // Wrap longitudinal.
  x =
    ((x % width) + width) %
    width;


  // Fuera de los polos.
  if (
    y < 0 ||
    y >= height - 1
  ) {

    return null;
  }


  const x0 =
    Math.floor(x);

  const y0 =
    Math.floor(y);


  const x1 =
    (x0 + 1) % width;

  const y1 =
    Math.min(
      y0 + 1,
      height - 1
    );


  const fx =
    x - x0;

  const fy =
    y - y0;


  const i00 =
    y0 * width + x0;

  const i10 =
    y0 * width + x1;

  const i01 =
    y1 * width + x0;

  const i11 =
    y1 * width + x1;


  const u00 =
    campo.U[i00];

  const u10 =
    campo.U[i10];

  const u01 =
    campo.U[i01];

  const u11 =
    campo.U[i11];


  const v00 =
    campo.V[i00];

  const v10 =
    campo.V[i10];

  const v01 =
    campo.V[i01];

  const v11 =
    campo.V[i11];


  if (
    !Number.isFinite(u00) ||
    !Number.isFinite(u10) ||
    !Number.isFinite(u01) ||
    !Number.isFinite(u11) ||

    !Number.isFinite(v00) ||
    !Number.isFinite(v10) ||
    !Number.isFinite(v01) ||
    !Number.isFinite(v11)
  ) {

    return null;
  }


  const u0 =
    u00 * (1 - fx) +
    u10 * fx;

  const u1 =
    u01 * (1 - fx) +
    u11 * fx;


  const v0 =
    v00 * (1 - fx) +
    v10 * fx;

  const v1 =
    v01 * (1 - fx) +
    v11 * fx;


  return {

    u:
      u0 * (1 - fy) +
      u1 * fy,

    v:
      v0 * (1 - fy) +
      v1 * fy
  };
}


// ------------------------------------------------------------
// INTEGRAR UNA STREAMLINE
// ------------------------------------------------------------

function integrarStreamline(
  campo,
  xInicial,
  yInicial,
  direccion
  ) {

  const puntos = [];

  let x =
    xInicial;

  let y =
    yInicial;


  const pasos =
    45;

  const paso =
    0.7;


  for (
    let i = 0;
    i < pasos;
    i++
  ) {

    const viento =
      muestrearViento(
        campo,
        x,
        y
      );


    if (!viento) {
      break;
    }


    // Latitud aproximada.
    const lat =
      90 -
      (
        y /
        (campo.height - 1)
      ) *
      180;


    // Corrección aproximada
    // de la convergencia de meridianos.
    const cosLat =
      Math.max(
        0.15,
        Math.cos(
          lat *
          Math.PI /
          180
        )
      );


    let dx =
      viento.u /
      cosLat;

    let dy =
      -viento.v;


    const magnitud =
      Math.sqrt(
        dx * dx +
        dy * dy
      );


    if (
      !Number.isFinite(magnitud) ||
      magnitud < 0.00001
    ) {

      break;
    }


    dx /=
      magnitud;

    dy /=
      magnitud;


    puntos.push({
      x,
      y
    });


    x +=
      dx *
      paso *
      direccion;

    y +=
      dy *
      paso *
      direccion;


    if (
      y < 0 ||
      y >= campo.height
    ) {

      break;
    }
  }


  return puntos;
}


// ------------------------------------------------------------
// GENERAR SEMILLAS
// ------------------------------------------------------------

function generarSemillas(
  campo
  ) {

  const semillas = [];


  // Aproximadamente 250 semillas.
  const columnas = 26;
  const filas = 11;


  const dx =
    campo.width /
    columnas;

  const dy =
    campo.height /
    filas;


  for (
    let j = 0;
    j < filas;
    j++
  ) {

    for (
      let i = 0;
      i < columnas;
      i++
    ) {

      const x =
        (i + 0.5) *
        dx;

      const y =
        (j + 0.5) *
        dy;


      const viento =
        muestrearViento(
          campo,
          x,
          y
        );


      if (!viento) {
        continue;
      }


      const velocidad =
        Math.sqrt(
          viento.u *
          viento.u +
          viento.v *
          viento.v
        );


      if (
        velocidad < 0.05
      ) {

        continue;
      }


      semillas.push({
        x,
        y
      });
    }
  }


  return semillas;
}

/* ==========================================================
   ESTILO DEL VIENTO
   Escala cian -> turquesa -> blanco
   ========================================================== */

function colorViento(velocidad) {
    if (velocidad < 2)  return "#c3c3c3"; // Gris claro: viento débil
    //if (velocidad < 5)  return "#bbc111"; // Gris claro: viento débil
    if (velocidad < 7)  return "#1f742e"; // Gris oscuro
    //if (velocidad < 12)  return "#1c2d9a"; // Gris oscuro
    return "#1c2d9a";                    // Negro: viento muy fuerte
}
/* ==========================================================
   DIBUJAR FLECHA EN EL SENTIDO DEL VIENTO
   ========================================================== */

function dibujarFlechaViento(
    ctx,
    x1,
    y1,
    x2,
    y2,
    color,
    tamano = 3.5
) {
    const angulo = Math.atan2(y2 - y1, x2 - x1);

    const apertura = Math.PI / 6;

    const ax = x2 - tamano * Math.cos(angulo - apertura);
    const ay = y2 - tamano * Math.sin(angulo - apertura);

    const bx = x2 - tamano * Math.cos(angulo + apertura);
    const by = y2 - tamano * Math.sin(angulo + apertura);

    // Contorno oscuro para mejorar el contraste.
    //ctx.beginPath();
    //ctx.moveTo(ax, ay);
    //ctx.lineTo(x2, y2);
    //ctx.lineTo(bx, by);

    //ctx.strokeStyle = "rgba(0, 0, 0, 0.9)";
    //ctx.lineWidth = 2.3;
    //ctx.stroke();

    // Interior de la flecha.
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(x2, y2);
    ctx.lineTo(bx, by);

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.1;
    ctx.stroke();
}
/* ==========================================================
   DIBUJAR STREAMLINES COLOREADAS POR VELOCIDAD
   ========================================================== */

function dibujarStreamlines(canvas, campo) {
    if (!canvas || !campo) return;

    // Resolución visual 3 veces mayor que los datos
    const escala = 2;

    canvas.width = campo.width*escala;
    canvas.height = campo.height*escala;

    const ctx = canvas.getContext("2d");

    // Transformar coordenadas de datos a píxeles de alta resolución
    ctx.setTransform(escala, 0, 0, escala, 0, 0);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const semillas = generarSemillas(campo);

    for (const semilla of semillas) {
        const adelante = integrarStreamline(
            campo,
            semilla.x,
            semilla.y,
            1
        );

        const atras = integrarStreamline(
            campo,
            semilla.x,
            semilla.y,
            -1
        );

        // Los puntos quedan ordenados siguiendo
        // el sentido de avance del viento.
        const puntos = atras.reverse().concat(adelante);

        if (puntos.length < 3) continue;

        /* ------------------------------------------
           DIBUJAR LOS TRAMOS SEGÚN SU VELOCIDAD
           ------------------------------------------ */

        for (let i = 1; i < puntos.length; i++) {
            const p1 = puntos[i - 1];
            const p2 = puntos[i];

            const xm = (p1.x + p2.x) * 0.5;
            const ym = (p1.y + p2.y) * 0.5;

            const viento = muestrearViento(campo, xm, ym);

            if (!viento) continue;

            const velocidad = Math.hypot(
                viento.u,
                viento.v
            );

            const color = colorViento(velocidad);

            // Primero, el contorno oscuro.
            //ctx.beginPath();
            //ctx.moveTo(p1.x, p1.y);
            //ctx.lineTo(p2.x, p2.y);

            //ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
            //ctx.lineWidth = 2.4;
            //ctx.stroke();

            // Después, la línea coloreada.
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);

            ctx.strokeStyle = color;
            ctx.lineWidth = 0.7;
            ctx.stroke();
        }

        /* ------------------------------------------
           UNA FLECHA POR TRAYECTORIA
           ------------------------------------------ */

        // Evitamos colocar flechas en los extremos,
        // donde las líneas pueden ser cortas.
        const i = Math.floor(puntos.length * 0.60);

        if (i >= 1 && i < puntos.length - 1) {
            const pAnterior = puntos[i - 1];
            const pSiguiente = puntos[i + 1];

            const viento = muestrearViento(
                campo,
                puntos[i].x,
                puntos[i].y
            );

            if (viento) {
                const velocidad = Math.hypot(
                    viento.u,
                    viento.v
                );

                dibujarFlechaViento(
                    ctx,
                    pAnterior.x,
                    pAnterior.y,
                    pSiguiente.x,
                    pSiguiente.y,
                    colorViento(velocidad),
                    3.5
                );
            }
        }
    }
}


// ------------------------------------------------------------
// ACTUALIZAR VIENTO
// ------------------------------------------------------------

async function actualizarViento() {
  const idSolicitud = ++solicitudViento;

  // Si los vientos están desactivados, limpiar ambos mapas
  // y evitar nuevas cargas de datos.
  if (!elementos.mostrarVientos.checked) {
    vientoActualA = null;
    vientoActualB = null;

    [elementos.windA, elementos.windB].forEach(canvas => {
      if (!canvas) return;

      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    });

    // Si el tooltip sigue activo, actualizarlo sin viento.
    if (ultimoPunteroTooltip && canvasTooltipActivo) {
      actualizarTooltip(
        ultimoPunteroTooltip,
        canvasTooltipActivo
      );
    }

    return;
  }

  try {
    const nivel = elementos.nivelViento.value;

    const periodoA = leerPeriodo(elementos.periodoA.value);
    const periodoB = leerPeriodo(elementos.periodoB.value);

    const [campoA, campoB] = await Promise.all([
      obtenerVientoFrame(periodoA, frameActual, nivel),
      obtenerVientoFrame(periodoB, frameActual, nivel)
    ]);

    // Ignorar resultados antiguos o cargas que ya no se necesitan.
    if (
      idSolicitud !== solicitudViento ||
      !elementos.mostrarVientos.checked ||
      nivel !== elementos.nivelViento.value
    ) {
      return;
    }

    vientoActualA = campoA;
    vientoActualB = campoB;

    dibujarStreamlines(elementos.windA, campoA);
    dibujarStreamlines(elementos.windB, campoB);

    if (ultimoPunteroTooltip && canvasTooltipActivo) {
      actualizarTooltip(
        ultimoPunteroTooltip,
        canvasTooltipActivo
      );
    }
  } catch (error) {
    if (idSolicitud === solicitudViento) {
      console.error("Error cargando viento:", error);
    }
  }
}

/*PARA EL TOOLTIP================================*/
function numeroTooltip(valor, decimales = 2, unidad = "") {
  if (!Number.isFinite(valor)) return "Sin datos";

  return `${valor.toFixed(decimales)}${unidad}`;
  }

function muestrearSST(datos, nx, ny) {
  if (!datos || !datos.valores) return NaN;

  const x = Math.max(
    0,
    Math.min(datos.ancho - 1, Math.round(nx * (datos.ancho - 1)))
  );

  const y = Math.max(
    0,
    Math.min(datos.alto - 1, Math.round(ny * (datos.alto - 1)))
  );

  return datos.valores[y * datos.ancho + x];
  }

function obtenerVelocidadViento(campo, nx, ny) {
  if (!campo) return null;

  const x = nx * (campo.width - 1);
  const y = ny * (campo.height - 1);

  const viento = muestrearViento(campo, x, y);

  if (!viento || !Number.isFinite(viento.u) ||
      !Number.isFinite(viento.v)) {
    return null;
  }

  return {
    u: viento.u,
    v: viento.v,
    velocidad: Math.hypot(viento.u, viento.v)
  };
  }

let solicitudTooltip = 0;
let ultimoPunteroTooltip = null;
let canvasTooltipActivo = null;

function obtenerAreaImagen(canvas) {
  const rect = canvas.getBoundingClientRect();

  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    canvas.width <= 0 ||
    canvas.height <= 0
  ) {
    return null;
  }

  // Proporción de la imagen original y del canvas visible.
  const proporcionImagen = canvas.width / canvas.height;
  const proporcionCanvas = rect.width / rect.height;

  let ancho, alto;

  // Equivale a calcular el área ocupada por una imagen
  // con object-fit: contain.
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
async function actualizarTooltip(evento, canvas) {
  const idSolicitud = ++solicitudTooltip;
  const tooltip = elementos.tooltipDatos;

  // Si el tooltip está desactivado, no mostrar información.
  if (!elementos.mostrarTooltip.checked) {
    tooltip.hidden = true;
    return;
  }

  const area = obtenerAreaImagen(canvas);

  if (!area) {
    tooltip.hidden = true;
    return;
  }

  // Comprobar que el mouse está sobre la imagen,
  // no solamente dentro del canvas.
  if (
    evento.clientX < area.left ||
    evento.clientX >= area.left + area.width ||
    evento.clientY < area.top ||
    evento.clientY >= area.top + area.height
  ) {
    tooltip.hidden = true;
    return;
  }

  // Coordenadas normalizadas respecto a la imagen real.
  const nx = (evento.clientX - area.left) / area.width;
  const ny = (evento.clientY - area.top) / area.height;

  // Coordenadas geográficas mostradas.
  const longitud360 = nx * 360;
  const longitud = ((longitud360 + 180) % 360) - 180;
  const latitud = 90 - ny * 180;

  // Capturar el estado actual.
  const frame = frameActual;
  const valorA = elementos.periodoA.value;
  const valorB = elementos.periodoB.value;
  const modo = elementos.modoDatos.value;
  const nivel = elementos.nivelViento.value;

  if (!valorA || !valorB || !modo) return;

  // Convertir los valores del selector en objetos de periodo.
  const periodoA = leerPeriodo(valorA);
  const periodoB = leerPeriodo(valorB);

  try {
    const [datosA, datosB] = await Promise.all([
      obtenerValoresPeriodo(periodoA, modo, frame),
      obtenerValoresPeriodo(periodoB, modo, frame)
    ]);

    // Ignorar resultados obsoletos.
    if (
      idSolicitud !== solicitudTooltip ||
      frame !== frameActual ||
      valorA !== elementos.periodoA.value ||
      valorB !== elementos.periodoB.value ||
      modo !== elementos.modoDatos.value ||
      nivel !== elementos.nivelViento.value
    ) {
      return;
    }

    const valorCampoA = muestrearSST(datosA, nx, ny);
    const valorCampoB = muestrearSST(datosB, nx, ny);

    const vientoA = obtenerVelocidadViento(
      vientoActualA, nx, ny
    );

    const vientoB = obtenerVelocidadViento(
      vientoActualB, nx, ny
    );

    const velocidadA = vientoA?.velocidad ?? NaN;
    const velocidadB = vientoB?.velocidad ?? NaN;

    const etiquetaVariable =
      modo === "anomaly"
        ? "Anomalía SST"
        : "SST absoluta";

    const unidadTemperatura = " °C";

    tooltip.innerHTML = `
  <div class="tooltip-coordenadas">
    <span>Lat: <strong>${latitud.toFixed(2)}°</strong></span>
    <span>Lon: <strong>${longitud.toFixed(2)}°</strong></span>
  </div>

  <div class="tooltip-comparacion">

    <div class="tooltip-columna">
      <div class="tooltip-periodo">
        Periodo A
      </div>
      <div class="tooltip-anio">
        ${periodoA.inicio}–${periodoA.fin}
      </div>

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
      <div class="tooltip-periodo">
        Periodo B
      </div>
      <div class="tooltip-anio">
        ${periodoB.inicio}–${periodoB.fin}
      </div>

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
      Math.min(
        evento.clientX + 14,
        window.innerWidth - ancho - margen
      )
    );

    const arriba = Math.max(
      margen,
      Math.min(
        evento.clientY + 14,
        window.innerHeight - alto - margen
      )
    );

    tooltip.style.left = `${izquierda}px`;
    tooltip.style.top = `${arriba}px`;

  } catch (error) {
    console.error(
      "Error al consultar los datos del tooltip:",
      error
    );
  }
}
function configurarTooltip() {
  const tooltip = elementos.tooltipDatos;

  [elementos.canvasA, elementos.canvasB].forEach(canvas => {
    canvas.addEventListener("pointermove", evento => {
      ultimoPunteroTooltip = {
        clientX: evento.clientX,
        clientY: evento.clientY
      };

      canvasTooltipActivo = canvas;

      actualizarTooltip(
        ultimoPunteroTooltip,
        canvas
      );
    });

    canvas.addEventListener("pointerleave", () => {
      if (canvasTooltipActivo === canvas) {
        ultimoPunteroTooltip = null;
        canvasTooltipActivo = null;
        solicitudTooltip++;
        tooltip.hidden = true;
      }
    });
  });
}
// ------------------------------------------------------------
// EJECUTAR
// ------------------------------------------------------------

iniciar();