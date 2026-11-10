# Speech-recognition evaluation

Every number here was measured on this Mac (M4, 16 GB) with the real models — nothing mocked.
Raw per-clip outputs: `results.json` (routing systems), `engines.json` (engines with the language given),
`lid_signals.jsonl` (every language-ID signal per clip).

## Datasets

| Set | Clips | Reference | Source |
|---|---|---|---|
| `fleurs/te.tsv` | 25 | human-verified transcript | Google FLEURS test split, Telugu |
| `fleurs/hi.tsv` | 25 | human-verified transcript | FLEURS test, Hindi |
| `fleurs/en.tsv` | 25 | human-verified transcript | FLEURS test, English |
| `user/lid.tsv` | 17 | language label only | the owner's real Aura voice questions (te, hi, en; many code-mixed with English terms) |
| `media/voice_profile/<id>/manifest.jsonl` | 3 | the sentence shown on *Train my voice* | the owner reading prompts in Telugu |

Note on the owner's Telugu set: the speaker paraphrased the prompts (said *నాకు మెషిన్ లెర్నింగ్ గురించి చెప్తావా* for
*మెషిన్ లెర్నింగ్ గురించి సులభంగా వివరించండి*), so WER there is an upper bound that also counts the paraphrase.
Record more sentences on *Train my voice* to grow this set.

WER/CER: corpus-level (total edits / total reference words or characters) after Unicode NFC, lower-casing and
punctuation removal.

## Engines, language given (`engines.json`)

| | Whisper large-v3-turbo (MLX) | IndicConformer-600M · CTC | IndicConformer-600M · RNNT |
|---|---|---|---|
| Telugu FLEURS — WER / CER | 80.3% / 39.9% | **20.8% / 6.1%** | 23.4% / 6.3% |
| Hindi FLEURS — WER / CER | 30.2% / 12.1% | 11.4% / 4.2% | **10.7%** / 4.3% |
| Owner, Telugu — WER / CER | 62.5% / 41.8% | 50.0% / 35.7% | 50.0% / 35.7% |
| Mean latency per clip | 1.9–2.3 s (GPU) | 0.3–0.6 s (CPU, ONNX) | 0.3 s |

CTC is the default (`INDIC_DECODING=ctc`): best on Telugu, the priority language. English stays on Whisper
(IndicConformer has no English).

## Routing systems, end to end (`results.json`, 95 clips)

| | `legacy` (VoxLingua renormalised → Whisper) | `auto` (two-stage → IndicConformer / Whisper) |
|---|---|---|
| Language-ID accuracy | 93.7% — 6 wrong | **100% — 0 wrong, 0 asked** |
| Owner's own clips (20) | 4 wrong | 0 wrong |
| WER / CER, all scored clips | 37.6% / 21.8% | **12.4% / 4.9%** |
| Mean time per clip (LID + transcript) | 2.3 s | 2.1 s |

The previous Auto mode (VoxLingua + Whisper LID + a Whisper trial transcription per candidate) took ~9–11 s per clip
and got 4 of the 95 wrong — two of them the owner's Telugu.

## Why two-stage language ID (`lid_signals.jsonl`)

| Signal | What it gets right | What it gets wrong |
|---|---|---|
| VoxLingua107 | clean studio speech | hears the accent: the owner's English → Telugu 0.75; code-mixed Telugu → Marathi |
| Whisper LID | English vs not English: ≥0.96 on every English clip, ≤0.14 on Indic clips | the owner's Telugu → **Hindi 0.76–0.99 on every clip** |
| IndicConformer CTC confidence | which Indian language: Telugu clips te 0.92–0.99 vs hi 0.71–0.89; Hindi clips the reverse | can't judge English (accented English scored 0.90 on the Hindi head) |

So: stage 1 = 0.75·Whisper-LID(en) + 0.25·VoxLingua(en); stage 2 = softmax over the Indian candidates of
12·log(IndicConformer confidence) + 0.3·log(VoxLingua). If no Indian language explains the audio (best confidence
< 0.45) Aura asks. Leave-one-out over the 95 clips: 94 correct, 1 asked, 0 wrong; unchanged for k ∈ {8, 12, 16} and
without VoxLingua — i.e. not tuned to these clips.

## Reproduce

```bash
cd backend
.venv/bin/python -m evaluation.asr_eval evaluation/asr/fleurs/{te,hi,en}.tsv evaluation/asr/user/lid.tsv \
    media/voice_profile/<user id>/manifest.jsonl --systems legacy,auto,selected --out evaluation/asr/results.json
.venv/bin/python -m evaluation.asr_eval evaluation/asr/fleurs/{te,hi}.tsv media/voice_profile/<user id>/manifest.jsonl \
    --systems selected,indic,indic-rnnt --out evaluation/asr/engines.json
.venv/bin/python -m evaluation.lid_signals evaluation/asr/fleurs/{te,hi,en}.tsv evaluation/asr/user/lid.tsv \
    media/voice_profile/<user id>/manifest.jsonl --out evaluation/asr/lid_signals.jsonl
```
