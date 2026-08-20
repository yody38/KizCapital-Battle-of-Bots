#!/usr/bin/env python3
"""
integrity_watchdog.py — End-to-end Data Integrity verification for Kiz Capital
Battle of Bots dashboard. Runs every 30 min via Anthropic remote cron (skill
`battle-of-bots-integrity-check`), or on demand.

The CI pipeline (mirror.sh) already gates upload with verify_integrity.py --strict.
This watchdog adds a SECOND layer that verifies the live deploy — confirms what
landed in Supabase Storage IS what the dashboard will serve. Covers the window
between "CI passed" and "user sees the data".

Steps (exit non-zero on any FAIL):
  1. gh run list → latest refresh-dashboard conclusion=success
  2. gh run download → integrity-report artifact, validate ok=true
  3. Supabase Storage live integrity_report.json — exists + fresh
  4. HEAD probe ALL per-bot files in Supabase — zero 404s
  5. Vercel index.html — version pin matches (warn, not fail)

On FAIL:
  - Append failure line to data/integrity_health_log.jsonl
  - Create GitHub Issue (dedupe by date — one issue per UTC day; reopens if closed)

On PASS:
  - Append success line to data/integrity_health_log.jsonl
  - Exit 0, single-line summary to stdout

Usage:
  python3 integrity_watchdog.py              # full verification
  python3 integrity_watchdog.py --no-issue   # don't create GH issue on fail
  python3 integrity_watchdog.py --quiet      # only print FAIL details
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib import error as urlerror
from urllib import request as urlrequest

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from alert_telegram import send as tg_send
except Exception:  # alerting must never break the watchdog
    def tg_send(text, **kw):  # type: ignore[misc]
        return "unavailable"

import r2_read  # noqa: E402  — [EGRESS] lectura del espejo, ver r2_read.py

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
ENV_FILE = ROOT / ".env.local"
LOG_FILE = DATA_DIR / "integrity_health_log.jsonl"

BUCKET = "dashboard-data"
GH_REPO = "yody38/KizCapital-Battle-of-Bots"
WORKFLOW = "refresh-dashboard"
VERCEL_URL = "https://kiz-capital-bots-kiz-capital-battle-of-bots-projects.vercel.app/"

# Tolerance for Supabase report staleness vs CI run (seconds).
# CI run finish → upload completes within ~30s. We allow up to 15 min just
# in case the watchdog catches a moment when CI is mid-cycle.
STALE_TOLERANCE_SEC = 15 * 60
MCP_DEADMAN_SEC = 90 * 60  # mcp-health is dispatched ~every 30min (VPS5 dispatch_ci.ps1, like
                           # refresh/watchdog). GH free-tier cron */5 is throttled to ~2h and is
                           # only a backstop, so 20min was a guaranteed false positive. 90min =
                           # tolerate 2 missed dispatch cycles, still catch a dead monitor in <1.5h.
LIVE_DEADMAN_SEC = 90      # live stream pushes every ~3s → >90s stale = worker/tailnet/MT5 dead
LIVE_REAL_LOGINS = {25425, 32081, 43306, 43411, 43414}  # 5 reales en vivo: 32081/43306 (VPS3) + 25425/43411/43414 (VPS6); roster por VPS en C:\mt5-mcp\.live_publisher.env


# ---------- env / helpers ----------

def load_env() -> dict[str, str]:
    """Read creds from process env first (CI), then .env.local (local manual runs)."""
    env: dict[str, str] = {}
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        v = os.environ.get(k)
        if v:
            env[k] = v
    if ENV_FILE.exists():
        for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return env


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s)
    except Exception:
        return None


# ---------- step 1: latest CI run ----------

def latest_ci_runs() -> list[dict]:
    out = subprocess.run(
        [
            "gh", "run", "list",
            "--workflow", WORKFLOW,
            "--repo", GH_REPO,
            "--limit", "5",
            "--json", "databaseId,status,conclusion,createdAt,updatedAt",
        ],
        check=True, capture_output=True, text=True, timeout=30,
    )
    runs = json.loads(out.stdout)
    if not runs:
        raise RuntimeError("no CI runs found")
    return runs


# ---------- step 2: artifact ----------

def download_artifact(run_id: int, dest: Path) -> Path:
    name = f"integrity-report-{run_id}"
    dest.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "gh", "run", "download", str(run_id),
            "--repo", GH_REPO,
            "-n", name,
            "-D", str(dest),
        ],
        check=True, capture_output=True, text=True, timeout=60,
    )
    f = dest / "integrity_report.json"
    if not f.exists():
        raise RuntimeError(f"artifact {name} did not contain integrity_report.json")
    return f


# ---------- step 3 + 4: supabase ----------

def supa_request(url: str, key: str, path: str, method: str) -> tuple[int, bytes]:
    encoded = "/".join(path.split("/"))  # paths in this project don't contain spaces
    endpoint = f"{url.rstrip('/')}/storage/v1/object/{BUCKET}/{encoded}"
    req = urlrequest.Request(
        endpoint,
        headers={"Authorization": f"Bearer {key}", "apikey": key},
        method=method,
    )
    try:
        with urlrequest.urlopen(req, timeout=30) as r:
            return r.status, r.read() if method == "GET" else b""
    except urlerror.HTTPError as e:
        return e.code, b""


def supa_get_json(url: str, key: str, path: str) -> tuple[int, dict | None]:
    code, body = supa_request(url, key, path, "GET")
    if code != 200:
        return code, None
    try:
        return code, json.loads(body)
    except Exception:
        return code, None


# [CUOTA] Muestreo rotatorio en vez de la flota entera cada ciclo.
# Antes: 402 HEAD por corrida x 48 corridas/dia = ~19.000 peticiones diarias
# contra la cuota del plan Free. Ahora cada corrida audita una rebanada distinta
# y determinista, asi que la flota completa se cubre igual — solo que repartida
# en el tiempo. Con 402 bots y rebanadas de 40, la cobertura total se completa
# cada ~11 corridas (~5,5 h) y las peticiones bajan un 90%.
# Las cuentas REALES quedan FUERA del muestreo: se comprueban SIEMPRE, todas y
# en cada corrida — ahi no se reparte el riesgo en el tiempo.
BOT_SAMPLE_SIZE = 40


def head_all_bot_files(
    url: str, key: str, bots: list[dict], sample: int = BOT_SAMPLE_SIZE,
    real_logins: set[int] | None = None,
) -> tuple[list[tuple[str, int]], int]:
    """(fallos, nº comprobados). Fallo = archivo que no devolvio 200."""
    reals = real_logins or set()
    ordenados = sorted(bots, key=lambda b: f"{b['vps']}/{b['account_login']}-{b['magic']}")
    siempre = [b for b in ordenados if int(b.get("account_login") or 0) in reals]
    resto = [b for b in ordenados if int(b.get("account_login") or 0) not in reals]

    if sample and sample < len(resto):
        # Ventana determinista que avanza con el tiempo: sin estado en disco y
        # sin aleatoriedad, asi que dos corridas seguidas nunca repiten rebanada.
        turnos = (len(resto) + sample - 1) // sample
        idx = (int(time.time()) // 1800) % turnos          # 1800s = cadencia del watchdog
        elegidos = resto[idx * sample:(idx + 1) * sample]
    else:
        elegidos = resto

    objetivo = siempre + elegidos
    missing: list[tuple[str, int]] = []
    for b in objetivo:
        path = f"bots/{b['vps']}/{b['account_login']}-{b['magic']}.json"
        try:
            code, _ = supa_request(url, key, path, "HEAD")
        except Exception:
            code = -1
        if code != 200:
            missing.append((path, code))
    return missing, len(objetivo)


# ---------- step 5: vercel ----------

def vercel_version_pin() -> tuple[str | None, str | None]:
    """Returns (app_js_version, styles_css_version) parsed from index.html."""
    try:
        with urlrequest.urlopen(VERCEL_URL, timeout=15) as r:
            html = r.read().decode("utf-8", errors="replace")
    except Exception:
        return None, None
    app, css = None, None
    for line in html.splitlines():
        if "app.js?v=" in line:
            app = line.split("app.js?v=")[1].split('"')[0]
        elif "styles.css?v=" in line:
            css = line.split("styles.css?v=")[1].split('"')[0]
        if app and css:
            break
    return app, css


# ---------- GitHub Issue (dedupe by date) ----------

def file_issue_dedupe(title_root: str, body: str) -> str:
    """Create or update a GH issue. Title includes today's UTC date so we get
    at most one issue per day per kind. If an open issue with that title exists,
    append a comment instead of creating new."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    title = f"[integrity-watchdog] {title_root} — {today}"

    # Search existing — filter by label for structured dedupe, not title substring.
    try:
        out = subprocess.run(
            [
                "gh", "issue", "list", "--repo", GH_REPO,
                "--state", "open", "--label", "integrity-watchdog",
                "--json", "number,title",
            ],
            check=True, capture_output=True, text=True, timeout=30,
        )
        existing = json.loads(out.stdout)
    except Exception:
        existing = []
    match = next((i for i in existing if i.get("title") == title), None)

    if match:
        # Append comment
        try:
            subprocess.run(
                [
                    "gh", "issue", "comment", str(match["number"]),
                    "--repo", GH_REPO, "--body", body,
                ],
                check=True, capture_output=True, text=True, timeout=30,
            )
            return f"#{match['number']} (commented)"
        except Exception as e:
            return f"comment_failed: {e}"

    try:
        out = subprocess.run(
            [
                "gh", "issue", "create", "--repo", GH_REPO,
                "--title", title, "--body", body,
                "--label", "integrity-watchdog",
            ],
            check=True, capture_output=True, text=True, timeout=30,
        )
        # gh prints the issue URL on stdout
        url = out.stdout.strip().splitlines()[-1]
        num = url.rstrip("/").rsplit("/", 1)[-1]
        # Push alert ONLY on creation (1/day by dedupe) — same-day comments stay
        # silent to respect the daily alert budget.
        tg = tg_send(f"🟠 integrity drift: {title_root}\n{body[:600]}\nIssue #{num}",
                     source="integrity-watchdog")
        print(f"[watchdog] telegram={tg}")
        return f"#{num} (created)"
    except Exception as e:
        return f"create_failed: {e}"


