"""Offline evaluation metrics for the RAG agent (run with `python -m evaluation.run <dataset.jsonl>`).

Dataset rows: {"question", "user", "relevant_chunks": [chunk ids], "reference_answer"?, "audio"?, "transcript"?}
"""
from __future__ import annotations

import re


def precision_recall_at_k(retrieved: list[str], relevant: list[str], k: int) -> tuple[float, float]:
    top = retrieved[:k]
    hits = len(set(top) & set(relevant))
    return (hits / len(top) if top else 0.0), (hits / len(relevant) if relevant else 0.0)


def citation_correctness(cited_ids: list[str], evidence: dict[str, dict], relevant_chunks: set[str]) -> float:
    """Share of cited document sources that point to a chunk labelled relevant."""
    docs = [evidence[c] for c in cited_ids if c in evidence and evidence[c]["kind"] == "document"]
    if not docs:
        return 1.0 if not relevant_chunks else 0.0
    return sum(1 for e in docs if e.get("chunk_id") in relevant_chunks) / len(docs)


def word_error_rate(reference: str, hypothesis: str) -> float:
    r, h = re.findall(r"\w+", reference.lower()), re.findall(r"\w+", hypothesis.lower())
    d = [[0] * (len(h) + 1) for _ in range(len(r) + 1)]
    for i in range(len(r) + 1):
        d[i][0] = i
    for j in range(len(h) + 1):
        d[0][j] = j
    for i in range(1, len(r) + 1):
        for j in range(1, len(h) + 1):
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] != h[j - 1]))
    return d[len(r)][len(h)] / max(1, len(r))


JUDGE_PROMPT = """Rate the ANSWER against the SOURCES and QUESTION. Return JSON with:
faithfulness (0-1): fraction of claims supported by the sources; relevance (0-1): how well it answers the question."""
