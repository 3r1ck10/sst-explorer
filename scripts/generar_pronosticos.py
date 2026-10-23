"""
Prepara los pronósticos estacionales de C3S (Copernicus) para SST Explorer.

Entrada: carpeta con NetCDF de anomalías mensuales (media del ensamble) de
varios modelos, con dimensiones (forecast_reference_time, forecastMonth,
latitude, longitude) y variables t2a, ssta, tcwva, tpara (alguna puede faltar).

Salida en docs/data/pronosticos/:
  - indices.json: índices por modelo / inicio / mes de pronóstico
    (Niño 1+2, 3, 3.4, 4 y costa norte), su promedio multimodelo, y los
    mismos índices observados (datos de SST Explorer) para verificar.
  - mapas/{modelo}/{variable}_{AAAA-MM}.png: los 6 meses de pronóstico de un
    inicio apilados verticalmente (360 × 1080, 1°, 8 bits; 0 = sin dato).

Uso (desde la carpeta del proyecto):
    python scripts/generar_pronosticos.py <carpeta_netcdf> docs/data
"""

import json
import sys
import warnings
from pathlib import Path

import numpy as np
import xarray as xr
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from nino_comun import CAJAS, Datos, media_caja  # noqa: E402

warnings.filterwarnings("ignore", message="Mean of empty slice")

MODELOS = {
    "ecmwf": "ECMWF",
    "ukmetoffice": "UK Met Office",
    "meteofrance": "Météo-France",
    "dwd": "DWD",
    "cmcc": "CMCC",
    "eccc": "ECCC (Canadá)",
}

# variable NetCDF -> (id en la página, factor, codificación PNG)
VARIABLES = {
    "ssta": ("sst", 1.0, {"type": "signed-linear", "max": 5.0}, "°C"),
    "tpara": ("precip", 8.64e7, {"type": "signed-sqrt", "max": 20.0}, "mm/día"),  # m/s -> mm/día
    "tcwva": ("vapor", 1.0, {"type": "signed-linear", "max": 15.0}, "kg/m²"),
    "t2a": ("t2m", 1.0, {"type": "signed-linear", "max": 8.0}, "°C"),
}

# Índices: (variable, caja)
INDICES = {
    "nino12": ("sst", "nino12"),
    "nino3": ("sst", "nino3"),
    "nino34": ("sst", "nino34"),
    "nino4": ("sst", "nino4"),
    "precipCN": ("precip", "costa_norte"),
    "vaporCN": ("vapor", "costa_norte"),
    "t2mCN": ("t2m", "costa_norte"),
}

OBS_DESDE = 2024


def codificar(v, enc):
    if enc["type"] == "signed-linear":
        g = 128 + 127 * np.clip(v / enc["max"], -1, 1)
    else:
        g = 128 + 127 * np.sign(v) * np.sqrt(np.clip(np.abs(v) / enc["max"], 0, 1))
    g = np.clip(np.round(g), 1, 255)
    g[~np.isfinite(v)] = 0
    return g.astype(np.uint8)


def media_caja_fc(campo, lat, lon, caja):
    """Media ponderada por cos(lat) en la rejilla del pronóstico (centros .5)."""
    la0, la1, lo0, lo1 = caja
    # Celdas cuyo centro cae dentro de la caja ampliada medio grado
    # (para cubrir el mismo área que los puntos enteros de la caja).
    filas = (lat >= min(la0, la1) - 0.5) & (lat <= max(la0, la1) + 0.5)
    cols = (lon >= lo0 - 0.5) & (lon <= lo1 + 0.5)
    sub = campo[np.ix_(filas, cols)]
    w = np.cos(np.radians(lat[filas]))[:, None] * np.ones((1, cols.sum()))
    ok = np.isfinite(sub)
    return float((sub[ok] * w[ok]).sum() / w[ok].sum()) if ok.any() else None


def r2(v):
    return None if v is None or not np.isfinite(v) else round(float(v), 3)


