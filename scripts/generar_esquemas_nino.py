"""
Genera los datos de la página "Tipos de El Niño" (docs/tipos-nino.html)
a partir de los mismos datos que usa SST Explorer (docs/data).

Salida: docs/data/esquemas/nino.json con
  - series mensuales: Niño 1+2, 3, 3.4, 4 (anomalías), medias móviles de
    3 meses, SST absoluta de Niño 1+2, lluvia en la costa norte del Perú,
    índices E y C (Takahashi et al., 2011);
  - climatología mensual 1991–2020 (SST Niño 1+2 y lluvia costa norte);
  - eventos detectados con reglas explícitas y su tipo;
  - mapas compuestos por tipo de evento (SST, precipitación, vapor y viento
    a 10 m) para tres momentos: verano de inicio (EFM año 0), invierno
    (JJA año 0) y verano siguiente (EFM año +1).

Uso (desde la carpeta del proyecto):
    python scripts/generar_esquemas_nino.py docs/data
"""

import base64
import json
import sys
from pathlib import Path

import warnings

import numpy as np

# Medias de celdas de tierra (todo NaN) son esperables.
warnings.filterwarnings("ignore", message="Mean of empty slice")

sys.path.insert(0, str(Path(__file__).parent))
from nino_comun import CAJAS, MESES, Datos, media_caja  # noqa: E402

CLIMA = (1991, 2020)

# Dominio de los mapas compuestos (Pacífico tropical).
LAT_N, LAT_S = 30, -30
LON_O, LON_E = 120, 290

# Momentos del evento (meses 0-11, desplazamiento de año).
VENTANAS = [
    {"id": "efm0", "nombre": "Verano de inicio", "meses": [0, 1, 2], "anio": 0, "corto": "Ene–Mar año 0"},
    {"id": "jja0", "nombre": "Invierno austral", "meses": [5, 6, 7], "anio": 0, "corto": "Jun–Ago año 0"},
    {"id": "efm1", "nombre": "Verano siguiente", "meses": [0, 1, 2], "anio": 1, "corto": "Ene–Mar año +1"},
]

# Grupos de eventos (año 0 = año en que empieza el calentamiento).
# Los miembros se asignan con las reglas de clasificar_eventos(); aquí solo
# se describen los grupos.
GRUPOS = {
    "oriental": {
        "nombre": "Pacífico oriental (fuerte a extraordinario)",
        "resumen": "El calentamiento máximo está en la costa sudamericana y en todo el Pacífico este; "
                   "dura más de un año y abarca dos veranos.",
        "regla": "Evento del Pacífico (Niño 3.4 ≥ 0.5 °C, 5+ meses) con Niño 1+2 (media 3 meses) ≥ 3 °C "
                 "y mayor que el máximo de Niño 3.4.",
    },
    "costero": {
        "nombre": "Costero (solo la costa)",
        "resumen": "Calentamiento intenso y breve frente a Perú y Ecuador, mientras el Pacífico central "
                   "sigue neutral.",
        "regla": "Niño 1+2 ≥ 0.4 °C por 3+ meses con pico ≥ 1 °C, sin evento del Pacífico (Niño 3.4 < 0.5 °C).",
    },
    "central": {
        "nombre": "Pacífico central (Modoki)",
        "resumen": "El calentamiento se concentra en el Pacífico central; la costa sudamericana queda "
                   "neutral o fría.",
        "regla": "Evento del Pacífico con Niño 1+2 < 0.6 × Niño 3.4 en el mes de máximo Niño 3.4.",
    },
    "canonico": {
        "nombre": "Canónico / mixto",
        "resumen": "Calentamiento repartido entre el Pacífico central y el oriental, de intensidad "
                   "débil a fuerte.",
        "regla": "Resto de eventos del Pacífico.",
    },
}


def media_movil(x):
    """Media móvil centrada de 3 meses (en los extremos, con los meses disponibles)."""
    out = np.empty_like(x)
    for i in range(len(x)):
        out[i] = np.nanmean(x[max(0, i - 1): i + 2])
    return out


def rachas(cond):
    """Lista de (inicio, fin) de tramos consecutivos donde cond es True."""
    res = []
    i = 0
    while i < len(cond):
        if cond[i]:
            j = i
            while j + 1 < len(cond) and cond[j + 1]:
                j += 1
            res.append((i, j))
            i = j + 1
        else:
            i += 1
    return res


def b64_int8(arr, escala):
    q = np.where(np.isfinite(arr), np.clip(np.round(arr / escala), -127, 127), -128).astype(np.int8)
    return base64.b64encode(q.tobytes()).decode("ascii")


