"""Free-talk voice training: the user talks for up to ~5 minutes in any mix of languages.

  1. `split_speech` cuts the recording at natural pauses (Silero VAD, shipped with faster-whisper) into utterances of
     ~2–15 s, so every utterance gets its OWN language detection — switching Telugu → English → Hindi mid-recording works.
  2. Each utterance is transcribed by the normal Aura pipeline (two-stage language ID → IndicConformer / Whisper).
  3. The user confirms or corrects each transcript. From the corrections Aura learns, per language:
       * `learn_corrections` — recurring recognition mistakes ("ఎక్టర్" → "వెక్టర్"), applied to future transcripts
         as whole-word replacements (`apply_corrections`);
       * `learn_vocabulary` — the user's own words (names, technical terms) that recognition missed; given to
         Whisper as its initial prompt, which biases decoding towards them.
     Confirmed (audio, exact text) pairs also go to the fine-tuning manifest (scripts/finetune_voice.py).

What this does NOT do: it does not retrain the neural models by itself (that is the fine-tuning script), and it cannot
guarantee every word — accuracy is measured honestly on the utterances the user checked.
"""
from __future__ import annotations

import re
from collections import Counter
from difflib import SequenceMatcher

SR = 16000
MAX_SESSION_SECONDS = 330  # 5 minutes + a little slack
MIN_SEG, TARGET_MAX_SEG, HARD_MAX_SEG, JOIN_GAP = 0.6, 15.0, 20.0, 0.8

_TOKEN = re.compile(r"[^\s.,!?;:\"“”'‘’()\[\]{}।॥]+")


def split_speech(audio) -> list[tuple[float, float]]:
    """(start, end) seconds of each utterance. Speech separated by short pauses is joined up to ~15 s, so segments are
    sentence-like: long enough to identify the language, short enough for one language and for fine-tuning."""
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    ts = get_speech_timestamps(audio, VadOptions(min_silence_duration_ms=350, speech_pad_ms=150,
                                                 max_speech_duration_s=HARD_MAX_SEG))
    return merge_spans([(t["start"] / SR, t["end"] / SR) for t in ts], len(audio) / SR)


def merge_spans(spans: list[tuple[float, float]], total: float) -> list[tuple[float, float]]:
    out: list[list[float]] = []
    for s, e in spans:
        if out and s - out[-1][1] <= JOIN_GAP and e - out[-1][0] <= TARGET_MAX_SEG:
            out[-1][1] = e
        else:
            out.append([s, e])
    # a tiny fragment joins its nearest neighbour instead of being transcribed alone
    res: list[list[float]] = []
    for s, e in out:
        if res and (e - s < MIN_SEG or res[-1][1] - res[-1][0] < MIN_SEG) and e - res[-1][0] <= HARD_MAX_SEG:
            res[-1][1] = e
        else:
            res.append([s, e])
    return [(round(max(0.0, s), 2), round(min(total, e), 2)) for s, e in res if e - s >= MIN_SEG]


def tokens(text: str) -> list[str]:
    return _TOKEN.findall(text or "")


def learn_corrections(pairs: list[tuple[str, str, str]], max_words: int = 3) -> dict[str, list[tuple[str, str, int]]]:
    """pairs: (language, heard, corrected). Returns {language: [(wrong, right, times seen)]}.

    Only short substitutions (≤ 3 words each side) are learned, and never one whose "wrong" side is something the user
    actually says elsewhere — so a correction can't damage correct words."""
    seen: dict[str, Counter] = {}
    said: dict[str, set[str]] = {}
    for lang, heard, fixed in pairs:
        h, c = tokens(heard), tokens(fixed)
        said.setdefault(lang, set()).update(t.lower() for t in c)
        for op, i1, i2, j1, j2 in SequenceMatcher(a=[t.lower() for t in h], b=[t.lower() for t in c], autojunk=False).get_opcodes():
            if op == "replace" and 0 < i2 - i1 <= max_words and 0 < j2 - j1 <= max_words:
                seen.setdefault(lang, Counter())[(" ".join(h[i1:i2]), " ".join(c[j1:j2]))] += 1
    out: dict[str, list[tuple[str, str, int]]] = {}
    for lang, cnt in seen.items():
        rules = [(w, r, n) for (w, r), n in cnt.most_common()
                 if all(t.lower() not in said[lang] for t in w.split()) and len(w) >= 2]
        if rules:
            out[lang] = rules[:300]
    return out


def apply_corrections(text: str, rules: list[tuple[str, str, int]] | list[list]) -> tuple[str, list[str]]:
    """Whole-word replacement of learned mistakes. Returns (text, ["wrong → right", ...] that were applied)."""
    applied = []
    for w, r, *_ in sorted(rules, key=lambda x: -len(x[0])):
        pat = re.compile(rf"(?<![^\s.,!?;:\"“”'‘’()]){re.escape(w)}(?![^\s.,!?;:\"“”'‘’()])", re.I)
        new = pat.sub(r, text)
        if new != text:
            applied.append(f"{w} → {r}")
            text = new
    return text, applied


def learn_vocabulary(pairs: list[tuple[str, str, str]], limit: int = 24) -> dict[str, list[str]]:
    """The user's words recognition got wrong or that are distinctive (Latin-script terms, names), per language,
    most frequent first."""
    cnt: dict[str, Counter] = {}
    for lang, heard, fixed in pairs:
        h = {t.lower() for t in tokens(heard)}
        for t in tokens(fixed):
            if len(t) < 3 or t.isdigit():
                continue
            missed = t.lower() not in h
            if missed or (t.isascii() and lang != "en") or (t[:1].isupper() and lang == "en"):
                cnt.setdefault(lang, Counter())[t] += 2 if missed else 1
    return {lang: [w for w, _ in c.most_common(limit)] for lang, c in cnt.items()}


# Whisper's well-known outputs for breaths, clicks and silence (it was trained on subtitled video).
_HALLUCINATIONS = {"thank you", "thanks", "thank you very much", "thanks for watching", "thank you for watching", "you",
                   "bye", "bye bye", "okay", "ok", "so", "hmm", "uh", "um", "subscribe", "please subscribe"}


def likely_hallucination(text: str, seconds: float, engine: str = "") -> bool:
    """A short fragment that came back as one of Whisper's stock phrases is almost certainly not what was said."""
    t = re.sub(r"[^\w\s]", "", (text or "").lower()).strip()
    return seconds <= 2.5 and t in _HALLUCINATIONS and "whisper" in engine.lower()
