"""
Funciones comunes para leer los datos de SST Explorer (docs/data) en Python.

Todos los campos se devuelven en una rejilla de 1° (lat 90..-90, lon 0..359),
igual a la de precipitación y vapor de agua.
"""

import json
from pathlib import Path

import numpy as np
from PIL import Image

MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]


class Datos:
    def __init__(self, carpeta_data):
        self.base = Path(carpeta_data)
        self.meta = json.loads((self.base / "metadata.json").read_text(encoding="utf-8"))
        self.capas = {}
        for capa in ("precip", "vapor", "t2m"):
            ruta = self.base / capa / "metadata.json"
            if ruta.exists():
                self.capas[capa] = json.loads(ruta.read_text(encoding="utf-8"))
        self.viento_meta = {}

    # ------------------------------------------------------------------
    # Fechas disponibles
    # ------------------------------------------------------------------
    def meses_anio(self, anio):
        info = self.meta["anios"].get(str(anio))
        if not info:
            return 0
        return int(np.ceil(info["anomaly"]["frames"] / 10))

    def fechas(self):
        out = []
        for a in range(self.meta["anio_inicial"], self.meta["anio_final"] + 1):
            for m in range(self.meses_anio(a)):
                out.append((a, m))
        return out

    # ------------------------------------------------------------------
    # SST (PNG 720×361, 0.5°) -> 1°
    # ------------------------------------------------------------------
    def sst(self, anio, mes, modo="anomaly"):
        ruta = self.base / modo / str(anio) / f"frame_{mes * 10:04d}.png"
        im = np.array(Image.open(ruta).convert("LA"))
        g = im[..., 0].astype(np.float64)
        a = im[..., 1]
        lo, hi = (self.meta["anomaly_min"], self.meta["anomaly_max"]) if modo == "anomaly" else (
            self.meta["sst_min"], self.meta["sst_max"])
        v = lo + (g - 1) / 254 * (hi - lo)
        v[(g == 0) | (a == 0)] = np.nan
        # 0.5° -> 1°: tomar los puntos de grado entero (lat 90..-90, lon 0..359)
        return v[::2, ::2]

    # ------------------------------------------------------------------
    # Precipitación / vapor (PNG 360×181, 1°)
    # ------------------------------------------------------------------
    def capa(self, nombre, anio, mes, modo="anomaly"):
        meta = self.capas[nombre]
        enc = meta[modo]["encoding"]
        ruta = self.base / nombre / modo / str(anio) / f"{mes + 1:02d}.png"
        g = np.array(Image.open(ruta)).astype(np.float64)
        t = enc["type"]
        if t == "linear":
            return enc["min"] + (g - 1) / 254 * (enc["max"] - enc["min"])
        if t == "sqrt":
            return enc["max"] * ((g - 1) / 254) ** 2
        s = (g - 128) / 127
        return s * enc["max"] if t == "signed-linear" else np.sign(s) * s * s * enc["max"]

    # ------------------------------------------------------------------
    # Viento (Int16, 360×180, celdas centradas en .375/.625)
    # ------------------------------------------------------------------
    def viento_anio(self, nivel, anio):
        if nivel not in self.viento_meta:
            self.viento_meta[nivel] = json.loads(
                (self.base / "wind" / nivel / "metadata.json").read_text(encoding="utf-8"))
        m = self.viento_meta[nivel]
        datos = np.fromfile(self.base / "wind" / nivel / f"{anio}.bin", dtype="<i2")
        n = m["width"] * m["height"]
        meses = len(datos) // (2 * n)
        datos = datos[: meses * 2 * n].reshape(meses, 2, m["height"], m["width"]).astype(np.float64)
        datos[datos == m["encoding"]["missingValue"]] = np.nan
        return datos * m["encoding"]["scale"]  # [mes, (u,v), lat, lon]


def lat_lon_1deg():
    return np.arange(90, -91, -1.0), np.arange(0, 360, 1.0)


def media_caja(campo, lat0, lat1, lon0, lon1):
    """Media ponderada por cos(lat) en una caja (lon en 0..360)."""
    lat, lon = lat_lon_1deg()
    filas = (lat >= min(lat0, lat1)) & (lat <= max(lat0, lat1))
    cols = (lon >= lon0) & (lon <= lon1)
    sub = campo[np.ix_(filas, cols)]
    w = np.cos(np.radians(lat[filas]))[:, None] * np.ones((1, cols.sum()))
    ok = np.isfinite(sub)
    if not ok.any():
        return np.nan
    return float((sub[ok] * w[ok]).sum() / w[ok].sum())


CAJAS = {
    "nino12": (-10, 0, 270, 280),
    "nino3": (-5, 5, 210, 270),
    "nino34": (-5, 5, 190, 240),
    "nino4": (-5, 5, 160, 210),
    # Costa norte del Perú (Tumbes–Piura), 4°S–6°S, 81°W–80°W.
    # Se evita la vertiente andina (79°W), donde llueve cada verano.
    "costa_norte": (-6, -4, 279, 280),
}
