"""Suite offline de la capa sombra de Postgres (publish_metrics_db.py).

Ejercita las funciones que CONSTRUYEN filas, nunca la parte HTTP: el escritor
no debe necesitar red, credenciales ni un Supabase vivo para ser correcto.
Todos los identificadores son sinteticos (logins 900001+, magics 5001+) —
en este repo publico jamas entra un login real.

Se cubre lo que de verdad puede romperse en produccion:
  · forma de cada fila y tipos JSON-serializables,
  · estabilidad de metrics_hash (mismo bot -> mismo hash; un centavo -> otro),
  · que cycle_sha y updated_at NO entran en el hash,
  · deteccion de eventos en un segundo ciclo simulado,
  · que el primer ciclo emite solo first_seen,
  · que --dry-run no escribe absolutamente nada.
"""
from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import publish_metrics_db as pmd  # noqa: E402

GENERATED_AT = "2026-09-08T12:00:00+00:00"
CYCLE_SHA = "a" * 64


def _bot(login, magic, vps, **over):
    """Bot sintetico con los campos que el escritor consume de verdad."""
    bot = {
        "account_login": login,
        "magic": magic,
        "vps": vps,
        "symbols": ["EURUSD"],
        "is_real": False,
        "first_trade": "2024-01-15T09:00:00+00:00",
        "last_trade": "2026-09-07T12:00:00+00:00",
        # legado sin sufijo = de por vida SIN comision (metrics_meta lo documenta)
        "net_profit": 1234.56,
        "trades_lifetime": 812,
        "net_after_commission_lifetime": 1100.40,
        "net_after_commission_365d": 430.10,
        "net_profit_365d": 470.00,
        "net_30d": 55.25,
        "win_rate_pct_lifetime": 61.33,
        "profit_factor_lifetime": 1.42,
        "max_drawdown_lifetime": 310.5,
        "max_drawdown_365d": 180.0,
        "dd_pct_of_balance": 3.1,
        "calmar_365d": 2.39,
        "sortino_365d": 1.87,
        "months_active_lifetime": 32,
        "months_active_365d": 12,
        "return_monthly_pct_365d": 0.3584,
        "promotion_score": 71.2,
        "promotion_score_v2": 68.9,
        "promotion_status": "NEAR",
        "decay_flag": False,
        "drift": {"flag": False, "severity": 0.4},
    }
    bot.update(over)
    return bot


def _snapshot(bots=None, generated_at=GENERATED_AT):
    bots = bots if bots is not None else [
        _bot(900001, 5001, "vps1"),
        _bot(900002, 5002, "vps2", promotion_status="READY", promotion_score=88.0),
        _bot(900009, 5009, "vps3", is_real=True, promotion_status="NO"),
    ]
    logins = sorted({b["account_login"] for b in bots})
    return {
        "generated_at": generated_at,
        "numbering_epoch": "2026-07-27",
        "stale_vps": [],
        "partial_data": False,
        "accounts": [{"login": lg, "balance": 10000.0} for lg in logins],
        "bots": bots,
    }


def _write_data_dir(tmp_path, snap, timing=None, report=None) -> Path:
    data = tmp_path / "data"
    data.mkdir(parents=True, exist_ok=True)
    (data / "snapshot.json").write_text(json.dumps(snap), encoding="utf-8")
    if timing is not None:
        (data / "pipeline_timing.json").write_text(json.dumps(timing), encoding="utf-8")
    if report is not None:
        (data / "integrity_report.json").write_text(json.dumps(report), encoding="utf-8")
    return data


# ----------------------- forma de las filas -----------------------

def test_bot_key_excluye_el_vps():
    """El renumerado del 2026-07-27 probo que el VPS no es identidad: dos
    lecturas del mismo bot en maquinas distintas comparten bot_key."""
    a = _bot(900001, 5001, "vps5")
    b = _bot(900001, 5001, "vps3")
    assert pmd.bot_key(a) == pmd.bot_key(b) == "900001-5001"


