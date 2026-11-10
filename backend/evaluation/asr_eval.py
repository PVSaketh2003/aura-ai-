"""Speech-recognition evaluation: the same recordings through several routing systems.

    cd backend && .venv/bin/python -m evaluation.asr_eval \\
        evaluation/asr/fleurs/te.tsv evaluation/asr/fleurs/hi.tsv evaluation/asr/fleurs/en.tsv \\
        --systems legacy,auto,selected --candidates te,hi,en --out evaluation/asr/results.json

Your own voice: add media/voice_profile/<user id>/manifest.jsonl (written by the "Train my voice" page — every
sentence you read has a known reference, including code-mixed Telugu+English and Hindi+English sentences).
Other dataset files are TSV: <audio path, relative to the TSV>  <language code>  <reference transcript or empty>.
A row without a reference counts for language-ID accuracy only.

Systems
  legacy    the routing used until Nov 2026: VoxLingua107 renormalised over 13 Indian languages + English (top ≥ 0.5
            wins), otherwise 0.65·VoxLingua + 0.35·Whisper-LID; then Whisper in that language.
  auto      the production router (services/asr/engine.py): only the user's languages; two-stage language ID
            (Whisper LID: English? → IndicConformer confidence: which Indian language) and the engine production would
            use; low confidence → "uncertain" (counted as not-wrong, reported separately).
  selected  the user picked the language (the reference language) — engine choice only.
  indic     language given, AI4Bharat IndicConformer-600M, CTC decoding (English → Whisper).
  indic-rnnt  the same with RNNT (transducer) decoding.

Metrics: WER and CER on normalised text (Unicode NFC, lower-case, punctuation removed), language-ID accuracy,
latency per clip. Nothing is mocked: every number comes from the real models on this Mac.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import unicodedata
from pathlib import Path

LEGACY_SPOKEN = ["en", "hi", "te", "ta", "kn", "ml", "mr", "bn", "gu", "pa", "ur", "ne", "as"]


# ------------------------------------------------------------------------------------------------------- metrics
def normalize(t: str) -> str:
    t = unicodedata.normalize("NFC", t).lower()
    t = "".join(" " if unicodedata.category(c).startswith("P") else c for c in t)
    return re.sub(r"\s+", " ", t).strip()


def _edits(a: list, b: list) -> int:
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def wer(ref: str, hyp: str) -> tuple[int, int]:
    r, h = normalize(ref).split(), normalize(hyp).split()
    return _edits(r, h), max(1, len(r))


def cer(ref: str, hyp: str) -> tuple[int, int]:
    r, h = normalize(ref).replace(" ", ""), normalize(hyp).replace(" ", "")
    return _edits(list(r), list(h)), max(1, len(r))


# -------------------------------------------------------------------------------------------------------- systems
def legacy_language(E, audio) -> str:
    """The pre-Nov-2026 decision, reproduced exactly (incl. the renormalisation that inflated weak scores)."""
    import torch
    from mlx_whisper.audio import N_SAMPLES, log_mel_spectrogram, pad_or_trim
    from mlx_whisper.decoding import detect_language as mlx_detect
    m = E._vox()
    with torch.no_grad():
        probs = m.classify_batch(torch.tensor(audio[: 16000 * 20]).unsqueeze(0))[0].exp()[0]
    enc = m.hparams.label_encoder
    vox: dict[str, float] = {}
    for i, p in enumerate(probs.tolist()):
        code = str(enc.decode_ndim(i)).split(":")[0].strip()
        if code in LEGACY_SPOKEN:
            vox[code] = vox.get(code, 0.0) + p
    z = sum(vox.values()) or 1.0
    vox = {k: v / z for k, v in vox.items()}
    top = max(vox.items(), key=lambda kv: kv[1])
    if top[1] >= 0.5:
        return top[0]

    def wl():
        import mlx.core as mx
        model = E._mlx_model()
        mel = log_mel_spectrogram(pad_or_trim(mx.array(audio), N_SAMPLES), n_mels=model.dims.n_mels)
        _, p = mlx_detect(model, mel)
        sub = {k: float(p.get(k, 0.0)) for k in LEGACY_SPOKEN}
        zz = sum(sub.values()) or 1.0
        return {k: v / zz for k, v in sub.items()}
    w = E._on_mlx(wl)
    comb = {k: 0.65 * vox.get(k, 0) + 0.35 * w.get(k, 0) for k in LEGACY_SPOKEN}
    return max(comb.items(), key=lambda kv: kv[1])[0]


def run(paths: list[str], systems: list[str], candidates: list[str], out: str | None, limit: int | None) -> dict:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    import django
    django.setup()
    import logging
    logging.disable(logging.WARNING)
    from services.asr import engine as E

    rows = []
    for tsv in paths:
        base = Path(tsv).parent
        if tsv.endswith(".jsonl"):  # Train-my-voice manifest: your own voice, sentences with known text
            for line in Path(tsv).read_text(encoding="utf-8").splitlines():
                if line.strip():
                    j = json.loads(line)
                    rows.append({"audio": j["audio"], "lang": j["language"], "ref": j["text"], "set": "your-voice-" + j["language"]})
            continue
        for line in Path(tsv).read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            p, lang, ref = (line.split("\t") + ["", ""])[:3]
            rows.append({"audio": str(p if p.startswith("/") else base / p), "lang": lang, "ref": ref.strip(), "set": Path(tsv).stem})
    rows = rows[:limit] if limit else rows

    results = []
    for i, r in enumerate(rows):
        wav = E.to_wav16k(Path(r["audio"]))
        try:
            audio = E.load_audio(wav)
            res = {**r, "seconds": round(len(audio) / 16000, 2), "systems": {}}
            full_cache: dict[str, tuple[str, float]] = {}

            def full(lang):
                if lang not in full_cache:
                    t0 = time.perf_counter()
                    txt, _ = E._on_mlx(E._mlx_transcribe, audio, lang)
                    full_cache[lang] = (txt, (time.perf_counter() - t0) * 1000)
                return full_cache[lang]

            for s in systems:
                t0 = time.perf_counter()
                status = "ok"
                if s == "legacy":
                    lang = legacy_language(E, audio)
                    text, _ = full(lang)
                elif s == "auto":
                    lang, p, dbg = E._on_mlx(E.choose_language, audio, candidates)
                    status = "uncertain" if p < E.CLARIFY_BELOW else "ok"
                    res["auto_debug"] = dbg  # every signal, so fusion weights can be re-fitted offline
                    quick = (dbg.get("candidates") or {}).get(lang)
                    if quick and quick.get("engine") == "indic":  # two-stage: the full-clip IndicConformer transcript
                        text = quick["text"]
                    elif lang in E.INDIC_CONFORMER_LANGS and E.indic_available()[0]:
                        text = E._indic().transcribe(audio, lang).text
                    else:
                        text = quick["text"] if quick and res["seconds"] <= 12.5 else full(lang)[0]
                elif s == "selected":
                    lang = r["lang"]
                    text, _ = full(lang)
                elif s in ("indic", "indic-rnnt"):  # IndicConformer, language given (English → Whisper)
                    lang = r["lang"]
                    if lang == "en":
                        text = full("en")[0]
                    else:
                        text = E._indic().transcribe(audio, lang, decoding="rnnt" if s == "indic-rnnt" else "ctc").text
                else:
                    raise SystemExit(f"unknown system {s}")
                ms = (time.perf_counter() - t0) * 1000
                entry = {"lang": lang, "status": status, "text": text, "ms": round(ms)}
                if r["ref"]:
                    entry["wer"] = wer(r["ref"], text)
                    entry["cer"] = cer(r["ref"], text)
                res["systems"][s] = entry
            results.append(res)
            if out:  # incremental: a crash late in a long run must not lose the finished clips
                with open(str(out) + ".partial.jsonl", "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(res, ensure_ascii=False) + "\n")
            print(f"[{i + 1}/{len(rows)}] {r['set']:>10} {r['lang']} " + " ".join(
                f"{s}={e['lang']}{'?' if e['status'] != 'ok' else ''}" + (f"/{e['wer'][0] / e['wer'][1]:.2f}" if 'wer' in e else '')
                for s, e in res["systems"].items()), flush=True)
        finally:
            wav.unlink(missing_ok=True)

    summary = summarize(results, systems)
    if out:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_text(json.dumps({"summary": summary, "clips": results, "candidates": candidates,
                                         "fuse": E.FUSE, "clarify_below": E.CLARIFY_BELOW}, ensure_ascii=False, indent=1))
    return summary


def summarize(results: list[dict], systems: list[str]) -> dict:
    out: dict = {}
    for s in systems:
        for group in sorted({r["set"] for r in results}) + ["ALL"]:
            rs = [r for r in results if (group == "ALL" or r["set"] == group) and s in r["systems"]]
            if not rs:
                continue
            e = [r["systems"][s] for r in rs]
            correct = sum(x["lang"] == r["lang"] and x["status"] == "ok" for x, r in zip(e, rs))
            uncertain = sum(x["status"] != "ok" for x in e)
            wrong = len(rs) - correct - uncertain
            scored = [x for x in e if "wer" in x]
            row = {"clips": len(rs), "lid_accuracy": round(correct / len(rs), 3), "lid_wrong": wrong, "asked_instead": uncertain,
                   "mean_ms": round(sum(x["ms"] for x in e) / len(e))}
            if scored:
                row["wer"] = round(sum(x["wer"][0] for x in scored) / sum(x["wer"][1] for x in scored), 3)
                row["cer"] = round(sum(x["cer"][0] for x in scored) / sum(x["cer"][1] for x in scored), 3)
            out[f"{s}:{group}"] = row
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("datasets", nargs="+")
    ap.add_argument("--systems", default="legacy,auto,selected")
    ap.add_argument("--candidates", default="te,hi,en")
    ap.add_argument("--out")
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()
    summ = run(a.datasets, a.systems.split(","), a.candidates.split(","), a.out, a.limit)
    print(json.dumps(summ, indent=1))
