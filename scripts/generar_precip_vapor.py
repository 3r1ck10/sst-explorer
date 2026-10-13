"""
Genera las capas de precipitación y vapor de agua para SST Explorer.

Lee los NetCDF mensuales de ERA5 y escribe PNG en escala de grises
(un archivo por mes) más un metadata.json por variable:

    docs/data/precip/total/{año}/{MM}.png      precipitación (mm/día)
    docs/data/precip/anomaly/{año}/{MM}.png    anomalía de precipitación
    docs/data/vapor/total/{año}/{MM}.png       vapor de agua (kg/m²)
    docs/data/vapor/anomaly/{año}/{MM}.png     anomalía de vapor de agua

- Las anomalías se calculan respecto a la climatología mensual 1980–2010
  (mismo periodo que la SST).
- Rejilla de 1° (360 × 181): longitud 0..359, latitud 90..-90. Se suaviza
  con un filtro [1, 2, 1] antes de submuestrear para evitar aliasing.
- Codificación de 8 bits (el valor 0 queda reservado para "sin dato"):
    linear        g = 1 + 254 · (v − min) / (max − min)
    sqrt          g = 1 + 254 · √(v / max)               (precipitación)
    signed-linear g = 128 + 127 · v / max
    signed-sqrt   g = 128 + 127 · signo(v) · √(|v| / max)

Uso (desde la carpeta del proyecto):
    python scripts/generar_precip_vapor.py docs/total_precipitation.nc docs/water_vapor.nc docs/data
"""

import json
import sys
from pathlib import Path

import numpy as np
import xarray as xr
from PIL import Image

ANIO_INICIO = 1980
CLIMA_INICIO = 1980
CLIMA_FIN = 2010
PASO = 4  # 0.25° → 1°

CAPAS = {
    "precip": {
        "variable_nc": "tp",
        "factor": 1000.0,  # m/día → mm/día
        "unidades": "mm/día",
        "nombre": "Precipitación total",
        "total": {"type": "sqrt", "min": 0.0, "max": 40.0},
        "anomaly": {"type": "signed-sqrt", "max": 30.0},
    },
    "vapor": {
        "variable_nc": "tcwv",
        "factor": 1.0,
        "unidades": "kg/m²",
        "nombre": "Vapor de agua en la columna",
        "total": {"type": "linear", "min": 0.0, "max": 75.0},
        "anomaly": {"type": "signed-linear", "max": 30.0},
    },
}


def suavizar_submuestrear(x, paso):
    """Filtro [1,2,1]/4 (longitud cíclica) y submuestreo ×2, repetido."""
    k0, k1 = 0.25, 0.5
    while paso > 1:
        xp = np.concatenate([x[:, -1:], x, x[:, :1]], axis=1)
        x = k0 * xp[:, :-2] + k1 * xp[:, 1:-1] + k0 * xp[:, 2:]
        xp = np.concatenate([x[:1], x, x[-1:]], axis=0)
        x = k0 * xp[:-2] + k1 * xp[1:-1] + k0 * xp[2:]
        x = x[::2, ::2]
        paso //= 2
    return x


def codificar(v, enc):
    t = enc["type"]
    if t == "linear":
        n = (v - enc["min"]) / (enc["max"] - enc["min"])
        g = 1 + 254 * np.clip(n, 0, 1)
    elif t == "sqrt":
        g = 1 + 254 * np.sqrt(np.clip(v / enc["max"], 0, 1))
    elif t == "signed-linear":
        g = 128 + 127 * np.clip(v / enc["max"], -1, 1)
    elif t == "signed-sqrt":
        g = 128 + 127 * np.sign(v) * np.sqrt(np.clip(np.abs(v) / enc["max"], 0, 1))
    else:
        raise ValueError(t)
    return np.clip(np.round(g), 1, 255).astype(np.uint8)


def guardar_png(g, ruta):
    ruta.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(g, mode="L").save(ruta, format="PNG", optimize=True)


def procesar(nombre, archivo_nc, salida):
    cfg = CAPAS[nombre]
    ds = xr.open_dataset(archivo_nc)
    da = ds[cfg["variable_nc"]]

    # La rejilla debe empezar en lon 0 y lat 90 (como la SST).
    lat = ds["latitude"].values
    lon = ds["longitude"].values
    assert lat[0] > lat[-1], "Se esperaba latitud descendente (90 → -90)."
    assert abs(lon[0]) < 1e-6, "Se esperaba longitud inicial 0°."

    tiempos = ds["valid_time"].values.astype("datetime64[M]")
    anios = tiempos.astype("datetime64[Y]").astype(int) + 1970
    meses = tiempos.astype(int) % 12

    # 1) Leer y reducir cada mes a 1°.
    # El NetCDF está comprimido en bloques de muchos meses: leer mes a mes
    # descomprimiría el bloque completo cada vez. Se lee por bloques.
    chunks = da.encoding.get("chunksizes") or (12,)
    bloque = max(12, int(chunks[0]))
    indices = np.where(anios >= ANIO_INICIO)[0]
    campos = {}
    for inicio in range(0, len(indices), bloque):
        sel = indices[inicio:inicio + bloque]
        datos = da.isel(valid_time=slice(int(sel[0]), int(sel[-1]) + 1)).values
        for k, i in enumerate(sel):
            x = datos[k].astype(np.float64) * cfg["factor"]
            campos[(int(anios[i]), int(meses[i]))] = suavizar_submuestrear(x, PASO).astype(np.float32)
        print(f"  {nombre}: leídos hasta {anios[sel[-1]]}-{meses[sel[-1]] + 1:02d}", flush=True)
        del datos

    alto, ancho = next(iter(campos.values())).shape

    # 2) Climatología mensual 1980–2010.
    clima = []
    for m in range(12):
        sel = [campos[(a, m)] for a in range(CLIMA_INICIO, CLIMA_FIN + 1) if (a, m) in campos]
        clima.append(np.mean(sel, axis=0))
        print(f"  {nombre}: climatología mes {m + 1} ({len(sel)} años)", flush=True)

    # 3) Escribir PNG de total y anomalía.
    meses_por_anio = {}
    for (a, m), x in sorted(campos.items()):
        mm = f"{m + 1:02d}.png"
        guardar_png(codificar(x, cfg["total"]), salida / nombre / "total" / str(a) / mm)
        guardar_png(codificar(x - clima[m], cfg["anomaly"]), salida / nombre / "anomaly" / str(a) / mm)
        meses_por_anio[str(a)] = max(meses_por_anio.get(str(a), 0), m + 1)

    meta = {
        "variable": nombre,
        "nombre": cfg["nombre"],
        "fuente": "ERA5 (medias mensuales)",
        "variable_nc": cfg["variable_nc"],
        "unidades": cfg["unidades"],
        "climatologia": f"{CLIMA_INICIO}-{CLIMA_FIN}",
        "rejilla": {"ancho": ancho, "alto": alto, "lon0": 0.0, "lat0": 90.0, "resolucion": 360.0 / ancho},
        "anios": {"inicio": min(int(k) for k in meses_por_anio), "fin": max(int(k) for k in meses_por_anio)},
        "meses_por_anio": meses_por_anio,
        "total": {"encoding": cfg["total"]},
        "anomaly": {"encoding": cfg["anomaly"]},
    }
    (salida / nombre).mkdir(parents=True, exist_ok=True)
    with open(salida / nombre / "metadata.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(f"  {nombre}: listo ({len(campos)} meses)")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)
    precip_nc, vapor_nc, salida = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    procesar("precip", precip_nc, salida)
    procesar("vapor", vapor_nc, salida)
