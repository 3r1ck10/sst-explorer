"""
Cambia el periodo de referencia de las anomalías de precipitación y vapor de
agua (docs/data/{precip,vapor}/anomaly) sin necesidad de los NetCDF:

    anomalía_nueva = anomalía_actual − media(anomalía_actual en el nuevo periodo, mismo mes)

Uso (desde la carpeta del proyecto):
    python scripts/cambiar_climatologia_capas.py docs/data 1991 2020
"""

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def decodificar(g, enc):
    g = g.astype(np.float64)
    t = enc["type"]
    if t == "signed-linear":
        return (g - 128) / 127 * enc["max"]
    if t == "signed-sqrt":
        s = (g - 128) / 127
        return np.sign(s) * s * s * enc["max"]
    raise ValueError(f"Codificación de anomalía no soportada: {t}")


def codificar(v, enc):
    t = enc["type"]
    if t == "signed-linear":
        g = 128 + 127 * np.clip(v / enc["max"], -1, 1)
    else:
        g = 128 + 127 * np.sign(v) * np.sqrt(np.clip(np.abs(v) / enc["max"], 0, 1))
    return np.clip(np.round(g), 1, 255).astype(np.uint8)


def procesar(base, nombre, inicio, fin):
    carpeta = Path(base) / nombre
    meta = json.loads((carpeta / "metadata.json").read_text(encoding="utf-8"))
    enc = meta["anomaly"]["encoding"]
    meses = {int(a): n for a, n in meta["meses_por_anio"].items()}
    anterior = meta.get("climatologia", "?")

    ruta = lambda a, m: carpeta / "anomaly" / str(a) / f"{m + 1:02d}.png"  # noqa: E731

    desplazamientos = []
    for m in range(12):
        campos = [decodificar(np.array(Image.open(ruta(a, m))), enc)
                  for a in range(inicio, fin + 1) if meses.get(a, 0) > m]
        desplazamientos.append(np.mean(campos, axis=0))
        print(f"  {nombre} mes {m + 1:2d}: {len(campos)} años, desplazamiento medio {desplazamientos[-1].mean():+.3f}")

    for a, n in sorted(meses.items()):
        for m in range(n):
            v = decodificar(np.array(Image.open(ruta(a, m))), enc)
            Image.fromarray(codificar(v - desplazamientos[m], enc), mode="L").save(ruta(a, m), format="PNG", optimize=True)

    meta["climatologia"] = f"{inicio}-{fin}"
    meta["nota_climatologia"] = (
        f"Anomalías re-referenciadas desde {anterior} restando la media mensual de {inicio}-{fin} "
        "(scripts/cambiar_climatologia_capas.py)."
    )
    (carpeta / "metadata.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  {nombre}: listo ({anterior} → {inicio}-{fin})")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)
    for capa in ("precip", "vapor"):
        procesar(sys.argv[1], capa, int(sys.argv[2]), int(sys.argv[3]))