def test_build_rows_forma_y_conteos():
    snap = _snapshot()
    registry, metrics = pmd.build_rows(snap, CYCLE_SHA, "2026-09-08T12:05:00+00:00")

    assert len(registry) == 3
    assert len(metrics) == 3

    reg = next(r for r in registry if r["bot_key"] == "900009-5009")
    assert reg["login"] == 900009 and reg["magic"] == 5009
    assert reg["vps"] == "vps3"
    assert reg["is_real"] is True
    assert reg["symbols"] == ["EURUSD"]
    assert reg["active"] is True
    assert reg["first_trade"].startswith("2024-01-15T09:00:00")

    met = next(m for m in metrics if m["bot_key"] == "900001-5001")
    assert met["as_of"] == "2026-09-08"          # fecha UTC de generated_at
    assert met["cycle_sha"] == CYCLE_SHA
    assert met["trades_lifetime"] == 812
    assert met["net_profit_lifetime"] == 1234.56
    assert met["net_after_commission_lifetime"] == 1100.40
    # net_365d canonico = CON comision, no el legado net_profit_365d
    assert met["net_365d"] == 430.10
    assert met["balance"] == 10000.0
    assert met["drift_flag"] is False            # aplanado desde drift.flag
    assert met["decay_flag"] is False
    assert len(met["metrics_hash"]) == 64


def test_todas_las_filas_son_json_serializables():
    """PostgREST rechaza NaN/Infinity: si algo se cuela, el ciclo escribe basura."""
    snap = _snapshot()
    registry, metrics = pmd.build_rows(snap, CYCLE_SHA, "2026-09-08T12:05:00+00:00")
    for row in registry + metrics:
        json.dumps(row, allow_nan=False)


def test_nan_e_infinity_se_convierten_en_null():
    bot = _bot(900001, 5001, "vps1",
               profit_factor_lifetime=float("inf"),
               calmar_365d=float("nan"))
    snap = _snapshot([bot])
    _, metrics = pmd.build_rows(snap, CYCLE_SHA, "2026-09-08T12:05:00+00:00")
    assert metrics[0]["profit_factor_lifetime"] is None
    assert metrics[0]["calmar_365d"] is None
    json.dumps(metrics[0], allow_nan=False)


def test_magic_cero_no_produce_fila():
    """magic 0 = operativa manual de la cuenta, no un bot."""
    snap = _snapshot([_bot(900001, 0, "vps1"), _bot(900002, 5002, "vps2")])
    registry, metrics = pmd.build_rows(snap, CYCLE_SHA, "2026-09-08T12:05:00+00:00")
    assert [r["bot_key"] for r in registry] == ["900002-5002"]
    assert [m["bot_key"] for m in metrics] == ["900002-5002"]


def test_as_of_se_ancla_al_snapshot_no_al_reloj():
    snap = _snapshot(generated_at="2026-01-02T23:59:59+00:00")
    _, metrics = pmd.build_rows(snap, CYCLE_SHA, "2026-09-08T12:05:00+00:00")
    assert all(m["as_of"] == "2026-01-02" for m in metrics)


# ----------------------- metrics_hash -----------------------

def test_metrics_hash_estable_entre_ciclos():
    """Un bot que no se movio produce el MISMO hash aunque cambien el sha del
    ciclo y la hora: por eso el UPSERT diario no altera nada observable."""
    snap = _snapshot([_bot(900001, 5001, "vps1")])
    _, m1 = pmd.build_rows(snap, "a" * 64, "2026-09-08T12:05:00+00:00")
    _, m2 = pmd.build_rows(snap, "b" * 64, "2026-09-08T18:40:00+00:00")
    assert m1[0]["metrics_hash"] == m2[0]["metrics_hash"]
    assert m1[0]["cycle_sha"] != m2[0]["cycle_sha"]


def test_metrics_hash_no_depende_del_orden_de_insercion():
    bot_a = _bot(900001, 5001, "vps1")
    bot_b = {k: bot_a[k] for k in reversed(list(bot_a.keys()))}
    _, ma = pmd.build_rows(_snapshot([bot_a]), CYCLE_SHA, "2026-09-08T12:05:00+00:00")
    _, mb = pmd.build_rows(_snapshot([bot_b]), CYCLE_SHA, "2026-09-08T12:05:00+00:00")
    assert ma[0]["metrics_hash"] == mb[0]["metrics_hash"]


@pytest.mark.parametrize("campo,valor", [
    ("net_profit", 1234.57),                 # un centavo
    ("promotion_score", 71.3),
    ("promotion_status", "READY"),
    ("decay_flag", True),
    ("trades_lifetime", 813),
])
def test_metrics_hash_cambia_si_cambia_una_metrica(campo, valor):
    base = _bot(900001, 5001, "vps1")
    moved = _bot(900001, 5001, "vps1", **{campo: valor})
    _, m0 = pmd.build_rows(_snapshot([base]), CYCLE_SHA, "2026-09-08T12:05:00+00:00")
    _, m1 = pmd.build_rows(_snapshot([moved]), CYCLE_SHA, "2026-09-08T12:05:00+00:00")
    assert m0[0]["metrics_hash"] != m1[0]["metrics_hash"]