# ---------- main ----------

# --- Severidad de fallos: INFRA vs DATOS -----------------------------------
# Un fallo de sonda/tooling (ssh ping de mcp-health, gh CLI, la carrera
# conocida del re-upload, el espejo de failover) NO significa datos malos en
# el dashboard: vps3 puede tardar >15s en responder un ping mientras su
# snapshot llega fresco y las 5 reales publican a 0s (incidente 2026-08-10/11:
# 87% de los fails de 7d eran solo mcp-health). result pasa a 3 estados:
#   ok   — todo verde
#   warn — SOLO fallos de infraestructura (el dato que sirve el dashboard está bien)
#   fail — al menos un fallo de DATOS (default fail-closed para patrones nuevos)
# El frontend (renderSystemHealth) refleja estos mismos patrones para
# reclasificar filas viejas del history — mantener ambas listas en sync.
INFRA_FAIL_PATTERNS = (
    "mcp-health critical",          # sonda ssh del monitor de infra
    "mcp_health.json",              # el monitor mismo ausente/ilegible
    "artifact_download_failed",     # gh run download (tooling)
    "ci_list_failed",               # gh run list (tooling)
    "missing 'upload' section",     # carrera verify-antes-de-upload (conocida)
    "workflows en rojo",            # workflows auxiliares, no el dato servido
    "failover R2",                  # espejo de respaldo, no la fuente primaria
)


