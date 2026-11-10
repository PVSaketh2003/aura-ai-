"""PDF-first retrieval decision: does the evidence from the user's documents answer the question fully, partly, or
not at all? Wikipedia is consulted only for "partial" (to fill the gap) and "none".

Signals (similarity alone never decides that the PDF answers):
  * semantic similarity of the best passages (top score, how many clear the calibrated threshold)
  * key-term coverage: the question's content words / entities found in the retrieved passages
  * an LLM relevance judge (answers / partially answers / does not answer + what is missing) — skipped only when
    similarity is strong AND coverage is high, i.e. when the outcome is not in doubt
  * agreement: how many passages support the answer

Coverage is deliberately NOT a veto on its own: "the mechanism through which a neural network learns" shares few words
with passages about backpropagation and gradient descent, so low coverage with strong similarity goes to the judge,
which reads meaning, instead of being declared missing.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Literal

from config.env import get_settings

Verdict = Literal["answered", "partial", "none"]

# Route labels shown in the trace (and stored on the answer).
ROUTES = {
    "answered": "PDF SEARCH → PDF ANSWER FOUND",
    "partial": "PDF SEARCH → PARTIAL ANSWER → WIKIPEDIA SUPPLEMENT",
    "none": "PDF SEARCH → INSUFFICIENT EVIDENCE → WIKIPEDIA SEARCH",
    "none_none": "PDF SEARCH → NO EVIDENCE → WIKIPEDIA INSUFFICIENT",
    "no_documents": "NO DOCUMENTS INDEXED → WIKIPEDIA SEARCH",
}

_STOP = set("""a an the of in on at to for from by with about into over under and or but not no is are was were be been being
do does did can could should would will shall may might must have has had what which who whom whose when where why how
this that these those it its it's i me my we our you your he she they them their there here than then so such as if
explain tell describe give show please define meaning mean means detail details information info about example examples
use used using work works working way ways also just some any each other more most much many very really""".split())


def key_terms(text: str) -> list[str]:
    """Content words and entities of a (English) query: acronyms/capitalised words always kept, stop-words dropped."""
    words = re.findall(r"[A-Za-z][A-Za-z0-9+#.-]*", text)
    out = []
    for w in words:
        lw = w.lower().strip(".-")
        if len(lw) < 3 and not w.isupper():
            continue
        if lw in _STOP:
            continue
        out.append(lw)
    return list(dict.fromkeys(out))


def coverage(terms: list[str], passages: list[str]) -> tuple[float, list[str], list[str]]:
    """Share of key terms present in the passages (prefix match handles plurals/inflections: 'networks', 'learning')."""
    if not terms:
        return 1.0, [], []
    blob = " ".join(passages).lower()
    words = set(re.findall(r"[a-z0-9+#]+", blob))
    found, missing = [], []
    for t in terms:
        stem = t[:5] if len(t) > 5 else t
        (found if (t in blob if (" " in t or not t.isalpha()) else any(w.startswith(stem) for w in words)) else missing).append(t)
    return len(found) / len(terms), found, missing


@dataclass
class Assessment:
    verdict: Verdict
    route: str
    top_similarity: float | None
    above_threshold: int
    threshold: float
    strong: float
    coverage: float
    covered_terms: list[str]
    missing_terms: list[str]
    judge: str | None = None  # answers | partially_answers | does_not_answer | None (skipped / unavailable)
    judge_missing: str = ""
    supporting: list[str] = field(default_factory=list)  # passage ids that carry the answer
    reasons: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return asdict(self)


def assess(question_for_terms: str, evidence: list, *, threshold: float, strong: float, judge_fn=None,
           judge_question: str | None = None) -> Assessment:
    """evidence: retrieval Evidence objects (id, text, similarity). judge_fn(question, evidence) -> Judgement."""
    s = get_settings()
    cov_min = s.evidence_coverage_min
    sims = sorted([e.similarity for e in evidence if e.similarity is not None], reverse=True)
    top = sims[0] if sims else None
    above = [e.id for e in evidence if e.similarity is not None and e.similarity >= threshold]
    terms = key_terms(question_for_terms)
    cov, found, missing = coverage(terms, [e.text for e in evidence if e.id in above] or [e.text for e in evidence])
    a = Assessment("none", ROUTES["none"], round(top, 3) if top is not None else None, len(above), threshold, strong,
                   round(cov, 2), found, missing)
    if not evidence:
        a.reasons.append("no passages retrieved")
        return a
    if top is None or top < threshold:
        a.reasons.append(f"best similarity {top:.2f} is below the threshold {threshold:.2f}" if top is not None else "no scores")
        return a
    if top >= strong and cov >= cov_min and not _uncovered_aspect(question_for_terms, missing):
        a.verdict, a.route, a.supporting = "answered", ROUTES["answered"], above
        a.reasons.append(f"strong similarity {top:.2f} ≥ {strong:.2f} and {cov:.0%} of the key terms are covered — judge not needed")
        return a
    # In doubt: let the judge read the passages for meaning.
    if judge_fn is None:
        a.verdict = "partial" if top >= strong else "none"
        a.route = ROUTES[a.verdict]
        a.reasons.append("no relevance judge available; decided on similarity + coverage")
        return a
    try:
        j = judge_fn(judge_question or question_for_terms, evidence)
    except Exception as e:  # judge unavailable → conservative similarity/coverage decision
        a.verdict = "answered" if (top >= strong and cov >= cov_min) else "partial" if top >= strong or cov >= cov_min else "none"
        a.route = ROUTES[a.verdict]
        a.supporting = above if a.verdict != "none" else []
        a.reasons.append(f"relevance judge unavailable ({type(e).__name__}); decided on similarity + coverage")
        return a
    a.judge, a.judge_missing = j.verdict, (getattr(j, "missing", "") or "").strip()
    a.supporting = [i for i in j.relevant_ids if i in {e.id for e in evidence}] or above
    if j.verdict == "answers":
        a.verdict = "answered"
        a.reasons.append("the judge found the answer in the passages" + (f" (similarity {top:.2f}, coverage {cov:.0%})"))
    elif j.verdict == "partially_answers":
        a.verdict = "partial"
        a.reasons.append("the passages answer only part of the question" + (f": missing {a.judge_missing}" if a.judge_missing else ""))
    else:
        a.verdict, a.supporting = "none", []
        a.reasons.append("the judge found the passages do not answer the question")
    a.route = ROUTES[a.verdict]
    return a


_MULTI = re.compile(r"\b(and|also|as well as|plus|along with|who|when|where)\b|,|\?.+\?", re.I)


def _uncovered_aspect(question: str, missing: list[str]) -> bool:
    """An uncovered term matters when the question has several parts ("…and who invented it") or the term is an
    entity/number (names, acronyms, years): then the judge must check instead of similarity deciding."""
    if not missing:
        return False
    if _MULTI.search(question):
        return True
    raw = re.findall(r"[A-Za-z0-9][A-Za-z0-9+#.-]*", question)
    ents = {w.lower() for w in raw if w.isupper() or w[0].isupper() and raw.index(w) > 0 or any(c.isdigit() for c in w)}
    return any(m in ents for m in missing)


def supplement_query(english_question: str, a: Assessment) -> str:
    """For a partial answer, Wikipedia is asked only for what is missing (falls back to the whole question)."""
    if a.judge_missing and len(a.judge_missing.split()) <= 14:
        return a.judge_missing
    if a.missing_terms and len(a.missing_terms) < len(a.covered_terms) + len(a.missing_terms):
        return " ".join(a.missing_terms[:6])
    return english_question
