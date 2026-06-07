#!/usr/bin/env python3
"""
Upload Battle of Bots data/ folder to Supabase Storage (bucket: dashboard-data).
Runs after mirror.sh on the Mac. Idempotent — safe to re-run.

Reads credentials from Battle of Bots/.env.local:
  SUPABASE_URL=https://xxxxx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=eyJ...     # required; bypasses RLS for uploads

Uploads only files that changed (sha256 manifest cached at data/.upload-manifest.json).
Mirrors directory structure exactly (data/snapshot.json -> snapshot.json in bucket,
data/bots/vps1/123-456.json -> bots/vps1/123-456.json, etc.).
"""
from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import socket
import ssl
import sys
import time
from pathlib import Path
from urllib import error as urlerror
from urllib import parse as urlparse
from urllib import request as urlrequest

ROOT = Path(__file__).resolve().parent.parent  # .../battle-of-bots
DATA_DIR = ROOT / "data"
ENV_FILE = ROOT / ".env.local"
MANIFEST_FILE = DATA_DIR / ".upload-manifest.json"
REPORT_FILE = DATA_DIR / "integrity_report.json"
UPLOAD_HEALTH_FILE = DATA_DIR / "upload_health.json"
BUCKET = "dashboard-data"
STUCK_TRIES = 3  # tries >= this => surfaced as UPLOAD_STUCK (actionable signal)

# Explicit CA bundle: certifi if available (no-regret), else system default.
# The CERTIFICATE_VERIFY_FAILED upload failures (2026-06-07) motivated this.
try:
    import certifi  # type: ignore

    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
    _SSL_CTX_SRC = "certifi"
except Exception:  # noqa: BLE001
    _SSL_CTX = ssl.create_default_context()
    _SSL_CTX_SRC = "system"

# Transient/connection-level errors worth retrying. HTTPError (a URLError
# subclass) is deliberately NOT here — an HTTP status is not transient.
_RETRYABLE = (ssl.SSLError, socket.timeout, TimeoutError, ConnectionError)


def classify_exc(exc: BaseException) -> str:
    """Compact root-cause label for instrumentation (e.g. 'URLError:SSLCertVerificationError')."""
    parts = [type(exc).__name__]
    reason = getattr(exc, "reason", None)
    if reason is not None:
        parts.append(reason[:30] if isinstance(reason, str) else type(reason).__name__)
    code = getattr(exc, "code", None)
    if code is not None:
        parts.append(f"http{code}")
    return ":".join(str(p) for p in parts)


def urlopen_retry(req, timeout: int, tries: int = 3):
    """urlopen with explicit SSL context + backoff on transient errors only."""
    last: BaseException | None = None
    for attempt in range(tries):
        try:
            return urlrequest.urlopen(req, timeout=timeout, context=_SSL_CTX)
        except urlerror.HTTPError:
            raise  # HTTP status errors are not transient
        except urlerror.URLError as exc:
            # URLError wraps the real cause in .reason; retry only if transient.
            last = exc
            if not isinstance(getattr(exc, "reason", None), _RETRYABLE):
                raise
        except _RETRYABLE as exc:
            last = exc
        if attempt < tries - 1:
            time.sleep(1.5 * (attempt + 1))
    assert last is not None
    raise last

# Files we never upload (local-only or sensitive)
SKIP_NAMES = {
    ".DS_Store",
    "server.stdout.log",
    "server.stderr.log",
    ".upload-manifest.json",
}
SKIP_SUFFIXES = (".log", ".tmp")


# ----------------------- env -----------------------

def load_env() -> dict[str, str]:
    if not ENV_FILE.exists():
        die(f"missing {ENV_FILE}")
    env: dict[str, str] = {}
    for raw in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def die(msg: str, code: int = 1) -> None:
    print(f"[upload] FATAL: {msg}", file=sys.stderr)
    sys.exit(code)


# ----------------------- manifest -----------------------