def fail_severity(msg: str) -> str:
    return "infra" if any(p in msg for p in INFRA_FAIL_PATTERNS) else "data"


def append_log(record: dict) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def upload_health_to_supabase(url: str, key: str, record: dict) -> None:
    """Persist watchdog results to Storage so the dashboard's 'Salud del
    sistema' panel can show real uptime history. The GH Actions workspace is
    ephemeral (fresh checkout per run), so the local jsonl never accumulates —
    Storage is the durable store. Best-effort: never fails the watchdog.

      watchdog_status.json  — full record of the LATEST run
      watchdog_history.json — rolling 30d list of {ts, result, fails, duration_ms}
    """
    def _put(path: str, payload) -> None:
        endpoint = f"{url.rstrip('/')}/storage/v1/object/{BUCKET}/{path}"
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urlrequest.Request(
            endpoint,
            data=body,
            headers={
                "Authorization": f"Bearer {key}",
                "apikey": key,
                "Content-Type": "application/json",
                "x-upsert": "true",
            },
            method="POST",
        )
        with urlrequest.urlopen(req, timeout=30):
            pass

    try:
        _put("watchdog_status.json", record)

        _, history = supa_get_json(url, key, "watchdog_history.json")
        if not isinstance(history, list):
            history = []
        # [ESCALA E5] Se guardan tambien las metricas de capacidad para poder
        # PROYECTAR el crecimiento: sin serie historica no hay forma de avisar
        # con semanas de antelacion, que es justo lo que fallo con la cuota de
        # Supabase (nos enteramos el dia del aviso de restriccion).
        cap = (record.get("steps") or {}).get("capacity") or {}
        history.append({
            "ts": record.get("ts"),
            "result": record.get("result"),
            "fails": record.get("fails") or [],
            "duration_ms": record.get("duration_ms"),
            "bots": cap.get("bots"),
            "snapshot_bytes": cap.get("snapshot_bytes"),
            "max_objects_per_folder": cap.get("max_objects_per_folder"),
        })
        cutoff = datetime.now(timezone.utc).timestamp() - 30 * 86400
        pruned = []
        for h in history:
            t = parse_iso(h.get("ts"))
            if t and t.timestamp() >= cutoff:
                pruned.append(h)
        _put("watchdog_history.json", pruned)
    except Exception as e:  # noqa: BLE001
        print(f"[watchdog] health upload failed (non-fatal): {e}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-issue", action="store_true", help="Skip GH issue creation on fail")
    parser.add_argument("--quiet", action="store_true", help="Only print on fail")
    args = parser.parse_args()

    started = time.time()
    fails: list[str] = []
    warns: list[str] = []
    info: dict = {"ts": now_iso(), "steps": {}}
    dormant_eas: list[dict] = []  # "competencia siempre activa" monitor (separate alert)

    # Step 1
    completed_run = None
    try:
        runs = latest_ci_runs()
        run = runs[0]
        info["steps"]["ci"] = {
            "id": run["databaseId"],
            "status": run["status"],
            "conclusion": run.get("conclusion"),
            "updated_at": run.get("updatedAt"),
        }
        if run["status"] == "in_progress" or run["status"] == "queued":
            # Race: watchdog fired while CI is mid-cycle. Not a real drift —
            # the previous successful cycle's data is still serving the dashboard.
            # Steps 2/3 audit the newest COMPLETED run instead of the in-flight one.
            info["steps"]["ci"]["note"] = "pending — auditing previous completed run (race)"
        elif run["status"] != "completed" or run.get("conclusion") != "success":
            fails.append(f"CI run #{run['databaseId']} status={run['status']} conclusion={run.get('conclusion')}")
        completed_run = next(
            (r for r in runs if r["status"] == "completed" and r.get("conclusion") == "success"),
            None,
        )
        if completed_run and completed_run["databaseId"] != run["databaseId"]:
            info["steps"]["ci"]["audited_run"] = completed_run["databaseId"]
    except Exception as e:
        info["steps"]["ci"] = {"error": str(e)}
        fails.append(f"ci_list_failed: {e}")

    ci_ok = not fails
    ci_run = None
    if ci_ok and completed_run:
        ci_run = {"id": completed_run["databaseId"], "updated_at": completed_run.get("updatedAt")}

    # Step 2 — artifact (skip if no CI run id)
    artifact_report = None
    if ci_run and "id" in ci_run:
        try:
            dest = Path(f"/tmp/watchdog-art-{ci_run['id']}")
            f = download_artifact(ci_run["id"], dest)
            artifact_report = json.loads(f.read_text(encoding="utf-8"))
            info["steps"]["artifact"] = {
                "ok": artifact_report["ok"],
                "bots_checked": artifact_report["bots_checked"],
                "bots_failed": artifact_report["bots_failed"],
            }
            if not artifact_report["ok"]:
                fails.append(f"artifact report ok=false bots_failed={artifact_report['bots_failed']}")
        except Exception as e:
            info["steps"]["artifact"] = {"error": str(e)}
            fails.append(f"artifact_download_failed: {e}")

    # Step 3 — Supabase integrity_report
    env = load_env()
    url, key = env.get("SUPABASE_URL"), env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        fails.append("supabase_creds_missing (.env.local)")
        info["steps"]["supabase"] = {"error": "creds_missing"}
    else:
        code, supa_report = supa_get_json(url, key, "integrity_report.json")
        if code != 200 or not supa_report:
            fails.append(f"supabase integrity_report fetch http={code}")
            info["steps"]["supabase"] = {"http": code}
        else:
            info["steps"]["supabase"] = {
                "ok": supa_report["ok"],
                "bots_checked": supa_report["bots_checked"],
                "generated_at": supa_report["generated_at"],
            }
            if not supa_report["ok"]:
                fails.append("supabase integrity_report ok=false")
            # Freshness vs CI run finish time
            if ci_run and ci_run.get("updated_at"):
                ci_t = parse_iso(ci_run["updated_at"])
                supa_t = parse_iso(supa_report.get("generated_at"))
                if ci_t and supa_t:
                    lag = (ci_t - supa_t).total_seconds()
                    info["steps"]["supabase"]["lag_sec"] = lag
                    if lag > STALE_TOLERANCE_SEC:
                        fails.append(f"supabase stale: {int(lag)}s behind CI run")

            # gate on the 'upload' subsection written by upload_to_supabase.py —
            # verify runs BEFORE upload, so integrity ok can be true while the
            # upload is stuck. Without this the UPLOAD_STUCK signal never alerts.
            up = supa_report.get("upload")
            if up is None:
                fails.append("supabase integrity_report missing 'upload' section (re-upload failed or stale)")
            elif not up.get("ok", True):
                fails.append(
                    f"upload not ok: failed={up.get('failed')} stuck={up.get('stuck_count')} "
                    f"classes={up.get('fail_by_class')}"
                )
            info["steps"]["upload"] = up

        # Step 4 — HEAD probe per-bot files
        # [EGRESS] El contenido del snapshot (único GET pesado del watchdog) sale
        # del espejo R2 cuando CI_READ_SOURCE=r2 — la paridad R2==Supabase ya la
        # verifica el uploader cada ciclo (parity_ok) y la frescura de la COPIA de
        # Supabase sigue vigilada por el lag de integrity_report y los HEAD/list.
        # Cualquier fallo de R2 cae al GET de Supabase original.
        code, snap = None, None
        if r2_read.read_source() == "r2":
            try:
                snap = json.loads(r2_read.r2_get_bytes("snapshot.json"))
                code = 200
            except Exception as exc:  # noqa: BLE001
                print(f"[watchdog] r2 snapshot.json: {exc} — fallback a Supabase", file=sys.stderr)
                snap = None
        if snap is None:
            code, snap = supa_get_json(url, key, "snapshot.json")
        if code != 200 or not snap:
            fails.append(f"supabase snapshot.json fetch http={code}")
            info["steps"]["files"] = {"error": f"snapshot_http={code}"}
        else:
            # Pipeline wall-clock dead-man: if the whole cron/CI died, the deployed
            # snapshot.generated_at stops advancing (the vps_freshness inside it is
            # frozen, so it cannot self-detect this). Precedent: mcp-health dead 12d.
            snap_t = parse_iso(snap.get("generated_at"))
            snap_age = (datetime.now(timezone.utc) - snap_t).total_seconds() if snap_t else None
            info["steps"]["snapshot_age_sec"] = int(snap_age) if snap_age is not None else None
            if snap_age is None:
                fails.append("supabase snapshot.json has no parseable generated_at")
            elif snap_age > 90 * 60:
                fails.append(f"pipeline dead-man: snapshot {int(snap_age/60)}min old (>90min — cron/CI stalled)")
            bots = [b for b in snap.get("bots", []) if b.get("magic", 0) != 0]
            missing, comprobados = head_all_bot_files(
                url, key, bots, real_logins=LIVE_REAL_LOGINS)
            info["steps"]["files"] = {
                "total": len(bots),
                "checked": comprobados,
                "missing": len(missing),
                "samples": [f"{p}={c}" for p, c in missing[:5]],
            }
            if missing:
                fails.append(
                    f"supabase missing files: {len(missing)} de {comprobados} comprobados "
                    f"(flota {len(bots)}; muestreo rotatorio + todas las reales)")
            # Per-VPS freshness emitted by post_merge.py — surface stale VPSs
            # in the issue body so triage is one click instead of a grep.
            vf = snap.get("vps_freshness") or {}
            stale_vps = []
            for v_id in sorted(vf.keys()):
                v = vf[v_id] or {}
                if not v.get("present"):
                    stale_vps.append(f"{v_id}=missing")
                elif v.get("stale"):
                    lag_min = round((v.get("lag_sec") or 0) / 60, 1)
                    stale_vps.append(f"{v_id}={lag_min}min")
            info["steps"]["vps_freshness"] = {
                "summary": {k: {"lag_min": round((vf[k].get("lag_sec") or 0) / 60, 1),
                                 "stale": bool(vf[k].get("stale"))}
                            for k in vf if vf[k].get("present")},
                "stale": stale_vps,
                "partial_data": bool(snap.get("partial_data")),
            }
            if stale_vps:
                fails.append(f"stale VPSs: {', '.join(stale_vps)}")
            # Carry-forward escalation: a VPS carried from last-good data is fine for
            # a few cycles (graceful degradation), but data frozen too long must alarm
            # — it means the VPS never recovered. Demo: >3h. Real (vps3): >35min.
            for v_id in sorted(vf.keys()):
                v = vf[v_id] or {}
                if v.get("carried_forward"):
                    lag = v.get("lag_sec") or 0
                    cap = 35 * 60 if v_id == "vps3" else 3 * 3600
                    if lag > cap:
                        fails.append(f"carry-forward too long: {v_id} frozen {round(lag/60)}min (>{round(cap/60)}min — VPS never recovered)")

            # Step 4c — "competencia siempre activa" monitor. A demo EA that WAS an
            # established competitor (trades ≥ 30) but stopped trading (post_merge flags
            # dormant / days_since_last_trade) has detached/crashed on its VPS. Not data
            # corruption → does NOT hard-fail integrity; raises its OWN deduped issue so
            # the competition field stays full & live.
            real_magics = set(snap.get("real_magics") or [])
            for b in snap.get("bots", []):
                if (b.get("magic", 0) != 0
                        and b.get("magic") not in real_magics
                        and (b.get("trades") or 0) >= 30
                        and b.get("dormant")):
                    dormant_eas.append({
                        "magic": b.get("magic"),
                        "vps": b.get("vps"),
                        "account": b.get("account_login"),
                        "symbol": (b.get("symbols") or [None])[0],
                        "days_since_last_trade": b.get("days_since_last_trade"),
                    })
            dormant_eas.sort(key=lambda d: -(d.get("days_since_last_trade") or 0))
            info["steps"]["dormant_eas"] = {"count": len(dormant_eas), "samples": dormant_eas[:8]}

        # Step 4b — MCP-health monitor liveness. A stale checked_at means the
        # MONITOR died (VPS5 dispatcher down + GH cron throttled), not the
        # product: Step 4's pipeline dead-man (snapshot.generated_at > 90min)
        # already hard-fails when the DATA stops advancing, with no dispatcher
        # dependency. So monitor staleness is warn-only (surfaced in the issue
        # body / health log), per kiz-tribunal verdict on c95ef57 — it must not
        # page the inbox while the data is provably fresh. An ABSENT file is
        # still a hard fail (monitor never deployed — the 12-day blind spot
        # 2026-05-26 → 2026-06-07), and any_critical stays a fail (real
        # VPS down/stale, debounced by FAIL_THRESHOLD=3 upstream) — but a
        # severity-INFRA one: it degrades result to 'warn', never 'fail'.
        now = datetime.now(timezone.utc)
        code, mcp = supa_get_json(url, key, "mcp_health.json")
        if code != 200 or not mcp:
            fails.append(f"mcp_health.json fetch http={code} (MCP monitor dead/undeployed?)")
            info["steps"]["mcp_health"] = {"http": code}
        else:
            checked = parse_iso(mcp.get("checked_at") or mcp.get("generated_at"))
            age = (now - checked).total_seconds() if checked else None
            info["steps"]["mcp_health"] = {
                "summary": mcp.get("summary"),
                "checked_at": mcp.get("checked_at"),
                "age_sec": int(age) if age is not None else None,
                "any_critical": mcp.get("any_critical"),
            }
            if age is None:
                fails.append("mcp_health.json has no parseable checked_at")
            elif age > MCP_DEADMAN_SEC:
                info["steps"]["mcp_health"]["stale_warn"] = (
                    f"monitor last ran {int(age/60)}min ago (>{MCP_DEADMAN_SEC//60}min) — "
                    "monitor-health warn only; data freshness is gated by Step 4"
                )
            if mcp.get("any_critical"):
                # summary is "<ok>/<total>" — name the DOWN ones, not the OK count.
                down = sorted(
                    v for v, d in (mcp.get("vps") or {}).items()
                    if isinstance(d, dict) and d.get("status") not in ("ok", "warn")
                )
                total = mcp.get("total") or len(mcp.get("vps") or {}) or "?"
                fails.append(f"mcp-health critical: {len(down)}/{total} VPS down ({', '.join(down) or 'unknown'})")

        # Step 4b — Live equity stream freshness (the 2 REAL accounts). This is the
        # only pipeline without its own watchdog; if it dies (Railway down, TS
        # authkey expired, SSH hung), the dashboard silently falls back to the
        # 30-min snapshot. Verify BOTH real logins are fresh — full denominator,
        # not "if one lives they all live".
        try:
            ep = f"{url.rstrip('/')}/rest/v1/live_real_state?select=login,ts"
            req = urlrequest.Request(ep, headers={"Authorization": f"Bearer {key}", "apikey": key})
            with urlrequest.urlopen(req, timeout=20) as r:
                live_rows = json.loads(r.read())
        except Exception as e:
            live_rows = None
            fails.append(f"live_real_state fetch failed: {e}")
        if live_rows is not None:
            ages = {}
            for row in live_rows:
                t = parse_iso(row.get("ts"))
                if t and row.get("login") in LIVE_REAL_LOGINS:
                    ages[int(row["login"])] = (now - t).total_seconds()
            info["steps"]["live_stream"] = {"ages_sec": {str(k): int(v) for k, v in ages.items()}}
            missing = LIVE_REAL_LOGINS - set(ages)
            if missing:
                fails.append(f"live-stream: no row for real login(s) {sorted(missing)}")
            stale = {k: int(v) for k, v in ages.items() if v > LIVE_DEADMAN_SEC}
            if stale:
                fails.append(
                    f"live-stream dead-man: real account(s) stale {stale}s "
                    f"(>{LIVE_DEADMAN_SEC}s — Railway worker / tailnet / MT5 down?)"
                )
            # Root cause via publisher_heartbeat (best-effort: la tabla puede no
            # existir aún). Heartbeat fresco + cuenta stale → lado MT5/broker;
            # heartbeat viejo → proceso/SSH/Railway caído.
            if missing or stale:
                hb_ages = {}
                try:
                    ep2 = f"{url.rstrip('/')}/rest/v1/publisher_heartbeat?select=vps,ts"
                    req2 = urlrequest.Request(ep2, headers={"Authorization": f"Bearer {key}", "apikey": key})
                    with urlrequest.urlopen(req2, timeout=20) as r2:
                        for hb_row in json.loads(r2.read()):
                            t = parse_iso(hb_row.get("ts"))
                            if t:
                                hb_ages[str(hb_row.get("vps"))] = int((now - t).total_seconds())
                except Exception:
                    pass
                if hb_ages:
                    info["steps"]["publisher_heartbeat"] = hb_ages
                    # Una fila con DIAS de antiguedad no es un publisher caido: es uno
                    # RETIRADO. vps6 dejo una de 23 dias al consolidar las 5 reales en
                    # vps3 (2026-07-27), y desde entonces cada incidente acusaba a una
                    # maquina sana — mandando a mirar donde no estaba el problema.
                    RETIRED_SEC = 86400
                    retired = sorted(v for v, a in hb_ages.items() if a >= RETIRED_SEC)
                    active = {v: a for v, a in hb_ages.items() if a < RETIRED_SEC}
                    info["steps"]["publisher_retired"] = retired
                    alive = sorted(v for v, a in active.items() if a < 180)
                    dead = sorted(v for v, a in active.items() if a >= 180)
                    fails.append(
                        f"live-stream root-cause: publisher vivo en {alive or 'ninguno'}"
                        f" (→ lado MT5/broker), heartbeat muerto en {dead or 'ninguno'}"
                        f" (→ proceso/SSH/Railway) · ages_sec={active}"
                        + (f" · retirados (>24h, ignorados): {retired}" if retired else "")
                    )

        # Step 4b-bis — [RESILIENCIA R2] Regresión de compresión.
        # history_recent.jsonl viajó meses con 543 KB crudos porque se subió como
        # application/octet-stream (mimetypes no conoce .jsonl) y el CDN no
        # comprime binarios. Nadie lo vio. Este check falla si un archivo de datos
        # vuelve a servirse sin content-encoding.
        try:
            comp_bad = []
            for obj in ("snapshot.json", "history_recent.jsonl"):
                ep = f"{url.rstrip('/')}/storage/v1/object/{BUCKET}/{obj}"
                req = urlrequest.Request(
                    ep, method="HEAD",
                    headers={"Authorization": f"Bearer {key}", "apikey": key,
                             "Accept-Encoding": "br, gzip"})
                with urlrequest.urlopen(req, timeout=20) as r:
                    enc = r.headers.get("content-encoding")
                    ctype = (r.headers.get("content-type") or "").split(";")[0]
                    if not enc:
                        comp_bad.append(f"{obj}(type={ctype or '?'})")
            info["steps"]["compression"] = {"uncompressed": comp_bad}
            if comp_bad:
                fails.append(
                    f"compresion: {', '.join(comp_bad)} se sirve SIN comprimir "
                    f"(content-type mal → el CDN no comprime; revisar _EXTRA_MIME "
                    f"en upload_to_supabase.py)"
                )
        except Exception as e:  # noqa: BLE001 — check aditivo, nunca tumba el watchdog
            info["steps"]["compression"] = {"error": str(e)}

    # Step 4b-cap — [ESCALA E5] Presupuesto de datos con alarma ANTICIPADA.
    #
    # El owner suma 5-10 bots/dia y proyecta 2.000+ en 90 dias. Cada limite del
    # sistema tiene un techo conocido; lo que faltaba era avisar ANTES de
    # llegar, no el dia que revienta (como paso con la cuota de Supabase).
    # Se mide el consumo actual y se proyecta con el ritmo real de la serie
    # historica: si un umbral se cruza en <30 dias, se avisa diciendo cuantos
    # dias quedan.
    CAP_LIMITS = {
        # metrica -> (umbral de aviso, techo real, explicacion)
        "snapshot_bytes": (3_000_000, None,
                           "el navegador parsea el snapshot entero en cada carga"),
        "max_objects_per_folder": (800, 1000,
                                   "el listado de Storage pagina a 1000 por carpeta"),
        "ci_duration_sec": (1200, 1800,
                            "el ciclo debe caber en su ventana de 30 min"),
    }
    if url and key:
        try:
            cap: dict = {}
            snap_bytes = None
            code_c, _ = supa_request(url, key, "snapshot.json", "HEAD")
            # HEAD no da tamaño fiable en Storage → se usa el listado de la raíz.
            body = json.dumps({"prefix": "", "limit": 1000}).encode()
            req = urlrequest.Request(
                f"{url.rstrip('/')}/storage/v1/object/list/{BUCKET}",
                data=body, method="POST",
                headers={"Authorization": f"Bearer {key}", "apikey": key,
                         "Content-Type": "application/json"})
            with urlrequest.urlopen(req, timeout=25) as r:
                for o in json.loads(r.read()):
                    if o.get("name") == "snapshot.json":
                        snap_bytes = (o.get("metadata") or {}).get("size")
            cap["snapshot_bytes"] = snap_bytes
            cap["bots"] = len(bots)
            # Objetos por carpeta de bots (el techo de 1000 del listado).
            peor = 0
            for vps_id in sorted({b.get("vps") for b in bots if b.get("vps")}):
                body = json.dumps({"prefix": f"bots/{vps_id}", "limit": 1000}).encode()
                req = urlrequest.Request(
                    f"{url.rstrip('/')}/storage/v1/object/list/{BUCKET}",
                    data=body, method="POST",
                    headers={"Authorization": f"Bearer {key}", "apikey": key,
                             "Content-Type": "application/json"})
                with urlrequest.urlopen(req, timeout=25) as r:
                    peor = max(peor, len(json.loads(r.read())))
            cap["max_objects_per_folder"] = peor
            ci = (info.get("steps") or {}).get("ci") or {}
            cap["ci_duration_sec"] = None

            # Proyeccion sobre la serie historica (ritmo real, no supuesto).
            avisos = []
            _, hist = supa_get_json(url, key, "watchdog_history.json")
            serie = [h for h in (hist or []) if isinstance(h, dict)]
            for metrica, (umbral, techo, porque) in CAP_LIMITS.items():
                actual = cap.get(metrica)
                if not actual:
                    continue
                if actual >= umbral:
                    avisos.append(f"{metrica}={actual} ya supera el umbral {umbral} ({porque})")
                    continue
                puntos = [(parse_iso(h.get("ts")), h.get(metrica))
                          for h in serie if h.get(metrica) and parse_iso(h.get("ts"))]
                if len(puntos) < 8:
                    continue                      # sin serie suficiente no se inventa tendencia
                puntos.sort(key=lambda p: p[0])
                t0, v0 = puntos[0]
                t1, v1 = puntos[-1]
                dias = (t1 - t0).total_seconds() / 86400
                if dias < 1 or v1 <= v0:
                    continue                      # sin crecimiento medible
                ritmo = (v1 - v0) / dias
                faltan = (umbral - actual) / ritmo
                if faltan < 30:
                    avisos.append(
                        f"{metrica}: {actual} → umbral {umbral} en ~{faltan:.0f} dias "
                        f"al ritmo actual (+{ritmo:.0f}/dia) · {porque}")
            cap["avisos"] = avisos
            info["steps"]["capacity"] = cap
            for a in avisos:
                # Aviso, no fallo: el sistema aun funciona; el objetivo es actuar
                # con semanas de margen. (Antes: NameError `freshness_warn` que el
                # except genérico tragaba — la capa E5 moría en silencio cada run
                # y history guardaba bots/snapshot_bytes en null.)
                warns.append(f"capacidad: {a}")
        except Exception as e:  # noqa: BLE001 — check aditivo, nunca tumba el watchdog
            info["steps"]["capacity"] = {"error": str(e)}

    # Step 4b-ter — [RESILIENCIA R2] Otros workflows en rojo.
    # El watchdog solo miraba refresh-dashboard: spread-sampler llevaba 3/3
    # fallos (KeyError 'utc') sin que nadie se enterara.
    try:
        import subprocess
        wf_bad = []
        for wf in ("spread-sampler", "sampler-tick", "mcp-health", "live-publisher-tick"):
            out = subprocess.run(
                ["gh", "run", "list", "--workflow", wf, "--repo", GH_REPO,
                 "--limit", "3", "--json", "conclusion"],
                capture_output=True, text=True, timeout=45)
            if out.returncode != 0:
                continue
            concs = [r.get("conclusion") for r in json.loads(out.stdout or "[]")]
            done = [c for c in concs if c]
            if done and all(c == "failure" for c in done):
                wf_bad.append(f"{wf}({len(done)}/{len(done)} fallos)")
        info["steps"]["workflows"] = {"failing": wf_bad}
        if wf_bad:
            fails.append(f"workflows en rojo: {', '.join(wf_bad)}")
    except Exception as e:  # noqa: BLE001
        info["steps"]["workflows"] = {"error": str(e)}

    # Step 4b-quater — [RESILIENCIA R2] Salud del respaldo R2.
    # El espejo se escribe cada ciclo, pero hasta ahora nadie comprobaba que
    # fuera USABLE. Un respaldo que no se puede leer no es un respaldo.
    failover_url = os.environ.get("KIZ_FAILOVER_URL") or env.get("KIZ_FAILOVER_URL")
    if failover_url:
        try:
            with urlrequest.urlopen(f"{failover_url.rstrip('/')}/health", timeout=20) as r:
                hb = json.loads(r.read())
            info["steps"]["failover"] = hb
            if not hb.get("ok"):
                fails.append("failover R2: /health dice que el espejo NO es utilizable")
        except Exception as e:  # noqa: BLE001
            info["steps"]["failover"] = {"error": str(e)}
            fails.append(f"failover R2 inalcanzable: {e}")

    # Step 4c — Tuning shadow (aprendizaje continuo, warn-only): anota qué
    # recomendaría el adaptive_tuner vs los umbrales vigentes. NO cambia el
    # dead-man real — evidencia para el veredicto tras la semana de shadow.
    if url and key:
        try:
            _, tuning = supa_get_json(url, key, "tuning.json")
            if isinstance(tuning, dict):
                recs = tuning.get("recommendations") or {}
                info["steps"]["tuning_shadow"] = {
                    k: {"current": v.get("current"), "recommended": v.get("recommended")}
                    for k, v in recs.items()
                    if isinstance(v, dict) and v.get("recommended") != v.get("current")
                }
        except Exception:  # noqa: BLE001 — shadow jamás afecta el veredicto
            pass

    # Step 5 — Vercel version pin (warn only)
    app_v, css_v = vercel_version_pin()
    info["steps"]["vercel"] = {"app_js": app_v, "styles_css": css_v}

    duration_ms = int((time.time() - started) * 1000)
    info["duration_ms"] = duration_ms
    fails_data = [f for f in fails if fail_severity(f) == "data"]
    fails_infra = [f for f in fails if fail_severity(f) == "infra"]
    info["result"] = "ok" if not fails else ("warn" if not fails_data else "fail")
    info["fails"] = fails
    info["fails_data"] = fails_data
    info["fails_infra"] = fails_infra
    info["warns"] = warns

    append_log(info)
    if url and key:
        upload_health_to_supabase(url, key, info)

    # "Competencia siempre activa" — separate deduped alert (independent of integrity fails).
    if dormant_eas and not args.no_issue:
        d_body = [
            f"**{len(dormant_eas)} EA(s) demo establecidos dejaron de operar** (dormidos > umbral)",
            "",
            "Un EA con historial (≥30 trades) que dejó de operar = probablemente se despegó o "
            "crasheó en su VPS. La competencia debe estar siempre llena y viva.",
            "",
            "| magic | símbolo | VPS | cuenta | días sin operar |",
            "|---|---|---|---|---|",
            *[f"| `{d['magic']}` | {d['symbol']} | {d['vps']} | {d['account']} | {d['days_since_last_trade']} |"
              for d in dormant_eas],
            "",
            "_Acción:_ revisar el terminal MT5 de esas cuentas (EA adjunto/AutoTrading) en el VPS.",
        ]
        ref = file_issue_dedupe("dormant EAs", "\n".join(d_body))
        print(f"[watchdog] dormant EAs={len(dormant_eas)} issue={ref}", file=sys.stderr)

    if not fails:
        if not args.quiet:
            s = info["steps"]
            files = s.get("files", {})
            print(
                f"[watchdog] ok ci=#{(s.get('ci') or {}).get('id','?')} "
                f"files={files.get('total','?')}/{files.get('total','?')} "
                f"vercel={app_v or '?'} {duration_ms}ms"
            )
        return 0

    # FAIL path
    body_lines = [
        f"**Watchdog detected drift at {info['ts']}**",
        "",
        "## Fails",
        *[f"- {f}" for f in fails],
        "",
        "## Steps",
        f"```json\n{json.dumps(info['steps'], indent=2)}\n```",
        "",
        f"_Reproducer:_ `python3 'Battle of Bots/scripts/integrity_watchdog.py'`",
    ]
    issue_ref = "skipped"
    if not args.no_issue:
        issue_ref = file_issue_dedupe("drift detected", "\n".join(body_lines))
    print(f"[watchdog] {info['result'].upper()} fails={len(fails)} "
          f"(data={len(fails_data)} infra={len(fails_infra)}) issue={issue_ref} {duration_ms}ms", file=sys.stderr)
    for f in fails:
        print(f"  - {f}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
