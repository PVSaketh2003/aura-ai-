"""Dump every spoken-language-ID signal for labelled clips, so Auto-mode fusion can be fitted on measured data.

    cd backend && .venv/bin/python -m evaluation.lid_signals evaluation/asr/fleurs/te.tsv ... --out evaluation/asr/lid_signals.jsonl

Per clip: VoxLingua107 (raw mass per candidate), Whisper LID (restricted), Whisper trial transcript per candidate
(log-prob, script share, degeneration) and IndicConformer CTC confidence + transcript per Indic candidate.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def rows_from(paths: list[str]) -> list[dict]:
    rows = []
    for tsv in paths:
        base = Path(tsv).parent
        if tsv.endswith(".jsonl"):
            for line in Path(tsv).read_text(encoding="utf-8").splitlines():
                if line.strip():
                    j = json.loads(line)
                    rows.append({"audio": j["audio"], "lang": j["language"], "set": "your-voice-" + j["language"]})
            continue
        for line in Path(tsv).read_text(encoding="utf-8").splitlines():
            if line.strip():
                p, lang = line.split("\t")[:2]
                rows.append({"audio": str(p if p.startswith("/") else base / p), "lang": lang, "set": Path(tsv).stem})
    return rows


def main(paths, candidates, out):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    import django
    django.setup()
    import logging
    logging.disable(logging.WARNING)
    from services.asr import engine as E

    rows = rows_from(paths)
    with open(out, "w", encoding="utf-8") as fh:
        for i, r in enumerate(rows):
            wav = E.to_wav16k(Path(r["audio"]))
            try:
                audio = E.load_audio(wav)
                vox = E._vox_restricted(audio, candidates)
                wl = E._on_mlx(E._whisper_restricted, audio, candidates)
                cand = {}
                for L in candidates:
                    text, lp = E._on_mlx(E._mlx_transcribe, audio, L, True)
                    cand[L] = {"text": text, "logprob": lp, "script": E.script_share(text, L), "degen": E.degeneration(text)}
                indic = {L: {"conf": v.confidence, "text": v.text}
                         for L, v in E._indic().transcribe_many(audio[: 16000 * 12], [c for c in candidates if c != "en"]).items()}
                rec = {**r, "seconds": round(len(audio) / 16000, 2), "vox": vox, "whisper": wl, "cand": cand, "indic": indic}
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                fh.flush()
                print(f"[{i + 1}/{len(rows)}] {r['set']} {r['lang']} indic={ {k: v['conf'] for k, v in indic.items()} }", flush=True)
            finally:
                wav.unlink(missing_ok=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("datasets", nargs="+")
    ap.add_argument("--candidates", default="te,hi,en")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    main(a.datasets, a.candidates.split(","), a.out)