def load_manifest() -> dict[str, str]:
    if not MANIFEST_FILE.exists():
        return {}
    try:
        return json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_manifest(manifest: dict[str, str]) -> None:
    MANIFEST_FILE.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(64 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


# ----------------------- supabase HTTP -----------------------

class Uploader:
    def __init__(self, url: str, service_key: str) -> None:
        self.base = url.rstrip("/")
        self.key = service_key

    def _headers(self, content_type: str | None = None) -> dict[str, str]:
        h = {
            "Authorization": f"Bearer {self.key}",
            "apikey": self.key,
        }
        if content_type:
            h["Content-Type"] = content_type
        return h

    def upload(self, object_path: str, file_path: Path) -> None:
        """PUT to /storage/v1/object/<bucket>/<path>?upsert=true"""
        mime, _ = mimetypes.guess_type(file_path.name)
        if not mime:
            mime = "application/octet-stream"
        encoded = "/".join(urlparse.quote(p, safe="") for p in object_path.split("/"))
        endpoint = f"{self.base}/storage/v1/object/{BUCKET}/{encoded}"
        headers = self._headers(mime)
        headers["x-upsert"] = "true"
        headers["cache-control"] = "no-cache, max-age=0"
        with file_path.open("rb") as f:
            body = f.read()
        req = urlrequest.Request(endpoint, data=body, headers=headers, method="POST")
        try:
            with urlopen_retry(req, timeout=60) as resp:
                if resp.status >= 300:
                    raise RuntimeError(f"http {resp.status}")
        except urlerror.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:200]
            raise RuntimeError(f"http {exc.code}: {detail}") from None

    def list_prefix(self, prefix: str) -> set[str]:
        """Return the set of object names under a folder prefix (one folder at a time)."""
        endpoint = f"{self.base}/storage/v1/object/list/{BUCKET}"
        body = json.dumps({"prefix": prefix, "limit": 1000}).encode()
        headers = self._headers("application/json")
        req = urlrequest.Request(endpoint, data=body, headers=headers, method="POST")
        with urlopen_retry(req, timeout=30) as resp:
            data = json.loads(resp.read())
        return {o["name"] for o in data if o.get("name")}


# ----------------------- main -----------------------

def should_skip(path: Path) -> bool:
    if path.name in SKIP_NAMES:
        return True
    if any(path.name.endswith(s) for s in SKIP_SUFFIXES):
        return True
    return False


def iter_data_files() -> list[tuple[Path, str]]:
    """Yield (absolute_path, object_path_in_bucket)."""
    if not DATA_DIR.exists():
        die(f"missing {DATA_DIR}")
    out: list[tuple[Path, str]] = []
    for p in DATA_DIR.rglob("*"):
        if p.is_dir() or should_skip(p):
            continue
        rel = p.relative_to(DATA_DIR).as_posix()
        out.append((p, rel))
    return out