def test_metrics_hash_ignora_el_vps():
    """Mover un bot de maquina no es un cambio de metrica."""
    _, m0 = pmd.build_rows(_snapshot([_bot(900001, 5001, "vps5")]),
                           CYCLE_SHA, "2026-09-08T12:05:00+00:00")
    _, m1 = pmd.build_rows(_snapshot([_bot(900001, 5001, "vps3")]),
                           CYCLE_SHA, "2026-09-08T12:05:00+00:00")
    assert m0[0]["metrics_hash"] == m1[0]["metrics_hash"]


# ----------------------- eventos -----------------------

def test_primer_ciclo_solo_emite_first_seen():
    snap = _snapshot()
    cur = pmd.state_from(snap, "2026-09-08T12:05:00+00:00")
    events = pmd.diff_events(None, cur, CYCLE_SHA, "2026-09-08T12:05:00+00:00")
    assert len(events) == 3
    assert {e["event_type"] for e in events} == {"first_seen"}
    assert sorted(e["bot_key"] for e in events) == [
        "900001-5001", "900002-5002", "900009-5009"]


def test_ciclo_sin_cambios_no_emite_nada():
    snap = _snapshot()
    prev = pmd.state_from(snap, "2026-09-08T11:45:00+00:00")
    cur = pmd.state_from(copy.deepcopy(snap), "2026-09-08T12:00:00+00:00")
    assert pmd.diff_events(prev, cur, CYCLE_SHA, "2026-09-08T12:05:00+00:00") == []


def test_segundo_ciclo_detecta_cada_transicion():
    snap1 = _snapshot()
    prev = pmd.state_from(snap1, "2026-09-08T11:45:00+00:00")

    snap2 = _snapshot([
        # 5001: sube de NEAR a READY (status + asiento) y entra en decay
        _bot(900001, 5001, "vps1", promotion_status="READY", decay_flag=True),
        # 5002: cambia de maquina y salta drift; sigue READY
        _bot(900002, 5002, "vps5", promotion_status="READY",
             promotion_score=88.0, drift={"flag": True, "severity": 1.5}),
        # 5009: pasa de demo a real
        _bot(900009, 5009, "vps3", is_real=True, promotion_status="NO"),
        # 5010: bot nuevo
        _bot(900003, 5010, "vps2"),
    ])
    # 900009 estaba ya como real en el ciclo 1 -> lo bajamos alli para poder
    # observar la promocion en el ciclo 2.
    prev["bots"]["900009-5009"]["is_real"] = False
    cur = pmd.state_from(snap2, "2026-09-08T12:00:00+00:00")
    events = pmd.diff_events(prev, cur, CYCLE_SHA, "2026-09-08T12:05:00+00:00")

    got = {(e["bot_key"], e["event_type"]) for e in events}
    assert ("900001-5001", "status_change") in got
    assert ("900001-5001", "seat_change") in got
    assert ("900001-5001", "decay_flag") in got
    assert ("900002-5002", "vps_move") in got
    assert ("900002-5002", "drift_flag") in got
    assert ("900002-5002", "status_change") not in got   # sigue READY
    assert ("900009-5009", "real_promoted") in got
    assert ("900003-5010", "first_seen") in got

    status = next(e for e in events
                  if e["bot_key"] == "900001-5001" and e["event_type"] == "status_change")
    assert status["from_value"] == "NEAR" and status["to_value"] == "READY"

    move = next(e for e in events if e["event_type"] == "vps_move")
    assert move["from_value"] == "vps2" and move["to_value"] == "vps5"

    assert {e["event_type"] for e in events} <= pmd.EVENT_TYPES


def test_bot_ausente_emite_missing_y_no_lo_da_por_muerto():
    """Cesta fija: un VPS caido no convierte un bot en un bot muerto."""
    snap1 = _snapshot()
    prev = pmd.state_from(snap1, "2026-09-08T11:45:00+00:00")
    snap2 = _snapshot([_bot(900001, 5001, "vps1")])
    cur = pmd.state_from(snap2, "2026-09-08T12:00:00+00:00")
    events = pmd.diff_events(prev, cur, CYCLE_SHA, "2026-09-08T12:05:00+00:00")
    missing = [e for e in events if e["event_type"] == "missing"]
    assert sorted(e["bot_key"] for e in missing) == ["900002-5002", "900009-5009"]
    assert all(e["detail"]["last_vps"] for e in missing)


