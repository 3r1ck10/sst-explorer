"""
Cambia el periodo de referencia de las anomalías de SST de SST Explorer.

Las anomalías actuales (docs/data/anomaly) están referidas a una climatología
mensual (por ejemplo 1980–2010). Para pasarlas a otro periodo (por ejemplo
1991–2020) no hace falta la SST original:

    anomalía_nueva = anomalía_actual − media(anomalía_actual en el nuevo periodo, mismo mes)

porque esa media es exactamente la diferencia entre las dos climatologías.
Los fotogramas intermedios (interpolaciones entre meses) usan el desplazamiento
interpolado entre los dos meses, igual que la anomalía.

Uso (desde la carpeta del proyecto):
    python scripts/cambiar_climatologia_sst.py docs/data 1991 2020
"""

import json
import sys
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from PIL import Image

FRAMES_POR_MES = 10


def leer(ruta, lo, hi):
    g = np.array(Image.open(ruta), dtype=np.float64)
    v = lo + (g - 1) / 254 * (hi - lo)
    v[g == 0] = np.nan
    return v


def escribir(ruta, v, lo, hi):
    g = 1 + np.round((v - lo) / (hi - lo) * 254)
    g = np.clip(g, 1, 255)
    g[~np.isfinite(v)] = 0
    Image.fromarray(g.astype(np.uint8), mode="L").save(ruta, format="PNG", optimize=True)


def procesar_anio(args):
    base, anio, frames, desplazamientos, lo, hi = args
    for f in range(frames):
        mes = f // FRAMES_POR_MES
        alfa = (f % FRAMES_POR_MES) / FRAMES_POR_MES
        off = (1 - alfa) * desplazamientos[mes] + alfa * desplazamientos[(mes + 1) % 12]
        ruta = Path(base) / "anomaly" / str(anio) / f"frame_{f:04d}.png"
        v = leer(ruta, lo, hi)
        escribir(ruta, v - off, lo, hi)
    return anio


def main(base, inicio, fin):
    base = Path(base)
    meta_ruta = base / "metadata.json"
    meta = json.loads(meta_ruta.read_text(encoding="utf-8"))
    lo, hi = meta["anomaly_min"], meta["anomaly_max"]
    anterior = meta.get("climatologia", {}).get("periodo", "?")
    print(f"Climatología actual: {anterior}  →  nueva: {inicio}-{fin}")

    # 1) Desplazamiento por mes calendario = media de la anomalía actual en el nuevo periodo.
    desplazamientos = []
    anios_usados = {}
    for m in range(12):
        suma = None
        cuenta = None
        n = 0
        for a in range(inicio, fin + 1):
            info = meta["anios"].get(str(a))
            if not info or info["anomaly"]["frames"] <= m * FRAMES_POR_MES:
                continue
            v = leer(base / "anomaly" / str(a) / f"frame_{m * FRAMES_POR_MES:04d}.png", lo, hi)
            if suma is None:
                suma = np.zeros_like(v)
                cuenta = np.zeros_like(v)
            ok = np.isfinite(v)
            suma[ok] += v[ok]
            cuenta[ok] += 1
            n += 1
        off = np.where(cuenta > 0, suma / np.maximum(cuenta, 1), 0.0)
        desplazamientos.append(off)
        anios_usados[str(m + 1)] = n
        print(f"  mes {m + 1:2d}: {n} años, desplazamiento medio océano {np.nanmean(np.where(cuenta > 0, off, np.nan)):+.3f} °C")

    # 2) Reescribir todos los fotogramas.
    tareas = [(str(base), int(a), info["anomaly"]["frames"], desplazamientos, lo, hi)
              for a, info in sorted(meta["anios"].items())]
    with Pool(4) as pool:
        for anio in pool.imap_unordered(procesar_anio, tareas):
            print(f"  reescrito {anio}", flush=True)

    # 3) Actualizar metadata.json
    meta.setdefault("climatologia", {})
    meta["climatologia"]["periodo"] = f"{inicio}-{fin}"
    meta["climatologia"]["years_used_by_month"] = anios_usados
    meta["climatologia"]["nota"] = (
        f"Anomalías re-referenciadas desde {anterior} restando la media mensual de {inicio}-{fin} "
        "(scripts/cambiar_climatologia_sst.py)."
    )
    meta_ruta.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print("metadata.json actualizado")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]))