def main() -> int:
    env = load_env()
    url = env.get("SUPABASE_URL")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        die("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local")

    uploader = Uploader(url, key)
    manifest = load_manifest()
    new_manifest: dict[str, str] = {}
    files = iter_data_files()

    started = time.time()
    uploaded = 0
    skipped = 0
    failed: list[str] = []
    fail_by_class: dict[str, int] = {}  # instrumentation: real root cause by exc class

    def record_fail(stage: str, obj_path: str, exc: BaseException) -> None:
        cls = classify_exc(exc)
        fail_by_class[cls] = fail_by_class.get(cls, 0) + 1
        failed.append(f"{stage}{obj_path}: {exc} [{cls}]")

    def manifest_get(p: str) -> str | None:
        """Manifest values can be a raw sha (old format) or a dict (new format)."""
        v = manifest.get(p)
        if isinstance(v, dict):
            return v.get("hash")
        return v

    def mark_pending(obj_path: str) -> None:
        """Mark as pending-retry so the next run treats it as changed and re-uploads.
        Tracks retry count to surface persistent failures."""
        prev = manifest.get(obj_path)
        tries = (prev.get("tries", 0) + 1) if isinstance(prev, dict) else 1
        new_manifest[obj_path] = {"hash": "pending-retry", "tries": tries}

    print(f"[upload] {len(files)} files in data/")
    for abs_path, obj_path in files:
        digest = file_sha256(abs_path)
        new_manifest[obj_path] = digest
        if manifest_get(obj_path) == digest:
            skipped += 1
            continue
        try:
            uploader.upload(obj_path, abs_path)
            uploaded += 1
            if uploaded % 25 == 0:
                print(f"[upload]   {uploaded} uploaded...")
        except Exception as exc:  # noqa: BLE001
            record_fail("", obj_path, exc)
            mark_pending(obj_path)  # force retry next run; do NOT drop silently

    # ------------------------------------------------------------------
    # Audit: list every folder used + verify nothing is silently missing.
    # Silent failures DID happen once (HTTP 200 but object never landed),
    # so we always close the loop and re-upload any drift.
    # ------------------------------------------------------------------
    folders: set[str] = {""}
    for _, obj_path in files:
        if "/" in obj_path:
            folders.add(obj_path.rsplit("/", 1)[0])

    storage_paths: set[str] = set()
    for folder in folders:
        try:
            names = uploader.list_prefix(folder)
        except Exception as exc:  # noqa: BLE001
            cls = classify_exc(exc)
            fail_by_class[cls] = fail_by_class.get(cls, 0) + 1
            print(f"[upload]   audit list FAILED for '{folder}': {exc} [{cls}]", file=sys.stderr)
            names = set()
        if folder:
            storage_paths.update(f"{folder}/{n}" for n in names)
        else:
            storage_paths.update(names)

    local_paths = {obj for _, obj in files}
    missing_in_storage = local_paths - storage_paths
    audit_resubmit = 0
    for obj_path in sorted(missing_in_storage):
        abs_path = next((p for p, op in files if op == obj_path), None)
        if not abs_path:
            continue
        try:
            uploader.upload(obj_path, abs_path)
            new_manifest[obj_path] = file_sha256(abs_path)
            audit_resubmit += 1
        except Exception as exc:  # noqa: BLE001
            record_fail("audit:", obj_path, exc)
            mark_pending(obj_path)  # force retry next run

    save_manifest(new_manifest)
    dur = time.time() - started

    # ------------------------------------------------------------------
    # Actionable signal: files whose retry counter crossed STUCK_TRIES are
    # draining cycle-after-cycle in silence. Surface them so the watchdog
    # raises a deduped Issue, and re-upload the status THIS cycle so the
    # live dashboard reflects it synchronously (not 10-40min later).
    # ------------------------------------------------------------------
    stuck = [
        {"path": p, "tries": v.get("tries", 0)}
        for p, v in new_manifest.items()
        if isinstance(v, dict) and v.get("hash") == "pending-retry"
        and v.get("tries", 0) >= STUCK_TRIES
    ]
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    upload_status = {
        "generated_at": now_iso,
        "ok": (len(failed) == 0 and not stuck),
        "ssl_ctx": _SSL_CTX_SRC,
        "uploaded": uploaded,
        "unchanged": skipped,
        "audit_resubmit": audit_resubmit,
        "failed": len(failed),
        "fail_by_class": fail_by_class,
        "stuck_count": len(stuck),
        "stuck_files": stuck[:50],
        "duration_sec": round(dur, 1),
    }

    # Own health file (read by watchdog next cycle as redundancy).
    try:
        UPLOAD_HEALTH_FILE.write_text(json.dumps(upload_status, indent=2), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        print(f"[upload]   could not write upload_health.json: {exc}", file=sys.stderr)

    # Patch integrity_report.json (verify_integrity ran BEFORE upload, so it
    # can't carry upload state on its own) and re-upload only the two status
    # files so the deployed dashboard sees them within the same cycle.
    try:
        if REPORT_FILE.exists():
            rep = json.loads(REPORT_FILE.read_text(encoding="utf-8"))
            rep["upload"] = upload_status
            REPORT_FILE.write_text(json.dumps(rep, indent=2), encoding="utf-8")
            for status_obj in ("integrity_report.json", "upload_health.json"):
                sp = DATA_DIR / status_obj
                if sp.exists():
                    try:
                        uploader.upload(status_obj, sp)
                    except Exception as exc:  # noqa: BLE001
                        cls = classify_exc(exc)
                        print(f"[upload]   status re-upload FAILED {status_obj}: {exc} [{cls}]", file=sys.stderr)
    except Exception as exc:  # noqa: BLE001
        print(f"[upload]   could not patch integrity_report.json: {exc}", file=sys.stderr)

    print(
        f"[upload] done in {dur:.1f}s  uploaded={uploaded}  unchanged={skipped}  "
        f"audit_resubmit={audit_resubmit}  failed={len(failed)}  stuck={len(stuck)}  ssl={_SSL_CTX_SRC}"
    )
    if fail_by_class:
        print(f"[upload]   fail_by_class={json.dumps(fail_by_class, sort_keys=True)}", file=sys.stderr)
    if stuck:
        print(f"[upload]   UPLOAD_STUCK: {len(stuck)} file(s) failed >={STUCK_TRIES}x", file=sys.stderr)
        for s in stuck[:10]:
            print(f"[upload]   STUCK {s['path']} (tries={s['tries']})", file=sys.stderr)
    if failed:
        for line in failed[:10]:
            print(f"[upload]   FAIL {line}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