def test_dormant_se_dispara_por_antiguedad_del_ultimo_cierre():
    fresh = _bot(900001, 5001, "vps1", last_trade="2026-09-07T12:00:00+00:00")
    stale_dt = datetime.fromisoformat(GENERATED_AT) - timedelta(days=45)
    stale = _bot(900001, 5001, "vps1", last_trade=stale_dt.isoformat())

    prev = pmd.state_from(_snapshot([fresh]), "2026-09-08T11:45:00+00:00")
    cur = pmd.state_from(_snapshot([stale]), "2026-09-08T12:00:00+00:00")
    events = pmd.diff_events(prev, cur, CYCLE_SHA, "2026-09-08T12:05:00+00:00")
    dormant = [e for e in events if e["event_type"] == "dormant"]
    assert len(dormant) == 1
    assert dormant[0]["to_value"] == "True"
    assert dormant[0]["detail"]["threshold_days"] == pmd.DORMANT_DAYS


def test_todo_evento_esta_en_el_contrato():
    """El comentario de 004_bot_events.sql lista los tipos permitidos; si el
    escritor inventa uno nuevo, este test lo caza antes que la base."""
    snap1 = _snapshot()
    prev = pmd.state_from(snap1, "2026-09-08T11:45:00+00:00")
    snap2 = _snapshot([_bot(900004, 5011, "vps6")])
    cur = pmd.state_from(snap2, "2026-09-08T12:00:00+00:00")
    events = pmd.diff_events(prev, cur, CYCLE_SHA, "2026-09-08T12:05:00+00:00")
    assert events
    assert {e["event_type"] for e in events} <= pmd.EVENT_TYPES


# ----------------------- fila de salud -----------------------

def test_pipeline_health_se_omite_sin_run_id(monkeypatch):
    """En local no se inventa un run_id: un id falso ensucia la tabla para siempre."""
    monkeypatch.delenv("GITHUB_RUN_ID", raising=False)
    assert pmd.build_health_row(_snapshot(), CYCLE_SHA,
                                "2026-09-08T12:05:00+00:00") is None


def test_pipeline_health_con_run_id(tmp_path, monkeypatch):
    snap = _snapshot()
    data = _write_data_dir(
        tmp_path, snap,
        timing={"cycle": {"end_to_end_ms": 250000, "post_merge_ms": 90000}},
        report={"ok": True, "generated_at": "2026-09-08T12:04:00Z"},
    )
    monkeypatch.setattr(pmd, "TIMING_FILE", data / "pipeline_timing.json")
    monkeypatch.setattr(pmd, "REPORT_FILE", data / "integrity_report.json")
    monkeypatch.setenv("GITHUB_RUN_ID", "1234567890")

    row = pmd.build_health_row(snap, CYCLE_SHA, "2026-09-08T12:05:00+00:00")
    assert row["run_id"] == 1234567890
    assert row["ok"] is True
    assert row["verify_rc"] == 0
    assert row["bots"] == 3
    assert row["vps_stale"] == 0
    assert row["partial_data"] is False
    assert row["stages"]["end_to_end_ms"] == 250000
    assert row["started_at"] < row["finished_at"]
    json.dumps(row, allow_nan=False)


# ----------------------- --dry-run -----------------------

def _run_dry(data_dir, env_extra=None):
    env = dict(os.environ)
    env["PYTHONHASHSEED"] = "0"
    # Credenciales imposibles a proposito: --dry-run no debe intentar nada.
    env.pop("SUPABASE_URL", None)
    env.pop("SUPABASE_SERVICE_ROLE_KEY", None)
    env.pop("GITHUB_RUN_ID", None)
    env.update(env_extra or {})
    return subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "publish_metrics_db.py"),
         "--dry-run", "--data-dir", str(data_dir)],
        capture_output=True, text=True, env=env, timeout=120,
    )


