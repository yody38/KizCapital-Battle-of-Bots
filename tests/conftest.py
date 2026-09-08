"""Shared fixtures. Puts scripts/ and tests/ on sys.path and builds the
synthetic data tree exactly once per session (generating ~1.5k trades and their
daily series is the slow part; every test that mutates gets a cheap copy).
"""
from __future__ import annotations

import os
import shutil
import sys

import pytest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(TESTS_DIR)
SCRIPTS_DIR = os.path.join(REPO_ROOT, "scripts")

# pytest.ini already sets pythonpath=scripts, but conftest must work when the
# suite is invoked from another rootdir too (e.g. `pytest tests/` in CI).
for p in (SCRIPTS_DIR, TESTS_DIR):
    if p not in sys.path:
        sys.path.insert(0, p)

from fixtures.synth import build_data_dir  # noqa: E402


@pytest.fixture(scope="session")
def synthetic_data_dir(tmp_path_factory):
    """A pristine, complete `data/` tree. Read-only: never mutate it in a test —
    use `fresh_data_dir` for anything that writes."""
    root = tmp_path_factory.mktemp("kiz-synth")
    return build_data_dir(root)


@pytest.fixture
def fresh_data_dir(synthetic_data_dir, tmp_path):
    """A private, writable copy of the synthetic data tree.

    Returned as `<tmp_path>/run/data` so that post_merge.py's
    `write_sync_status_md()` (which writes to `<data_dir>/../SYNC_STATUS.md`)
    lands inside the tmp dir and never touches the repo.
    """
    dest_root = os.path.join(str(tmp_path), "run")
    os.makedirs(dest_root, exist_ok=True)
    dest = os.path.join(dest_root, "data")
    shutil.copytree(synthetic_data_dir, dest)
    return dest
