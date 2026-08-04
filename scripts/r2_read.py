#!/usr/bin/env python3
"""r2_read.py — lectura de objetos desde el espejo Cloudflare R2 para el CI.

[EGRESS 2026-08-04] El egress del plan de Supabase se agotó (exceed_egress_quota)
y restringió el proyecto entero; uno de los mayores consumidores era el propio CI
bajando ledgers/snapshots de Storage cada 15 min. R2 tiene egress gratis y ya
recibe dual-write verificado cada ciclo (upload_to_supabase.py, parity_ok), así
que los lectores del pipeline pueden hidratarse del espejo.

Kill-switch: env CI_READ_SOURCE = "supabase" (default) | "r2".
  - supabase: comportamiento histórico. Los llamadores pueden además hacer una
    comparación shadow contra R2 (log-only, nunca afecta el resultado) para
    validar paridad antes del flip.
  - r2: R2 primero; ante CUALQUIER fallo de R2 —incluido 404— se cae a
    Supabase. Un 404 de R2 nunca es autoritativo: el espejo puede ir por detrás
    del bucket, y tratarlo como "primer run" clobbearía la historia publicada.

Mismas env vars que el dual-write: R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY /
R2_ACCOUNT_ID [/ R2_BUCKET, default bob-failover]. Las claves de objeto son
idénticas a las del bucket dashboard-data de Supabase.
"""
from __future__ import annotations

import hashlib
import os
import sys

_client = None
_bucket = None


def read_source() -> str:
    src = os.environ.get("CI_READ_SOURCE", "supabase").strip().lower()
    return src if src in ("supabase", "r2") else "supabase"


def _r2():
    """(client, bucket) o (None, None) si no hay credenciales/boto3. Cacheado."""
    global _client, _bucket
    if _client is not None:
        return _client, _bucket
    ak = os.environ.get("R2_ACCESS_KEY_ID")
    sk = os.environ.get("R2_SECRET_ACCESS_KEY")
    acct = os.environ.get("R2_ACCOUNT_ID")
    bucket = os.environ.get("R2_BUCKET", "bob-failover")
    if not (ak and sk and acct):
        return None, None
    try:
        import boto3  # instalado por el workflow; ausente en local es válido
    except ImportError:
        return None, None
    _client = boto3.client(
        "s3",
        endpoint_url=f"https://{acct}.r2.cloudflarestorage.com",
        aws_access_key_id=ak,
        aws_secret_access_key=sk,
        region_name="auto",
    )
    _bucket = bucket
    return _client, _bucket


def r2_get_bytes(obj_path: str) -> bytes:
    """Baja un objeto del espejo. Lanza excepción ante cualquier fallo
    (sin credenciales, sin boto3, 404, red) — el llamador decide el fallback."""
    client, bucket = _r2()
    if client is None:
        raise RuntimeError("R2 no configurado (credenciales o boto3 ausentes)")
    return client.get_object(Bucket=bucket, Key=obj_path)["Body"].read()


def shadow_compare(obj_path: str, supabase_body: bytes, log_prefix: str) -> None:
    """Modo shadow (log-only): compara sha256 del objeto en R2 contra lo que se
    acaba de leer de Supabase. Nunca lanza ni altera el resultado del ciclo."""
    try:
        r2_body = r2_get_bytes(obj_path)
    except Exception as exc:  # noqa: BLE001
        print(f"{log_prefix} shadow r2 {obj_path}: ERROR {exc}", file=sys.stderr)
        return
    sup_sha = hashlib.sha256(supabase_body).hexdigest()[:12]
    r2_sha = hashlib.sha256(r2_body).hexdigest()[:12]
    verdict = "ok, sha coincide" if sup_sha == r2_sha else f"MISMATCH supabase={sup_sha} r2={r2_sha}"
    print(f"{log_prefix} shadow r2 {obj_path}: {verdict}")
