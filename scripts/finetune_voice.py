#!/usr/bin/env python
"""Fine-tune Aura's speech recognition on YOUR voice (LoRA on Whisper large-v3-turbo).

Uses the recordings made in Aura → "Train my voice" — read sentences AND confirmed/corrected "Talk freely" utterances
(media/voice_profile/<user>/manifest.jsonl: audio + the exact
sentence you read). LoRA trains ~1% of the weights, so it adapts to your accent/dialect without forgetting
everything else. The merged model is saved to backend/data/models/whisper-personal/ and Aura uses it automatically
for the languages you trained (see services/asr/engine.py → personal model).

Run with the Aura backend STOPPED (it needs the memory):
    cd backend && .venv/bin/python ../scripts/finetune_voice.py --user 1
Recommended: ≥ 40 recordings (≈ 5 minutes) per language; more is better.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", type=int, default=1)
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--base", default="openai/whisper-large-v3-turbo")
    ap.add_argument("--min-samples", type=int, default=20)
    a = ap.parse_args()

    import os
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    import django
    django.setup()
    import numpy as np
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    from config.env import get_settings
    from services.asr.engine import to_wav16k

    manifest = get_settings().media_root / "voice_profile" / str(a.user) / "manifest.jsonl"
    if not manifest.exists():
        sys.exit(f"No recordings yet ({manifest}). Record sentences in Aura → Train my voice first.")
    rows = [json.loads(l) for l in manifest.read_text(encoding="utf-8").splitlines() if l.strip()]
    rows = [r for r in rows if Path(r["audio"]).exists()]
    if len(rows) < a.min_samples:
        sys.exit(f"Only {len(rows)} recordings. Record at least {a.min_samples} (≈ 40+ per language is best).")
    langs = sorted({r["language"] for r in rows})
    print(f"{len(rows)} recordings · languages: {', '.join(langs)}")

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    proc = WhisperProcessor.from_pretrained(a.base)
    model = WhisperForConditionalGeneration.from_pretrained(a.base, torch_dtype=torch.float32)
    model.config.forced_decoder_ids = None
    model = get_peft_model(model, LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05,
                                             target_modules=["q_proj", "k_proj", "v_proj", "out_proj"]))
    model.print_trainable_parameters()
    model.to(device)

    import soundfile as sf

    def features(r):
        wav = to_wav16k(Path(r["audio"]))
        audio, _ = sf.read(str(wav), dtype="float32")
        wav.unlink(missing_ok=True)
        feats = proc.feature_extractor(audio, sampling_rate=16000, return_tensors="pt").input_features
        proc.tokenizer.set_prefix_tokens(language=r["language"], task="transcribe")
        labels = proc.tokenizer(r["text"], return_tensors="pt").input_ids
        return feats, labels

    data = [features(r) for r in rows]
    random.seed(0)
    random.shuffle(data)
    held = data[: max(2, len(data) // 10)]
    train = data[len(held):]
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=a.lr)

    def eval_loss():
        model.eval()
        with torch.no_grad():
            return float(np.mean([model(input_features=f.to(device), labels=l.to(device)).loss.item() for f, l in held]))

    print(f"before: held-out loss {eval_loss():.3f}")
    for ep in range(a.epochs):
        model.train()
        random.shuffle(train)
        losses = []
        for f, l in train:
            loss = model(input_features=f.to(device), labels=l.to(device)).loss
            loss.backward()
            opt.step()
            opt.zero_grad()
            losses.append(loss.item())
        print(f"epoch {ep + 1}/{a.epochs}: train {np.mean(losses):.3f} · held-out {eval_loss():.3f}")

    out = BACKEND / "data" / "models" / "whisper-personal"
    out.mkdir(parents=True, exist_ok=True)
    merged = model.merge_and_unload()
    merged.save_pretrained(out)
    proc.save_pretrained(out)
    (out / "aura.json").write_text(json.dumps({"languages": langs, "samples": len(rows), "base": a.base}))
    print(f"Saved personal model → {out}\nRestart the Aura backend: it will use this model for {', '.join(langs)}.")


if __name__ == "__main__":
    main()
