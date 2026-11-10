"""Automatic chunking.

Strategy selection:
  - SemanticChunker for short, clean prose documents (topic boundaries matter more than size and the
    per-sentence embedding cost is acceptable).
  - RecursiveCharacterTextSplitter otherwise (large, OCR-heavy or table-heavy documents).
Tables are never split mid-row: each table becomes its own chunk (header repeated if it must be split).
Every chunk records its first/last page via character offsets into the page-concatenated text.
The exact configuration is returned so re-indexing is reproducible.
"""
from __future__ import annotations

import bisect
from dataclasses import dataclass

from langchain_text_splitters import RecursiveCharacterTextSplitter

from services.document_loaders.loaders import PageBlock

RECURSIVE = {"strategy": "recursive", "chunk_size": 1200, "chunk_overlap": 180,
             "separators": ["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " ", ""]}
SEMANTIC = {"strategy": "semantic", "breakpoint_threshold_type": "percentile", "breakpoint_threshold_amount": 90,
            "max_chunk_chars": 2000, "min_chunk_chars": 200}
SEMANTIC_MAX_CHARS = 40_000
TABLE_MAX_CHARS = 2400


@dataclass
class ChunkOut:
    text: str
    page: int
    page_end: int
    kind: str


def choose_strategy(blocks: list[PageBlock], forced: str | None = None) -> dict:
    if forced == "recursive":
        return dict(RECURSIVE, reason="re-index with stored configuration")
    if forced == "semantic":
        return dict(SEMANTIC, reason="re-index with stored configuration")
    text_chars = sum(len(b.text) for b in blocks if b.kind == "text")
    ocr_chars = sum(len(b.text) for b in blocks if b.kind == "ocr")
    if 0 < text_chars <= SEMANTIC_MAX_CHARS and ocr_chars < text_chars * 0.2:
        return dict(SEMANTIC, reason=f"short prose document ({text_chars:,} chars) — split on topic shifts")
    why = "OCR text" if ocr_chars > text_chars else f"{text_chars + ocr_chars:,} chars"
    return dict(RECURSIVE, reason=f"recursive splitting suits this document ({why})")


def _split_table(t: PageBlock) -> list[ChunkOut]:
    if len(t.text) <= TABLE_MAX_CHARS:
        return [ChunkOut(t.text, t.page, t.page, "table")]
    lines = t.text.split("\n")
    header, rows = lines[:2], lines[2:]
    out, cur = [], []
    for r in rows:
        if sum(len(x) for x in header + cur) + len(r) > TABLE_MAX_CHARS and cur:
            out.append(ChunkOut("\n".join(header + cur), t.page, t.page, "table"))
            cur = []
        cur.append(r)
    if cur:
        out.append(ChunkOut("\n".join(header + cur), t.page, t.page, "table"))
    return out


def chunk_blocks(blocks: list[PageBlock], embeddings=None, forced: str | None = None) -> tuple[list[ChunkOut], dict]:
    config = choose_strategy(blocks, forced)
    tables = [b for b in blocks if b.kind == "table"]
    prose = sorted([b for b in blocks if b.kind != "table" and b.text.strip()], key=lambda b: b.page)

    # Concatenate pages, remembering where each page starts.
    starts, parts, pages, pos = [], [], [], 0
    for b in prose:
        starts.append(pos)
        pages.append(b.page)
        parts.append(b.text)
        pos += len(b.text) + 2
    full = "\n\n".join(parts)
    page_at = lambda off: pages[max(0, bisect.bisect_right(starts, off) - 1)] if pages else 1  # noqa: E731
    kind_of = {b.page: b.kind for b in prose}

    pieces: list[tuple[str, int]] = []
    if full.strip():
        if config["strategy"] == "semantic" and embeddings is not None:
            from langchain_experimental.text_splitter import SemanticChunker
            sem = SemanticChunker(embeddings, breakpoint_threshold_type=config["breakpoint_threshold_type"],
                                  breakpoint_threshold_amount=config["breakpoint_threshold_amount"],
                                  min_chunk_size=config["min_chunk_chars"])
            guard = RecursiveCharacterTextSplitter(chunk_size=config["max_chunk_chars"], chunk_overlap=150)
            cursor = 0
            for chunk in sem.split_text(full):
                for sub in (guard.split_text(chunk) if len(chunk) > config["max_chunk_chars"] else [chunk]):
                    at = full.find(sub[:80], cursor)
                    at = cursor if at == -1 else at
                    pieces.append((sub, at))
                    cursor = at + max(1, len(sub) // 2)
        else:
            if config["strategy"] == "semantic":  # embeddings unavailable → deterministic fallback
                config = dict(RECURSIVE, reason="semantic chunking unavailable; recursive fallback")
            splitter = RecursiveCharacterTextSplitter(chunk_size=config["chunk_size"], chunk_overlap=config["chunk_overlap"],
                                                      separators=config["separators"], add_start_index=True)
            pieces = [(d.page_content, d.metadata["start_index"]) for d in splitter.create_documents([full])]

    chunks = [ChunkOut(t, page_at(off), page_at(off + len(t) - 1), kind_of.get(page_at(off), "text"))
              for t, off in pieces if t.strip()]
    for t in tables:
        chunks.extend(_split_table(t))
    chunks.sort(key=lambda c: (c.page, c.kind == "table"))
    config["chunks"] = len(chunks)
    config["tables"] = len(tables)
    return chunks, config
