"""Deterministic intent classification.

Phase 1 uses ordered, auditable rules. Safety-relevant rules ("do not remember") always win.
A later phase adds an LLM classifier for ambiguous input, with these rules kept as a guard.
"""
from __future__ import annotations

import re

from .schemas import Intent, IntentResult

_R = lambda p: re.compile(p, re.I)  # noqa: E731

FORBID_MEMORY = _R(r"\b(do not|don'?t|never)\s+(remember|save|store|memori[sz]e)\b")
DOCS_ONLY = _R(r"\b(only|just|strictly)\b.{0,30}\b(my|the)\s+(pdf|document|notes|files?)s?\b|\bfrom my (pdf|documents?|notes|files?) only\b")

RULES: list[tuple[Intent, re.Pattern, float]] = [
    (Intent.SAVE_MEMORY, _R(r"\b(remember (that|this|my)|save (this|that|it)\b|store (this|that)|in (our|the|my) database|"
                            r"note (that|this) down|keep in mind|memori[sz]e (this|that))"), 0.9),
    (Intent.RECALL_MEMORY, _R(r"\b(what did i (tell|say|mention)|did i (tell|mention)|do you remember|"
                              r"what (have|did) i (saved|save|told)|(told|tell) you (about|that)|my saved memor|"
                              r"(do you know|what(?:'s| is)|tell me|remember) my name|who am i\b)"
                              # Hindi / Telugu questions about the user's name ("क्या तुम्हें मेरा नाम पता है", "నా పేరు
                              # తెలుసా / ఏంటి") — question forms only, so "मेरा नाम X है, याद रखना" stays a save request
                              r"|मेरा नाम\s*(क्या|पता|याद है|बता)|(पता|याद) है\s*मेरा नाम|मेरा नाम पता"
                              r"|నా\s*పేరు\s*(తెలుసా|ఏంటి|ఏమిటి|ఏమి|గుర్తుందా|చెప్పు)"), 0.85),
    (Intent.INGEST_DOCUMENT, _R(r"\b(load|ingest|index|import|upload|add|open)\b[^?\n]*\.pdf\b"), 0.9),
    (Intent.INGEST_DOCUMENT, _R(r"\b(load|ingest|index|import|upload|add|read)\b.{0,60}\b(pdfs?|documents?|files?|folder|"
                                r"notes|\.pdf)\b"), 0.85),
    (Intent.FILE_SEARCH, _R(r"\b(find|search|look for|locate|list)\b.{0,60}\b(pdfs?|files?|documents?)\b"), 0.8),
    (Intent.DOCUMENT_QUESTION, _R(r"\b(my|the|this|uploaded|loaded)\s+(pdfs?|documents?|notes|files?|papers?)\b|"
                                  r"\bfrom my\b|\baccording to (my|the)\b"), 0.75),
    (Intent.WEB_QUESTION, _R(r"\b(latest|current(ly)?|today|this week|news|recent(ly)?|right now|price of|newest|"
                             r"release(d)? (date|version))\b"), 0.7),
]


def classify(text: str) -> IntentResult:
    forbid = bool(FORBID_MEMORY.search(text))
    docs_only = bool(DOCS_ONLY.search(text))
    for intent, pat, conf in RULES:
        if intent is Intent.SAVE_MEMORY and forbid:
            continue
        m = pat.search(text)
        if m:
            return IntentResult(intent=intent, confidence=conf, method="rules", matched=m.group(0),
                                forbid_memory=forbid, documents_only=docs_only)
    return IntentResult(intent=Intent.GENERAL, confidence=0.6, method="rules",
                        forbid_memory=forbid, documents_only=docs_only)