def test_dry_run_no_escribe_nada(tmp_path):
    data = _write_data_dir(tmp_path, _snapshot())
    before = sorted(p.name for p in data.rglob("*"))

    proc = _run_dry(data)
    assert proc.returncode == 0, proc.stderr

    after = sorted(p.name for p in data.rglob("*"))
    assert before == after
    assert not (data / "shadow").exists()
    assert not (data / "shadow" / "db_state.json").exists()


def test_dry_run_imprime_conteos_y_muestra(tmp_path):
    data = _write_data_dir(tmp_path, _snapshot())
    proc = _run_dry(data)
    out = proc.stdout
    assert "registry=3" in out and "metric_daily=3" in out and "events=3" in out
    assert "first_seen=3" in out
    assert "DRY-RUN" in out
    assert "muestra bot_metric_daily" in out
    # La muestra debe ser una fila JSON valida con su hash.
    start = out.index("{", out.index("muestra bot_metric_daily"))
    row = json.loads(out[start:out.index("\n}", start) + 2])
    assert len(row["metrics_hash"]) == 64
    assert row["as_of"] == "2026-09-08"


def test_kill_switch_apaga_todo(tmp_path):
    data = _write_data_dir(tmp_path, _snapshot())
    proc = _run_dry(data, {"DB_SHADOW_WRITE": "0"})
    assert proc.returncode == 0
    assert "DB_SHADOW_WRITE=0" in proc.stdout
    assert "registry=" not in proc.stdout


def test_sin_snapshot_sale_cero(tmp_path):
    """Contrato duro: la capa sombra NUNCA rompe un ciclo."""
    data = tmp_path / "data"
    data.mkdir()
    proc = _run_dry(data)
    assert proc.returncode == 0


def test_snapshot_ilegible_sale_cero(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    (data / "snapshot.json").write_text("{no es json", encoding="utf-8")
    proc = _run_dry(data)
    assert proc.returncode == 0


def test_sin_credenciales_sale_cero(tmp_path):
    """Sin --dry-run y sin credenciales: mensaje claro y rc=0."""
    data = _write_data_dir(tmp_path, _snapshot())
    env = dict(os.environ)
    env.pop("SUPABASE_URL", None)
    env.pop("SUPABASE_SERVICE_ROLE_KEY", None)
    # ENV_FILE apunta al .env.local real del repo: lo desviamos a un vacio.
    env["HOME"] = str(tmp_path)
    proc = subprocess.run(
        [sys.executable, "-c",
         "import sys; sys.path.insert(0, %r); sys.argv=['x','--data-dir',%r];"
         "import publish_metrics_db as p; p.ENV_FILE=__import__('pathlib')"
         ".Path(%r); sys.exit(p.main(['--data-dir',%r]))"
         % (str(ROOT / "scripts"), str(data), str(tmp_path / "nope.env"), str(data))],
        capture_output=True, text=True, env=env, timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    assert "capa sombra omitida" in proc.stderr


# ----------------------- migraciones -----------------------

def test_migraciones_tienen_su_down_y_no_borran_tablas_fuera_de_el():
    """Una `drop table` en un archivo de subida seria un borrado silencioso
    de historia el dia que alguien re-corriera la migracion."""
    mdir = ROOT / "supabase" / "migrations"
    ups = sorted(p for p in mdir.glob("*.sql") if not p.name.endswith(".down.sql"))
    assert len(ups) >= 6
    for up in ups:
        down = mdir / up.name.replace(".sql", ".down.sql")
        assert down.exists(), f"{up.name} sin .down.sql"
        body = up.read_text(encoding="utf-8").lower()
        assert "drop table" not in body, f"{up.name} contiene drop table"
        # RLS obligatoria en toda tabla nueva.
        if "create table" in body:
            assert "enable row level security" in body, f"{up.name} sin RLS"


def test_check_rest_conoce_todas_las_migraciones_que_crean_tablas():
    """Si alguien anade una migracion con tabla y olvida EXPECTED_TABLES,
    --check-rest daria 'todo ok' sin haberla mirado."""
    sys.path.insert(0, str(ROOT / "scripts"))
    import migrate  # noqa: PLC0415

    mdir = ROOT / "supabase" / "migrations"
    for up in mdir.glob("*.sql"):
        if up.name.endswith(".down.sql"):
            continue
        body = up.read_text(encoding="utf-8").lower()
        if "create table" not in body:
            continue
        version = up.name[:-4]
        assert version in migrate.EXPECTED_TABLES, (
            f"{up.name} crea una tabla y no esta en migrate.EXPECTED_TABLES")