def main(carpeta_nc, carpeta_data):
    carpeta_nc = Path(carpeta_nc)
    salida = Path(carpeta_data) / "pronosticos"
    (salida / "mapas").mkdir(parents=True, exist_ok=True)

    campos = {}  # (modelo, var, init) -> array [6, 180, 360]
    modelos_info = []
    lat = lon = None

    for mid, nombre in MODELOS.items():
        ruta = carpeta_nc / f"{mid}.nc"
        if not ruta.exists():
            print(f"  (falta {ruta.name})")
            continue
        ds = xr.open_dataset(ruta)
        lat = ds.latitude.values
        lon = ds.longitude.values
        assert lat[0] > lat[-1] and abs(lon[0] - 0.5) < 1e-6, "Rejilla inesperada"
        inits = [str(t)[:7] for t in ds.forecast_reference_time.values]
        leads = ds.forecastMonth.values.tolist()
        assert leads == [1, 2, 3, 4, 5, 6], leads
        vars_ok = []
        for vnc, (vid, factor, _, _) in VARIABLES.items():
            if vnc not in ds:
                continue
            datos = ds[vnc].values.astype(np.float64) * factor
            for i, ini in enumerate(inits):
                campos[(mid, vid, ini)] = datos[i]
            vars_ok.append(vid)
        modelos_info.append({"id": mid, "nombre": nombre, "inicios": inits, "variables": vars_ok})
        print(f"  {nombre}: inicios {inits[0]}…{inits[-1]}, variables {vars_ok}")

    todos_inits = sorted({ini for (_, _, ini) in campos})

    # Promedio multimodelo
    for vid in [v[0] for v in VARIABLES.values()]:
        for ini in todos_inits:
            arrs = [campos[(m["id"], vid, ini)] for m in modelos_info if (m["id"], vid, ini) in campos]
            if arrs:
                campos[("multimodelo", vid, ini)] = np.nanmean(arrs, axis=0)
    modelos_info.insert(0, {
        "id": "multimodelo", "nombre": "Promedio multimodelo",
        "inicios": todos_inits,
        "variables": [v[0] for v in VARIABLES.values()],
    })
    # Cuántos modelos entran en cada promedio
    n_modelos = {ini: {vid: sum((m["id"], vid, ini) in campos for m in modelos_info[1:])
                       for vid in [v[0] for v in VARIABLES.values()]} for ini in todos_inits}

    # Mapas PNG (6 meses apilados)
    tam = 0
    encs = {v[0]: v[2] for v in VARIABLES.values()}
    for (mid, vid, ini), arr in campos.items():
        ruta = salida / "mapas" / mid / f"{vid}_{ini}.png"
        ruta.parent.mkdir(parents=True, exist_ok=True)
        img = codificar(arr.reshape(-1, arr.shape[-1]), encs[vid])
        Image.fromarray(img, mode="L").save(ruta, format="PNG", optimize=True)
        tam += ruta.stat().st_size
    print(f"  {len(campos)} mapas PNG ({tam / 1e6:.1f} MB)")

    # Índices pronosticados
    indices_fc = {}
    for (mid, vid, ini), arr in campos.items():
        for idx, (v_idx, caja) in INDICES.items():
            if v_idx != vid:
                continue
            vals = [r2(media_caja_fc(arr[k], lat, lon, CAJAS[caja])) for k in range(6)]
            indices_fc.setdefault(mid, {}).setdefault(ini, {})[idx] = vals

    # Observados (datos de SST Explorer, anomalías 1991–2020)
    d = Datos(carpeta_data)
    fechas = [f for f in d.fechas() if f[0] >= OBS_DESDE]
    capas_obs = [c for c in ("precip", "vapor", "t2m") if c in d.capas]
    obs = {k: [] for k in ("nino12", "nino3", "nino34", "nino4")}
    obs.update({f"{c}CN": [] for c in capas_obs})
    for (a, m) in fechas:
        an = d.sst(a, m, "anomaly")
        for k in ("nino12", "nino3", "nino34", "nino4"):
            obs[k].append(r2(media_caja(an, *CAJAS[k])))
        for c in capas_obs:
            obs[f"{c}CN"].append(r2(media_caja(d.capa(c, a, m, "anomaly"), *CAJAS["costa_norte"])))
    print(f"  observados {fechas[0]} → {fechas[-1]}")

    # Climatología 1991–2020 de la SST absoluta en Niño 1+2 (para el umbral de lluvias)
    clima_sst12 = []
    # Diferencia entre referencias 1993–2016 y 1991–2020 en los índices observados
    desfase_93_16 = {k: [] for k in ("nino12", "nino3", "nino34", "nino4")}
    for m in range(12):
        clima_sst12.append(r2(np.mean([media_caja(d.sst(a, m, "sst"), *CAJAS["nino12"]) for a in range(1991, 2021)])))
        for k in desfase_93_16:
            desfase_93_16[k].append(r2(np.mean([media_caja(d.sst(a, m, "anomaly"), *CAJAS[k]) for a in range(1993, 2017)])))
    print("  desfase de Niño 3.4 (media 1993–2016 de las anomalías 1991–2020):",
          [round(v, 2) for v in desfase_93_16["nino34"]])

    salida_json = {
        "fuente": "C3S, pronósticos estacionales (media del ensamble, anomalías mensuales)",
        "generado": "scripts/generar_pronosticos.py",
        "modelos": modelos_info,
        "inicios": todos_inits,
        "nModelos": n_modelos,
        "variables": {v[0]: {"nc": k, "unidad": v[3], "encoding": v[2]} for k, v in VARIABLES.items()},
        "indices": {k: {"variable": v, "caja": CAJAS[c]} for k, (v, c) in INDICES.items()},
        "pronostico": indices_fc,
        "observado": {"fechas": [[a, m] for a, m in fechas], "series": obs},
        "climaSst12": clima_sst12,
        "desfase9316": desfase_93_16,
        "rejilla": {"ancho": 360, "alto": 180, "lat0": float(lat[0]), "lon0": float(lon[0]), "paso": 1.0},
    }
    (salida / "indices.json").write_text(json.dumps(salida_json, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  escrito {salida / 'indices.json'}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
