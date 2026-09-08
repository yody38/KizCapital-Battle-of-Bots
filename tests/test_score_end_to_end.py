"""End-to-end: run `scripts/post_merge.py` as a subprocess over the synthetic
data dir (the same way scripts/test_determinism.py invokes it) and pin the
result.

The golden file `tests/golden/scores_v1.json` records the score every archetype
gets today. It is written automatically the first time it is missing, and can
be refreshed on purpose with:

    KIZ_UPDATE_GOLDEN=1 python3 -m pytest tests/test_score_end_to_end.py

Refreshing it is a deliberate act: it means "yes, the engine now prices the
fleet differently, and I have reviewed the diff". Never refresh to make a red
test green.

Tolerance: scores are compared within +/- 0.5 points. The fixture is anchored to
`today`, so `months_active` can be 12 or 13 (4 or 5 for the young archetypes)
depending on the day of the month, which moves `norm_age` by at most 0.2 points.
Any real change to a weight, a cap or a norm moves scores by several points.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

import pytest

import post_merge as pm

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
POST_MERGE = os.path.join(REPO_ROOT, "scripts", "post_merge.py")
GOLDEN_DIR = os.path.join(HERE, "golden")
GOLDEN_PATH = os.path.join(GOLDEN_DIR, "scores_v1.json")

SCORE_TOL = 0.5


def _key(b):
    return f"{b['vps']}-{b['account_login']}-{b['magic']}"


@pytest.fixture(scope="module")
def enriched(synthetic_data_dir, tmp_path_factory):
    """A private copy of the data dir with post_merge.py already run over it.

    Module-scoped: the engine takes a few seconds, and every test here reads the
    SAME run — which is also what makes the golden meaningful.
    """
    root = tmp_path_factory.mktemp("kiz-e2e")
    data_dir = os.path.join(str(root), "data")
    shutil.copytree(synthetic_data_dir, data_dir)

    env = dict(os.environ)
    env["PYTHONHASHSEED"] = "0"          # mirrors the CI workflow guard
    env.pop("GAP_CONTRADICE_ENFORCE", None)
    proc = subprocess.run([sys.executable, POST_MERGE, data_dir],
                          env=env, capture_output=True, text=True, cwd=REPO_ROOT)
    with open(os.path.join(data_dir, "snapshot.json")) as f:
        snap = json.load(f)
    return {"proc": proc, "data_dir": data_dir, "snap": snap,
            "bots": {_key(b): b for b in snap.get("bots", [])}}


# --- the run itself -----------------------------------------------------------

def test_post_merge_succeeds_on_a_complete_synthetic_snapshot(enriched):
    proc = enriched["proc"]
    assert proc.returncode == 0, f"post_merge failed:\n{proc.stdout}\n{proc.stderr}"
    assert "post_merge OK" in proc.stdout


def test_every_bot_is_scored_and_has_a_status(enriched):
    for key, b in enriched["bots"].items():
        assert b.get("promotion_score") is not None, key
        assert b.get("promotion_status") in ("READY", "NEAR", "WATCH", "NO"), key


def test_promotion_meta_is_published(enriched):
    meta = enriched["snap"].get("promotion_meta")
    assert meta, "promotion_meta missing — the UI cannot explain any score"
    for field in ("weights", "caps", "gating", "rank_caps", "trust", "ranker",
                  "human_veto_required", "eligible_count", "pool_post_dedup"):
        assert field in meta, field
    assert meta["weights"] == pm.WEIGHTS
    assert meta["rank_caps"] == pm.STATUS_RANK_CAPS


def test_human_veto_is_always_required(enriched):
    """READY is a PROPOSAL. The charter is read-only: nothing auto-promotes."""
    assert enriched["snap"]["promotion_meta"]["human_veto_required"] is True


def test_seat_caps_are_respected(enriched):
    counts = {}
    for b in enriched["bots"].values():
        counts[b["promotion_status"]] = counts.get(b["promotion_status"], 0) + 1
    assert counts.get("READY", 0) <= 3
    assert counts.get("NEAR", 0) <= 5
    assert counts.get("WATCH", 0) <= 15


def test_no_hard_blocked_bot_holds_a_real_money_seat(enriched):
    """READY/NEAR are real-money proposals: a dormant bot, a clone of something
    already running real, or an SQN=MALO bot must never hold one. (Seat ORDER is
    not asserted: `_diversify` deliberately reorders within a 4-point band to
    avoid seating three bots on the same base symbol.)"""
    hard = {"dormant", "clones_real", "sqn_malo"}
    for key, b in enriched["bots"].items():
        if b["promotion_status"] in ("READY", "NEAR"):
            assert not (set(b.get("trust_fails") or []) & hard), (
                f"{key} holds a {b['promotion_status']} seat with hard fails "
                f"{b.get('trust_fails')}")
            assert "provisional_low_confidence" in b, (
                f"{key} is seated without the provisional flag the UI needs")


# --- who is excluded and why --------------------------------------------------

def test_a_bot_on_a_real_account_never_takes_a_candidate_seat(enriched):
    """The section surfaces demo-only EAs; magics already running real money are
    excluded from the pool by construction."""
    meta = enriched["snap"]["promotion_meta"]
    assert 5009 in meta["real_magics_excluded"]
    real_bot = enriched["bots"]["vps3-900009-5009"]
    assert real_bot["promotion_status"] == "NO"
    assert enriched["snap"]["real_magics"] == [5009]


def test_the_net_negative_archetype_fails_gating(enriched):
    key = "vps1-900001-5007"
    loser = enriched["bots"][key]
    assert loser["promotion_status"] == "NO"
    assert loser["promotion_score"] is not None       # scored, but not seatable
    gating = _gating(enriched, key)
    assert gating is not None and gating["net_profitable"] is False


def test_no_vps_is_carried_forward_so_no_bot_is_frozen(enriched):
    """A carry-forward VPS degrades its bots out of READY/NEAR. The fixture is
    fresh, so this must not trigger — if it does, the freshness fields drifted."""
    for vps, info in enriched["snap"]["vps_freshness"].items():
        assert info.get("present") is True, vps
        assert not info.get("carried_forward"), vps
        assert not info.get("stale"), f"{vps} stale: {info}"
    assert not any(b.get("frozen_data") for b in enriched["bots"].values())


# --- artefacts the frontend consumes ------------------------------------------

def test_correlations_json_is_written_keyed_by_vps_login_magic(enriched):
    """Backend contract: `bots` and `matrix` are OBJECTS keyed by
    '<vps>-<login>-<magic>', never arrays. tests/js/test_correlations_shape.js
    pins the same contract from the frontend side."""
    with open(os.path.join(enriched["data_dir"], "correlations.json")) as f:
        corr = json.load(f)
    assert isinstance(corr["bots"], dict)
    assert isinstance(corr["matrix"], dict)
    for key in corr["bots"]:
        assert key.count("-") == 2 and key.startswith("vps"), key
        assert key in corr["matrix"]
        assert corr["matrix"][key][key] == 1.0


def test_per_bot_detail_files_receive_the_split_fields(enriched):
    """post_merge moves modal-only blocks out of the snapshot and into the
    per-bot files; losing them silently is a known failure mode."""
    key, bot = next(iter(enriched["bots"].items()))
    vps, login, magic = key.split("-")
    path = os.path.join(enriched["data_dir"], "bots", vps, f"{login}-{magic}.json")
    with open(path) as f:
        per = json.load(f)
    assert per["detail"]["_fields"], "detail split produced nothing"
    assert bot["detail_n"] == len(per["detail"]["_fields"])


# --- the golden ---------------------------------------------------------------

def _gating(enriched, key):
    """`promotion_gating` is one of the DETAIL_SPLIT_FIELDS: post_merge moves it
    out of the snapshot and into the per-bot file. Reading it from the snapshot
    yields {} — and `all({}.values())` is True, i.e. "passes everything". Always
    read it from the per-bot detail."""
    vps, login, magic = key.split("-")
    path = os.path.join(enriched["data_dir"], "bots", vps, f"{login}-{magic}.json")
    with open(path) as f:
        detail = json.load(f).get("detail") or {}
    return detail.get("promotion_gating")


def _current(enriched):
    return {
        "score_live_version": getattr(pm, "SCORE_LIVE_VERSION", "v1"),
        "weights": pm.WEIGHTS,
        "bots": {
            key: {
                "archetype": b.get("archetype"),
                "promotion_score": b["promotion_score"],
                "promotion_status": b["promotion_status"],
                "gating_pass": all((_gating(enriched, key) or {}).values()),
            }
            for key, b in sorted(enriched["bots"].items())
        },
    }


def test_scores_match_the_golden_file(enriched):
    current = _current(enriched)

    if os.environ.get("KIZ_UPDATE_GOLDEN") == "1" or not os.path.exists(GOLDEN_PATH):
        os.makedirs(GOLDEN_DIR, exist_ok=True)
        payload = dict(current)
        payload["_readme"] = (
            "Golden promotion scores over tests/fixtures/synth.py. Refresh ONLY "
            "on a reviewed, intentional scoring change: "
            "KIZ_UPDATE_GOLDEN=1 python3 -m pytest tests/test_score_end_to_end.py"
        )
        with open(GOLDEN_PATH, "w") as f:
            json.dump(payload, f, indent=2, sort_keys=True)
            f.write("\n")
        pytest.skip(f"golden written to {GOLDEN_PATH} — rerun to compare against it")

    with open(GOLDEN_PATH) as f:
        golden = json.load(f)

    assert golden["score_live_version"] == current["score_live_version"], (
        "the live score version changed; review the diff, then refresh with "
        "KIZ_UPDATE_GOLDEN=1"
    )
    assert golden["weights"] == current["weights"], (
        "WEIGHTS changed — every score below is repriced. Review, then refresh "
        "with KIZ_UPDATE_GOLDEN=1"
    )
    assert set(golden["bots"]) == set(current["bots"]), "the fixture roster changed"

    drift = []
    for key, want in golden["bots"].items():
        got = current["bots"][key]
        if abs(got["promotion_score"] - want["promotion_score"]) > SCORE_TOL:
            drift.append(f"{key} ({want['archetype']}): "
                         f"{want['promotion_score']} -> {got['promotion_score']}")
        if got["promotion_status"] != want["promotion_status"]:
            drift.append(f"{key} ({want['archetype']}): status "
                         f"{want['promotion_status']} -> {got['promotion_status']}")
        if got["gating_pass"] != want["gating_pass"]:
            drift.append(f"{key} ({want['archetype']}): gating "
                         f"{want['gating_pass']} -> {got['gating_pass']}")
    assert not drift, (
        "the engine now prices the fleet differently:\n  " + "\n  ".join(drift)
        + "\nIf this is intended, refresh with KIZ_UPDATE_GOLDEN=1."
    )