def main(carpeta):
    d = Datos(carpeta)
    fechas = d.fechas()
    n = len(fechas)
    anios = np.array([a for a, _ in fechas])
    meses = np.array([m for _, m in fechas])
    print(f"{n} meses: {fechas[0]} → {fechas[-1]}")

    filas = slice(90 - LAT_N, 90 - LAT_S + 1)
    cols = slice(LON_O, LON_E + 1)

    # ---------------------------------------------------------------
    # 1) Lectura mensual
    # ---------------------------------------------------------------
    idx = {k: np.full(n, np.nan) for k in ("nino12", "nino3", "nino34", "nino4")}
    sst12 = np.full(n, np.nan)
    lluvia = np.full(n, np.nan)
    lluvia_anom = np.full(n, np.nan)
    sst_dom, pre_dom, vap_dom = [], [], []
    eof_lat = slice(90 - 10, 90 + 10 + 1)
    eof_lon = slice(120, 280 + 1)
    eof_campos = []

    for i, (a, m) in enumerate(fechas):
        an = d.sst(a, m, "anomaly")
        ab = d.sst(a, m, "sst")
        for k in idx:
            idx[k][i] = media_caja(an, *CAJAS[k])
        sst12[i] = media_caja(ab, *CAJAS["nino12"])
        lluvia[i] = media_caja(d.capa("precip", a, m, "total"), *CAJAS["costa_norte"])
        pa = d.capa("precip", a, m, "anomaly")
        lluvia_anom[i] = media_caja(pa, *CAJAS["costa_norte"])
        sst_dom.append(an[filas, cols].astype(np.float32))
        pre_dom.append(pa[filas, cols].astype(np.float32))
        vap_dom.append(d.capa("vapor", a, m, "anomaly")[filas, cols].astype(np.float32))
        eof_campos.append(an[eof_lat, eof_lon])
        if m == 0:
            print(f"  leído {a}", flush=True)

    sst_dom = np.array(sst_dom)
    pre_dom = np.array(pre_dom)
    vap_dom = np.array(vap_dom)

    # ---------------------------------------------------------------
    # 2) Índices E y C (Takahashi et al., 2011)
    #    EOF de anomalías de SST en 10°S–10°N, 120°E–80°W.
    # ---------------------------------------------------------------
    X = np.array(eof_campos).reshape(n, -1)
    lat_e = np.arange(10, -11, -1.0)
    w = np.sqrt(np.cos(np.radians(lat_e)))[:, None] * np.ones((1, eof_lon.stop - eof_lon.start))
    w = w.ravel()
    validos = np.all(np.isfinite(X), axis=0)
    base = (anios >= CLIMA[0]) & (anios <= CLIMA[1])
    Xb = (X[:, validos] * w[validos])
    media_b = Xb[base].mean(axis=0)
    _, _, vt = np.linalg.svd(Xb[base] - media_b, full_matrices=False)
    pcs = (Xb - media_b) @ vt[:2].T
    pcs /= pcs[base].std(axis=0)
    pc1, pc2 = pcs[:, 0], pcs[:, 1]
    if np.corrcoef(pc1, idx["nino34"])[0, 1] < 0:
        pc1 = -pc1
    # Signo de PC2 tal que E = (PC1 − PC2)/√2 represente el Pacífico este.
    if np.corrcoef(pc2, idx["nino12"])[0, 1] > 0:
        pc2 = -pc2
    E = (pc1 - pc2) / np.sqrt(2)
    C = (pc1 + pc2) / np.sqrt(2)
    corr = {
        "E_nino12": float(np.corrcoef(E, idx["nino12"])[0, 1]),
        "C_nino4": float(np.corrcoef(C, idx["nino4"])[0, 1]),
        "PC1_nino34": float(np.corrcoef(pc1, idx["nino34"])[0, 1]),
    }
    print("Correlaciones de control:", {k: round(v, 2) for k, v in corr.items()})

    r12 = media_movil(idx["nino12"])
    r34 = media_movil(idx["nino34"])

    # ---------------------------------------------------------------
    # 3) Eventos
    # ---------------------------------------------------------------
    def etiqueta(i):
        return f"{MESES[meses[i]]} {anios[i]}"

    eventos = []
    pacificos = [(s, e) for s, e in rachas(r34 >= 0.5) if e - s + 1 >= 5]
    costeros = [(s, e) for s, e in rachas(r12 >= 0.4) if e - s + 1 >= 3]

    for s, e in pacificos:
        en_curso = e == n - 1
        ip = s + int(np.nanargmax(r34[s:e + 1]))
        # Calentamiento costero asociado (racha de Niño 1+2 que se solapa).
        sol = [(cs, ce) for cs, ce in costeros if ce >= s - 6 and cs <= e]
        cs = min([c[0] for c in sol], default=s)
        ce = max([c[1] for c in sol], default=e)
        ini = min(s, cs)
        fin = max(e, ce)
        i12 = ini + int(np.nanargmax(r12[ini:fin + 1]))
        adelanto = s - cs if sol else 0
        # El tipo depende de dónde está el calentamiento máximo; el inicio
        # costero (adelanto) se informa aparte como atributo.
        if r12[i12] >= 3.0 and r12[i12] >= r34[ip]:
            tipo = "oriental"
        elif r12[ip] < 0.6 * r34[ip]:
            tipo = "central"
        else:
            tipo = "canonico"
        eventos.append({
            "id": f"{anios[ini]}-{str(anios[fin])[-2:]}" if anios[fin] != anios[ini] else f"{anios[ini]}",
            "tipo": tipo,
            "anio0": int(anios[ini]),
            "inicio": etiqueta(ini), "fin": etiqueta(fin),
            "iInicio": int(ini), "iFin": int(fin),
            "duracion": int(fin - ini + 1),
            "enCurso": bool(en_curso),
            "pico34": round(float(r34[ip]), 2), "mesPico34": etiqueta(ip),
            "pico12": round(float(r12[i12]), 2), "mesPico12": etiqueta(i12),
            "adelantoCosta": int(adelanto),
            "inicioCostero": bool(adelanto >= 2),
            "E": round(float(np.nanmax(E[ini:fin + 1])), 2),
            "C": round(float(np.nanmax(C[ini:fin + 1])), 2),
        })

    usados = set()
    for ev in eventos:
        usados.update(range(ev["iInicio"], ev["iFin"] + 1))
    for cs, ce in costeros:
        if any(i in usados for i in range(cs, ce + 1)):
            continue
        i12 = cs + int(np.nanargmax(r12[cs:ce + 1]))
        if r12[i12] < 1.0:
            continue
        eventos.append({
            "id": f"{anios[cs]}" if anios[cs] == anios[ce] else f"{anios[cs]}-{str(anios[ce])[-2:]}",
            "tipo": "costero",
            "anio0": int(anios[cs]),
            "inicio": etiqueta(cs), "fin": etiqueta(ce),
            "iInicio": int(cs), "iFin": int(ce),
            "duracion": int(ce - cs + 1),
            "enCurso": bool(ce == n - 1),
            "pico34": round(float(np.nanmax(r34[cs:ce + 1])), 2), "mesPico34": etiqueta(cs + int(np.nanargmax(r34[cs:ce + 1]))),
            "pico12": round(float(r12[i12]), 2), "mesPico12": etiqueta(i12),
            "adelantoCosta": None,
            "inicioCostero": True,
            "E": round(float(np.nanmax(E[cs:ce + 1])), 2),
            "C": round(float(np.nanmax(C[cs:ce + 1])), 2),
        })
    eventos.sort(key=lambda ev: ev["iInicio"])

    # Lluvia en la costa norte durante el evento (máxima anomalía mensual).
    for ev in eventos:
        sl = slice(ev["iInicio"], ev["iFin"] + 1)
        k = ev["iInicio"] + int(np.nanargmax(lluvia_anom[sl]))
        ev["lluviaMax"] = round(float(lluvia_anom[k]), 1)
        ev["mesLluviaMax"] = etiqueta(k)

    print("\nEventos detectados:")
    for ev in eventos:
        print(f"  {ev['id']:9s} {ev['tipo']:15s} {ev['inicio']}–{ev['fin']}  N3.4 {ev['pico34']:+.1f}  "
              f"N1+2 {ev['pico12']:+.1f}  adelanto {ev['adelantoCosta']}  lluvia {ev['lluviaMax']:+.1f} ({ev['mesLluviaMax']})"
              f"{'  [en curso]' if ev['enCurso'] else ''}")

    # ---------------------------------------------------------------
    # 4) Viento a 10 m: climatología 1991–2020 y anomalías en el dominio
    # ---------------------------------------------------------------
    print("\nViento 10 m…", flush=True)
    paso_v = 4
    lat_v = np.arange(LAT_N, LAT_S - 1, -paso_v)
    lon_v = np.arange(LON_O, LON_E + 1, paso_v)
    jj = np.round(89.625 - lat_v).astype(int)
    ii = np.round(lon_v - 0.375).astype(int) % 360
    viento = {}
    for a in sorted(set(anios)):
        datos = d.viento_anio("10m", a)
        for m in range(datos.shape[0]):
            viento[(a, m)] = datos[m][:, jj][:, :, ii]
    clima_v = {m: np.nanmean([viento[(a, m)] for a in range(CLIMA[0], CLIMA[1] + 1)], axis=0) for m in range(12)}

    # ---------------------------------------------------------------
    # 5) Compuestos por grupo y ventana
    # ---------------------------------------------------------------
    pos = {f: i for i, f in enumerate(fechas)}

    def compuesto(anios0, ventana):
        ids = []
        for a0 in anios0:
            for m in ventana["meses"]:
                f = (a0 + ventana["anio"], m)
                if f in pos:
                    ids.append(pos[f])
        if not ids:
            return None
        uv = np.nanmean([viento[fechas[i]] - clima_v[fechas[i][1]] for i in ids], axis=0)
        return {
            "n": len(ids),
            "sst": b64_int8(np.nanmean(sst_dom[ids], axis=0), 0.05),
            "precip": b64_int8(np.nanmean(pre_dom[ids], axis=0), 0.15),
            "vapor": b64_int8(np.nanmean(vap_dom[ids], axis=0), 0.2),
            "u": b64_int8(uv[0], 0.1),
            "v": b64_int8(uv[1], 0.1),
            "nino12": round(float(np.nanmean(idx["nino12"][ids])), 2),
            "nino34": round(float(np.nanmean(idx["nino34"][ids])), 2),
            "lluvia": round(float(np.nanmean(lluvia_anom[ids])), 2),
        }

    compuestos = {}
    for g in GRUPOS:
        miembros = [ev["anio0"] for ev in eventos if ev["tipo"] == g and not ev["enCurso"]]
        GRUPOS[g]["miembros"] = [ev["id"] for ev in eventos if ev["tipo"] == g and not ev["enCurso"]]
        compuestos[g] = {v["id"]: compuesto(miembros, v) for v in VENTANAS}

    # Evento en curso: sus propias ventanas (las que existan) + últimos 2 meses.
    actual = next((ev for ev in eventos if ev["enCurso"]), None)
    if actual:
        a0 = actual["anio0"]
        compuestos["actual"] = {v["id"]: compuesto([a0], v) for v in VENTANAS}
        ult = {"id": "ultimo", "meses": [fechas[-2][1], fechas[-1][1]], "anio": fechas[-1][0] - a0}
        compuestos["actual"]["ultimo"] = compuesto([a0], ult)
        compuestos["actual"]["ultimoNombre"] = f"{MESES[fechas[-2][1]]}–{MESES[fechas[-1][1]]} {fechas[-1][0]}"

    # Máscara de tierra (1 = océano) del dominio.
    mascara = np.isfinite(np.nanmean(sst_dom[-24:], axis=0)).astype(np.uint8)

    # ---------------------------------------------------------------
    # 6) Climatología mensual y salida
    # ---------------------------------------------------------------
    clima = {
        "sst12": [round(float(np.nanmean(sst12[base & (meses == m)])), 2) for m in range(12)],
        "lluvia": [round(float(np.nanmean(lluvia[base & (meses == m)])), 2) for m in range(12)],
    }

    r2 = lambda x: [None if not np.isfinite(v) else round(float(v), 2) for v in x]  # noqa: E731
    salida = {
        "generado": "scripts/generar_esquemas_nino.py",
        "climatologia": f"{CLIMA[0]}-{CLIMA[1]}",
        "fechas": [[int(a), int(m)] for a, m in fechas],
        "series": {
            "nino12": r2(idx["nino12"]), "nino3": r2(idx["nino3"]),
            "nino34": r2(idx["nino34"]), "nino4": r2(idx["nino4"]),
            "nino12_3m": r2(r12), "nino34_3m": r2(r34),
            "sst12": r2(sst12), "lluvia": r2(lluvia), "lluviaAnom": r2(lluvia_anom),
            "E": r2(E), "C": r2(C),
        },
        "controlEC": corr,
        "clima": clima,
        "cajas": {k: list(v) for k, v in CAJAS.items()},
        "eventos": eventos,
        "grupos": GRUPOS,
        "ventanas": VENTANAS,
        "dominio": {
            "latN": LAT_N, "latS": LAT_S, "lonO": LON_O, "lonE": LON_E,
            "ancho": LON_E - LON_O + 1, "alto": LAT_N - LAT_S + 1,
            "mascara": base64.b64encode(mascara.tobytes()).decode("ascii"),
            "escalas": {"sst": 0.05, "precip": 0.15, "vapor": 0.2, "u": 0.1, "v": 0.1},
            "viento": {"paso": paso_v, "lat": lat_v.tolist(), "lon": lon_v.tolist()},
        },
        "compuestos": compuestos,
    }

    out = Path(carpeta) / "esquemas" / "nino.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(salida, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"\nEscrito {out} ({out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1])
