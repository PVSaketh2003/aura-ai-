"""Local Mac Agent security: path authorization is enforced on the Mac side."""
import json
import os

import pytest

from local_agent.config import AgentConfig, Root
from local_agent.file_access.guard import AccessDenied, resolve
from local_agent.file_search.search import find_directory, list_pdfs, search_files

PDF = b"%PDF-1.4\n%test\n"


@pytest.fixture
def tree(tmp_path):
    docs = tmp_path / "Documents"
    (docs / "Research").mkdir(parents=True)
    (docs / ".secret").mkdir()
    (docs / "Machine Learning Notes.pdf").write_bytes(PDF)
    (docs / "Research" / "Vision Transformers.pdf").write_bytes(PDF)
    (docs / ".secret" / "hidden.pdf").write_bytes(PDF)
    (docs / "fake.pdf").write_bytes(b"MZ not a pdf")
    (docs / "notes.txt").write_text("x")
    outside = tmp_path / "Private"
    outside.mkdir()
    (outside / "tax.pdf").write_bytes(PDF)
    os.symlink(outside / "tax.pdf", docs / "link.pdf")
    cfg = AgentConfig("http://x", "t", [Root("Documents", docs.resolve())], max_file_bytes=10_000)
    return cfg, tmp_path


def test_reads_authorized_pdf(tree):
    cfg, _ = tree
    p, root = resolve(cfg, "Documents/Machine Learning Notes.pdf", must_be_file=True)
    assert p.name == "Machine Learning Notes.pdf" and root.name == "Documents"


@pytest.mark.parametrize("path,msg", [
    ("Documents/../Private/tax.pdf", "outside"),
    ("Documents/link.pdf", "outside"),               # symlink escaping the root
    ("Private/tax.pdf", "not an authorized"),
    ("Documents/.secret/hidden.pdf", "Hidden"),
    ("Documents/fake.pdf", "valid PDF"),
    ("Documents/notes.txt", "only PDF"),
    ("/etc/passwd", "outside"),
    ("Documents/missing.pdf", "does not exist"),
])
def test_rejects_unsafe_paths(tree, path, msg):
    cfg, tmp = tree
    if path.startswith("Documents/../"):
        path = str(cfg.roots[0].path) + "/../Private/tax.pdf"
    with pytest.raises(AccessDenied, match=msg):
        resolve(cfg, path, must_be_file=True)


def test_size_limit(tree):
    cfg, _ = tree
    big = cfg.roots[0].path / "big.pdf"
    big.write_bytes(PDF + b"0" * 20_000)
    with pytest.raises(AccessDenied, match="limit"):
        resolve(cfg, "Documents/big.pdf", must_be_file=True)


def test_disabled_root_is_inaccessible(tree):
    cfg, _ = tree
    cfg.disabled = {"Documents"}
    with pytest.raises(AccessDenied):
        resolve(cfg, "Documents/Machine Learning Notes.pdf", must_be_file=True)


def test_search_and_list(tree):
    cfg, _ = tree
    hits = search_files(cfg, "machine learning notes")["results"]
    assert hits[0]["name"] == "Machine Learning Notes.pdf" and hits[0]["score"] >= 0.75
    assert all(".secret" not in h["path"] for h in search_files(cfg, "hidden")["results"])
    d = find_directory(cfg, "research")["results"][0]
    assert d["display"] == "Documents/Research"
    assert [f["name"] for f in list_pdfs(cfg, cfg.roots[0].path / "Research")["results"]] == ["Vision Transformers.pdf"]


def test_agent_rejects_unknown_operations(tree):
    import asyncio

    from local_agent.background_service.service import Agent
    cfg, _ = tree
    sent = []

    class WS:
        async def send(self, m): sent.append(json.loads(m))

    asyncio.run(Agent(cfg).handle(WS(), {"id": "1", "op": "exec", "args": {"cmd": "rm -rf ~"}}))
    assert sent[0]["ok"] is False and "not supported" in sent[0]["error"]
