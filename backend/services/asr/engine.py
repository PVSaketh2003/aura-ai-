"""Speech recognition: language routing + transcription.

  1. Audio → 16 kHz mono WAV (ffmpeg, fixed argument list, no shell).
  2. Language:
       * a language picked by the user is authoritative — no detector can override it;
       * "Auto" chooses among the user's own languages (Settings → Languages I speak) by fusing VoxLingua107,
         Whisper language ID and a trial transcription in each candidate. Low confidence → ask, never guess.
  3. Engine for that language: personal fine-tuned Whisper (if trained) → AI4Bharat IndicConformer-600M
     (Indian languages, when the gated model is accessible) → Whisper large-v3-turbo on the GPU (MLX).
  4. The transcript is validated (script, repetition); a rejected transcript falls back to the next engine.
"""
from __future__ import annotations

import logging
import re
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from config.env import get_settings
from services.jobs.registry import registry
from services.language import language_name

log = logging.getLogger(__name__)

INDIC_CONFORMER_LANGS = {"as", "bn", "brx", "doi", "gu", "hi", "kn", "kok", "ks", "mai", "ml", "mni", "mr", "ne", "or",
                         "pa", "sa", "sat", "sd", "ta", "te", "ur"}


class ASRError(RuntimeError):
    pass


@dataclass
class Transcript:
    text: str
    language: str
    language_name: str
    language_probability: float | None
    engine: str
    audio_seconds: float
    ms: int
    note: str = ""
    debug: dict | None = None
    selected_language: str = "auto"  # what the user picked ("auto" = detect)
    lid_model: str = ""  # how the language was decided
    asr_confidence: float | None = None  # exp(mean token log-prob) where the engine exposes it
    status: str = "ok"  # ok | uncertain (Aura asks which language instead of guessing)
    options: list | None = None  # for "uncertain": [{language, language_name, text, probability}]

    def as_dict(self):
        return asdict(self)


def to_wav16k(src: Path) -> Path:
    out = Path(tempfile.mkstemp(suffix=".wav")[1])
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-ac", "1", "-ar", "16000",
           "-t", str(get_settings().max_audio_seconds), "-f", "wav", str(out)]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=60)
    except FileNotFoundError as e:
        raise ASRError("ffmpeg is not installed (brew install ffmpeg).") from e
    except subprocess.CalledProcessError as e:
        raise ASRError(f"Could not decode the recording: {e.stderr.decode()[:200]}") from e
    return out


# Whisper on Apple-silicon GPU (MLX). ~10x faster than CPU int8; faster-whisper remains a fallback.
MLX_REPO = "mlx-community/whisper-large-v3-turbo"
# MLX binds its GPU stream to the thread that created it, so every MLX call (load, detect, transcribe) runs on this
# one dedicated thread. Calling from Django worker threads directly fails with "There is no Stream(gpu, 1)".
from concurrent.futures import ThreadPoolExecutor as _TPE  # noqa: E402
_mlx_thread = _TPE(max_workers=1, thread_name_prefix="mlx-whisper")


def _on_mlx(fn, *a, **kw):
    return _mlx_thread.submit(fn, *a, **kw).result()

# Languages Auto mode can choose from (further narrowed to the user's own languages).
SPOKEN = ["en", "hi", "te", "ta", "kn", "ml", "mr", "bn", "gu", "pa", "ur", "ne", "as", "or", "sa"]
# Whisper has no Odia model; those languages need IndicConformer.
WHISPER_UNSUPPORTED = {"or"}
_SCRIPT_RANGES = {"hi": (0x0900, 0x097F), "mr": (0x0900, 0x097F), "ne": (0x0900, 0x097F), "bn": (0x0980, 0x09FF),
                  "as": (0x0980, 0x09FF), "pa": (0x0A00, 0x0A7F), "gu": (0x0A80, 0x0AFF), "ta": (0x0B80, 0x0BFF),
                  "te": (0x0C00, 0x0C7F), "kn": (0x0C80, 0x0CFF), "ml": (0x0D00, 0x0D7F), "ur": (0x0600, 0x06FF),
                  "or": (0x0B00, 0x0B7F), "sa": (0x0900, 0x097F)}
# A short in-language prompt nudges Whisper to the right script and to keep English technical terms intact.
PROMPTS = {
    "te": "నమస్కారం. మెషిన్ లెర్నింగ్, PCA, SVM, రిగ్రెషన్ గురించి చెప్పండి.",
    "hi": "नमस्ते। मशीन लर्निंग, PCA, SVM और रिग्रेशन के बारे में बताइए।",
    "ta": "வணக்கம். மெஷின் லேர்னிங், PCA, SVM பற்றி சொல்லுங்கள்.",
    "kn": "ನಮಸ್ಕಾರ. ಮಷಿನ್ ಲರ್ನಿಂಗ್, PCA, SVM ಬಗ್ಗೆ ಹೇಳಿ.",
    "ml": "നമസ്കാരം. മെഷീൻ ലേണിംഗ്, PCA, SVM എന്നിവയെക്കുറിച്ച് പറയൂ.",
    "en": "Hello. Explain machine learning, PCA, SVM and linear regression.",
}


_mlx_ready: bool | None = None


def _mlx_ok() -> bool:
    """MLX is used once its weights are on disk; until then (first download) the CPU engine keeps working."""
    global _mlx_ready
    if _mlx_ready:
        return True
    try:
        import mlx_whisper  # noqa: F401
        from huggingface_hub import snapshot_download
        path = Path(snapshot_download(MLX_REPO, local_files_only=True))
        # a partial download still has a snapshot folder: require the weights themselves
        _mlx_ready = any((path / f).exists() for f in ("weights.safetensors", "weights.npz"))
    except Exception:
        _mlx_ready = False
    return _mlx_ready


def _mlx_model():
    import mlx.core as mx
    from mlx_whisper.transcribe import ModelHolder
    return registry.get("asr:whisper-mlx", lambda: ModelHolder.get_model(MLX_REPO, mx.float16))


def _whisper():
    if _mlx_ok():
        return _mlx_model()
    from faster_whisper import WhisperModel
    return registry.get("asr:whisper-large-v3-turbo",
                        lambda: WhisperModel(get_settings().whisper_model, device="cpu", compute_type="int8", cpu_threads=8))


def warm() -> bool:
    """Load Whisper in a background thread if it isn't loaded yet. Returns True if a load was started."""
    import threading
    key = "asr:whisper-mlx" if _mlx_ok() else "asr:whisper-large-v3-turbo"
    if key in registry.loaded():
        _whisper()  # touch: resets the idle timer
        return False
    if _mlx_ok():
        _mlx_thread.submit(_mlx_model)
    else:
        threading.Thread(target=_whisper, daemon=True, name="warm-whisper").start()
    return True


def script_share(text: str, lang: str) -> float:
    """Share of letters written in the language's native script (Latin counts as neutral: code-mixed English terms)."""
    rng = _SCRIPT_RANGES.get(lang)
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 0.0
    if not rng:  # English & Latin-script languages
        return sum(c.isascii() for c in letters) / len(letters)
    native = sum(rng[0] <= ord(c) <= rng[1] for c in letters)
    latin = sum(c.isascii() for c in letters)
    other = len(letters) - native - latin
    return max(0.0, (native + 0.3 * latin - other) / len(letters))


def degeneration(text: str) -> float:
    """0 = clean, →1 = mostly repeated characters/words (Whisper's repetition loops)."""
    import zlib
    t = re.sub(r"\s+", " ", text).strip()
    if len(t) < 12:
        return 0.0
    loops = sum(len(m.group(0)) for m in re.finditer(r"(.{1,6}?)\1{3,}", t))
    words = t.split()
    rep_words = 1 - len(set(words)) / len(words) if len(words) >= 8 else 0.0
    ratio = len(t.encode()) / max(1, len(zlib.compress(t.encode())))
    return min(1.0, loops / len(t) * 2 + max(0.0, rep_words - 0.35) + max(0.0, (ratio - 2.6) / 3))


def personal_prompt(lang: str, vocabulary: list[str] | None) -> str | None:
    """The language's base prompt plus the user's own words (learned in Train my voice → Talk freely)."""
    base = PROMPTS.get(lang)
    if not vocabulary:
        return base
    return ((base + " ") if base else "") + ", ".join(vocabulary[:24]) + "."


def _mlx_transcribe(audio, lang: str, quick: bool = False, vocabulary: list[str] | None = None) -> tuple[str, float]:
    """quick=True: greedy decode of the first 12 s only — used to compare candidate languages cheaply.
    vocabulary: the user's own words, added to Whisper's initial prompt to bias decoding towards them."""
    import mlx_whisper
    clip = audio[: 16000 * 12] if quick else audio
    prompt = personal_prompt(lang, vocabulary)
    r = mlx_whisper.transcribe(clip, path_or_hf_repo=MLX_REPO, language=lang, condition_on_previous_text=False,
                               initial_prompt=prompt, temperature=(0.0, 0.4) if quick else (0.0, 0.3),
                               no_speech_threshold=0.6, compression_ratio_threshold=2.4, verbose=None)
    segs = [s for s in r.get("segments", []) if s.get("no_speech_prob", 0) < 0.8 or s.get("avg_logprob", -9) > -0.6]
    text = " ".join(s["text"].strip() for s in segs).strip()
    text = re.sub(r"(\b\S+\b)(?:[\s,]+\1\b){3,}", r"\1", text)  # "and and and and" → "and"
    text = re.sub(r"(\S{1,3}?)\1{4,}", r"\1", text)  # "ప్ప్ప్ప్ప" → "ప్"
    if prompt and text.startswith(prompt[:12]):  # the prompt echoed back on near-silence
        text = text[len(prompt):].strip()
    w = sum(max(1, len(s["text"])) for s in segs) or 1
    logprob = sum(s.get("avg_logprob", -2.0) * max(1, len(s["text"])) for s in segs) / w if segs else -9.0
    return text, logprob


VOX_REPO = "speechbrain/lang-id-voxlingua107-ecapa"


def _vox():
    """SpeechBrain ECAPA spoken-language ID (VoxLingua107). ~0.1 s per clip on CPU and, unlike Whisper's language ID,
    reliably separates Telugu / Tamil / Kannada / Gujarati / Hindi."""
    def load():
        import torchaudio
        if not hasattr(torchaudio, "list_audio_backends"):  # removed in torchaudio 2.9; SpeechBrain still calls it
            torchaudio.list_audio_backends = lambda: ["soundfile"]
        from speechbrain.inference.classifiers import EncoderClassifier
        from config.env import BASE_DIR
        return EncoderClassifier.from_hparams(source=VOX_REPO, savedir=str(BASE_DIR / "data" / "models" / "voxlingua"),
                                              run_opts={"device": "cpu"})
    return registry.get("asr:voxlingua107", load)


# ------------------------------------------------------------------------------------------------ language routing
# Measured on labelled clips (evaluation/asr/README.md, evaluation/asr/lid_signals.jsonl — 95 clips incl. the
# owner's own recordings). No single detector is reliable for an Indian speaker:
#   * VoxLingua107 (acoustic) hears the *accent*: Indian-accented English → "te" (0.75), code-mixed Telugu → "mr".
#   * Whisper's language ID hears the owner's Telugu as Hindi (0.76–0.99 on every Telugu clip) and confuses the
#     Dravidian languages; it IS reliable for "English or not" (≥0.96 on every English clip, ≤0.14 on Indic ones).
#   * IndicConformer's per-language CTC confidence separates the Indian languages cleanly (Telugu clips: te 0.92–0.99
#     vs hi 0.71–0.89; Hindi clips the reverse), but cannot judge English.
# Hence TWO-STAGE (used whenever IndicConformer is available):
#   1. English or an Indian language?  0.75·Whisper-LID(en) + 0.25·VoxLingua(en)
#   2. Which Indian language?          softmax over candidates of k·log(IndicConformer confidence) + w·log(VoxLingua)
#   No Indian language explains the audio (best confidence < floor) → ask, never guess.
#   Leave-one-out on the 95 clips: 94 correct, 1 asked (a near-silent clip), 0 wrong; the previous fusion: 4 wrong.
# Without IndicConformer the earlier fusion runs: both detectors + a Whisper trial transcript per candidate.
TWO_STAGE = {"en_whisper": 0.75, "en_vox": 0.25, "k": 12.0, "vox": 0.3, "floor": 0.45}
FUSE = {"vox": 0.35, "whisper": 0.35, "logprob": 2.2, "script": 3.0, "degen": 4.0}
CLARIFY_BELOW = 0.55  # fused probability of the winner; below this Aura asks instead of guessing
EPS = 1e-3


def _vox_restricted(audio, langs: list[str]) -> dict[str, float] | None:
    """Raw VoxLingua probability mass per candidate (NOT renormalised: renormalising a weak 0.03 into 0.9 is how
    Telugu used to become Marathi)."""
    try:
        import torch
        m = _vox()
        with torch.no_grad():
            probs = m.classify_batch(torch.tensor(audio[: 16000 * 20]).unsqueeze(0))[0].exp()[0]
        enc = m.hparams.label_encoder
        out = {k: 0.0 for k in langs}
        for i, p in enumerate(probs.tolist()):
            code = str(enc.decode_ndim(i)).split(":")[0].strip()
            if code in out:
                out[code] += p
        return out
    except Exception as e:  # noqa: BLE001
        log.warning("VoxLingua language ID unavailable: %s", e)
        return None


def _whisper_restricted(audio, langs: list[str]) -> dict[str, float]:
    from mlx_whisper.audio import N_SAMPLES, log_mel_spectrogram, pad_or_trim
    from mlx_whisper.decoding import detect_language as mlx_detect
    import mlx.core as mx
    model = _mlx_model()
    mel = log_mel_spectrogram(pad_or_trim(mx.array(audio), N_SAMPLES), n_mels=model.dims.n_mels)  # on the MLX thread
    _, probs = mlx_detect(model, mel)
    sub = {k: float(probs.get(k, 0.0)) for k in langs}
    z = sum(sub.values()) or 1.0
    return {k: v / z for k, v in sub.items()}


def fuse_scores(vox: dict | None, wl: dict, cand: dict[str, dict]) -> dict[str, float]:
    """Log-linear fusion → probabilities over the candidate languages."""
    import math
    raw = {}
    for L, c in cand.items():
        z = FUSE["whisper"] * math.log(wl.get(L, 0) + EPS) + FUSE["logprob"] * max(-3.0, c["logprob"]) \
            + FUSE["script"] * c["script"] - FUSE["degen"] * c["degen"]
        if vox is not None:
            z += FUSE["vox"] * math.log(vox.get(L, 0) + EPS)
        raw[L] = z
    m = max(raw.values())
    ex = {k: math.exp(v - m) for k, v in raw.items()}
    tot = sum(ex.values())
    return {k: v / tot for k, v in sorted(ex.items(), key=lambda kv: -kv[1])}


def choose_language(audio, candidates: list[str]) -> tuple[str, float, dict]:
    """Auto mode. Returns (language, probability, debug with every signal and candidate transcript).
    Runs on the MLX thread."""
    langs = [l for l in dict.fromkeys(candidates) if l in SPOKEN or l == "en"] or ["en"]
    if len(langs) == 1:
        return langs[0], 1.0, {"method": "single-language", "candidates_considered": langs}
    indic_c = [l for l in langs if l in INDIC_CONFORMER_LANGS]
    if indic_c and indic_available()[0]:
        try:
            return _choose_two_stage(audio, langs, indic_c)
        except Exception as e:  # noqa: BLE001 — IndicConformer failed: the Whisper-based fusion still works
            log.warning("two-stage language ID failed, using fusion: %s", e)
    return _choose_fused(audio, langs)


def _choose_two_stage(audio, langs: list[str], indic_c: list[str]) -> tuple[str, float, dict]:
    import math
    c = TWO_STAGE
    vox = _vox_restricted(audio, langs) or {}
    wl = _whisper_restricted(audio, langs) if "en" in langs else {}
    p_en = (c["en_whisper"] * wl.get("en", 0.0) + c["en_vox"] * vox.get("en", 0.0)) if "en" in langs else 0.0
    res = _indic().transcribe_many(audio, indic_c)  # one encoder pass over the whole clip, CTC per language
    conf = {L: (res[L].confidence or 0.0) for L in indic_c}
    z = {L: c["k"] * math.log(max(conf[L], EPS)) + c["vox"] * math.log(vox.get(L, 0.0) + EPS) for L in indic_c}
    m = max(z.values())
    ex = {L: math.exp(v - m) for L, v in z.items()}
    tot = sum(ex.values())
    probs = {L: (1 - p_en) * v / tot for L, v in ex.items()}
    if "en" in langs:
        probs["en"] = p_en
    probs = dict(sorted(probs.items(), key=lambda kv: -kv[1]))
    lang, p = next(iter(probs.items()))
    note = ""
    if lang != "en" and max(conf.values()) < c["floor"]:
        p, note = 0.0, "no Indian language explains this audio clearly"
    debug = {"method": "two-stage", "candidates_considered": langs, "p_english": round(p_en, 3),
             "vox": {k: round(v, 3) for k, v in vox.items()}, "whisper": {k: round(v, 3) for k, v in wl.items()},
             "indic_confidence": {k: round(v, 3) for k, v in conf.items()},
             "fused": {k: round(v, 3) for k, v in probs.items()}, "note": note,
             # full-clip IndicConformer transcripts: reused as the final transcript (no second pass)
             "candidates": {L: {"text": res[L].text, "confidence": res[L].confidence, "engine": "indic"} for L in indic_c}}
    return lang, p, debug


def _choose_fused(audio, langs: list[str]) -> tuple[str, float, dict]:
    vox = _vox_restricted(audio, langs)
    wl = _whisper_restricted(audio, langs)
    cand = {}
    for L in [x for x in langs if x not in WHISPER_UNSUPPORTED]:
        text, lp = _mlx_transcribe(audio, L, quick=True)
        cand[L] = {"text": text, "logprob": round(lp, 3), "script": round(script_share(text, L), 3),
                   "degen": round(degeneration(text), 3)}
    fused = fuse_scores(vox, wl, cand)
    lang, p = next(iter(fused.items()))
    debug = {"method": "fused", "candidates_considered": langs,
             "vox": {k: round(v, 3) for k, v in (vox or {}).items()}, "whisper": {k: round(v, 3) for k, v in wl.items()},
             "fused": {k: round(v, 3) for k, v in fused.items()}, "candidates": cand}
    return lang, p, debug


_indic_error: str | None = None
_indic_checked = 0.0


def indic_available() -> tuple[bool, str]:
    """True if IndicConformer is accessible (gated model: Hugging Face login + accepted terms). A failure is re-checked
    every 5 minutes, so access granted later is picked up without a restart."""
    global _indic_error, _indic_checked
    if _indic_error is not None and time.time() - _indic_checked < 300:
        return (not _indic_error), _indic_error
    _indic_checked = time.time()
    from services.asr.indic_conformer import is_downloaded
    if is_downloaded(get_settings().indic_asr_model):  # weights on disk: usable offline, no Hub round-trip
        _indic_error = ""
        return True, ""
    try:
        from huggingface_hub import hf_hub_download
        hf_hub_download(get_settings().indic_asr_model, "config.json")
        _indic_error = ""
    except Exception as e:
        msg = str(e)
        _indic_error = ("Hugging Face has not granted this account access yet: accept the terms at "
                        "huggingface.co/ai4bharat/indic-conformer-600m-multilingual and use a token allowed to read "
                        "gated repos (hf auth login)") if "gated" in msg.lower() or "401" in msg or "403" in msg \
            else f"IndicConformer unavailable: {type(e).__name__}"
    return (not _indic_error), _indic_error


def reset_indic_cache():
    global _indic_error
    _indic_error = None


def _indic():
    """IndicConformer from its local ONNX/TorchScript files (services/asr/indic_conformer.py — no remote code)."""
    from services.asr.indic_conformer import IndicConformer, is_downloaded, weights_dir

    def load():
        import shutil
        repo = get_settings().indic_asr_model
        if not is_downloaded(repo):  # first use: a 2.6 GB download — refuse if the disk can't take it
            if shutil.disk_usage("/").free < 4.5e9:
                raise ASRError("Not enough free disk space to download IndicConformer (needs ~4.5 GB free).")
            weights_dir(repo, local_only=False)
        return IndicConformer(weights_dir(repo), encoder=_indic_int8_encoder(repo))
    return registry.get("asr:indic-conformer-600m", load)


def load_audio(wav: Path):
    """16 kHz WAV → float32 NumPy array. Deliberately NOT mlx_whisper.audio.load_audio: that returns an MLX array bound
    to the calling thread's GPU stream, and MLX ≥0.30 then fails on the dedicated MLX thread ("There is no
    Stream(gpu, 0) in current thread"). NumPy crosses threads safely; MLX converts it on its own thread."""
    import numpy as np
    import soundfile as sf
    a, sr = sf.read(str(wav), dtype="float32", always_2d=False)
    if a.ndim > 1:
        a = a.mean(axis=1)
    if sr != 16000:
        raise ASRError(f"expected 16 kHz audio, got {sr} Hz")
    return np.ascontiguousarray(a, dtype=np.float32)


def _audio_seconds(wav: Path) -> float:
    import soundfile as sf
    info = sf.info(str(wav))
    return info.frames / info.samplerate


def _engine_for(language: str, preferred: str) -> str:
    """Which engine transcribes a known language. English is always Whisper (IndicConformer has no English)."""
    if language == "en" or language not in INDIC_CONFORMER_LANGS or preferred == "whisper":
        return "whisper"
    if language in _personal_langs():
        return "personal"
    return "indic-conformer" if indic_available()[0] else "whisper"


def validate_transcript(text: str, language: str) -> tuple[bool, str]:
    """A transcript must be non-empty, in the language's script (Latin allowed for English terms) and not a loop."""
    if not text.strip():
        return False, "empty transcript"
    if degeneration(text) > 0.5:
        return False, "repetition loop"
    if language != "en" and script_share(text, language) < 0.35:
        return False, f"not written in {language_name(language)} script"
    return True, ""


def transcribe(src: Path, language: str = "auto", hints: list[str] | None = None, *, candidates: list[str] | None = None,
               engine: str = "auto", fallback: str = "whisper", personal: dict | None = None) -> Transcript:
    """language: a language code is AUTHORITATIVE (no detector may override it); "auto" detects among
    `candidates` (the user's languages). engine: auto | indic-conformer | whisper. fallback: whisper | none.
    personal: what Aura learned from the user's corrected free-talk recordings —
    {"vocabulary": {lang: [words]}, "corrections": {lang: [[wrong, right, n]]}} (apps.speech.free_talk.personal_model)."""
    personal = personal or {}
    import math
    t0 = time.perf_counter()
    selected = language or "auto"
    wav = to_wav16k(src)
    try:
        secs = _audio_seconds(wav)
        if secs < 0.3:
            raise ASRError("The recording is too short — nothing was heard.")
        if not _mlx_ok():
            return _transcribe_cpu(wav, language, secs, t0)
        audio = load_audio(wav)
        debug: dict = {}
        if selected != "auto":
            lang, prob, lid_model = selected, None, "your language selection"
        else:
            cands = list(dict.fromkeys((candidates or []) + (hints or []))) or ["te", "hi", "en"]
            lang, prob, debug = _on_mlx(choose_language, audio, cands)
            lid_model = {"two-stage": "Whisper LID (English?) → IndicConformer confidence (which Indian language)",
                         "fused": "VoxLingua107 + Whisper LID + transcript fit"}.get(debug.get("method"), "your only enabled language")
            if prob < CLARIFY_BELOW:
                fused = debug.get("fused", {})
                cand = debug.setdefault("candidates", {})
                for L in list(fused)[:3]:  # two-stage has no English text yet: transcribe it only now, to offer it
                    if L not in cand and L not in WHISPER_UNSUPPORTED:
                        txt, lp = _on_mlx(_mlx_transcribe, audio, L, True)
                        cand[L] = {"text": txt, "logprob": round(lp, 3)}
                opts = [{"language": L, "language_name": language_name(L), "text": cand[L]["text"],
                         "probability": fused.get(L)} for L in list(fused)[:3] if (cand.get(L) or {}).get("text")]
                return Transcript(opts[0]["text"] if opts else "", lang, language_name(lang), prob, "—", round(secs, 2),
                                  int((time.perf_counter() - t0) * 1000), "language unclear", debug, selected, lid_model,
                                  None, "uncertain", opts)

        chosen = _engine_for(lang, engine)
        note, text, conf, used = "", "", None, ""
        attempts = [chosen] + (["whisper"] if chosen != "whisper" and fallback == "whisper" else [])
        for eng in attempts:
            try:
                if eng == "indic-conformer":
                    pre = (debug.get("candidates") or {}).get(lang) or {}
                    if pre.get("engine") == "indic" and get_settings().indic_decoding == "ctc":
                        text, conf = pre["text"], pre.get("confidence")  # already decoded while choosing the language
                    else:
                        text, conf = _indic_transcribe(audio, lang)
                    used = "AI4Bharat IndicConformer-600M"
                elif eng == "personal":
                    text, used = _personal_transcribe(wav, lang), "Whisper · fine-tuned on your voice"
                else:
                    quick = (debug.get("candidates") or {}).get(lang)
                    vocab = (personal.get("vocabulary") or {}).get(lang)
                    if quick and "logprob" in quick and secs <= 12.5 and not vocab:  # already transcribed while choosing the language
                        text, lp = quick["text"], quick["logprob"]
                    else:
                        text, lp = _on_mlx(_mlx_transcribe, audio, lang, False, *([vocab] if vocab else []))
                    conf, used = round(math.exp(max(-5.0, lp)), 3), "Whisper large-v3-turbo · MLX GPU"
                ok, why = validate_transcript(text, lang)
                if ok:
                    break
                note = f"{used} rejected ({why})"
            except Exception as e:  # noqa: BLE001
                note = f"{eng} failed ({type(e).__name__})"
                log.warning("ASR engine %s failed: %s", eng, e)
            text = ""
        registry.record("asr:" + ("indic-conformer-600m" if used.startswith("AI4") else "whisper-mlx"),
                        int((time.perf_counter() - t0) * 1000))
        if not text:
            raise ASRError("I couldn't make out any speech in that recording." + (f" ({note})" if note else ""))
        rules = (personal.get("corrections") or {}).get(lang)
        if rules:
            from services.asr.free_talk import apply_corrections
            text, fixed = apply_corrections(text, rules)
            if fixed:
                debug["personal_corrections"] = fixed
                note = "; ".join(filter(None, [note, "your corrections: " + ", ".join(fixed[:4])]))
        return Transcript(text.strip(), lang, language_name(lang), prob, used, round(secs, 2),
                          int((time.perf_counter() - t0) * 1000), note if text else "", debug, selected, lid_model, conf)
    finally:
        wav.unlink(missing_ok=True)


def _personal_dir() -> Path:
    from config.env import BASE_DIR
    return BASE_DIR / "data" / "models" / "whisper-personal"


def _personal_langs() -> set[str]:
    meta = _personal_dir() / "aura.json"
    if not meta.exists():
        return set()
    try:
        import json
        return set(json.loads(meta.read_text())["languages"])
    except Exception:
        return set()


def _personal_transcribe(wav: Path, language: str) -> str:
    import soundfile as sf
    import torch

    def load():
        from transformers import WhisperForConditionalGeneration, WhisperProcessor
        dev = "mps" if torch.backends.mps.is_available() else "cpu"
        m = WhisperForConditionalGeneration.from_pretrained(_personal_dir(), torch_dtype=torch.float16 if dev == "mps" else torch.float32).to(dev)
        return m.eval(), WhisperProcessor.from_pretrained(_personal_dir()), dev
    model, proc, dev = registry.get("asr:whisper-personal", load)
    audio, _ = sf.read(str(wav), dtype="float32")
    out = []
    for i in range(0, len(audio), 16000 * 30):
        feats = proc.feature_extractor(audio[i:i + 16000 * 30], sampling_rate=16000, return_tensors="pt").input_features
        feats = feats.to(dev, dtype=model.dtype)
        with torch.no_grad():
            ids = model.generate(feats, language=language, task="transcribe", max_new_tokens=440)
        out.append(proc.batch_decode(ids, skip_special_tokens=True)[0].strip())
    return " ".join(out).strip()


def _indic_int8_path() -> Path:
    from config.env import BASE_DIR
    return BASE_DIR / "data" / "models" / "indic-conformer-int8" / "encoder.int8.onnx"


def _indic_int8_encoder(repo: str) -> Path | None:
    """The int8 encoder (built on first use if there's room); None → the original fp32 encoder."""
    import shutil
    from services.asr.indic_conformer import quantize_encoder
    if not get_settings().indic_int8:
        return None
    out = _indic_int8_path()
    if out.exists():
        return out
    if shutil.disk_usage("/").free < 3e9:
        log.warning("not building the int8 IndicConformer encoder: less than 3 GB free disk — using fp32")
        return None
    try:
        return quantize_encoder(repo, out)
    except Exception as e:  # noqa: BLE001
        log.warning("int8 IndicConformer build failed (%s) — using fp32", e)
        out.unlink(missing_ok=True)
        return None


def _indic_transcribe(audio, language: str) -> tuple[str, float | None]:
    """audio: 16 kHz float32 array. Returns (text, confidence)."""
    r = _indic().transcribe(audio, language, decoding=get_settings().indic_decoding)
    return r.text, r.confidence


def _transcribe_cpu(wav: Path, language: str, secs: float, t0: float) -> Transcript:
    import numpy as np
    import soundfile as sf
    model = _whisper()
    prob = None
    if language in ("", "auto"):
        audio, _ = sf.read(str(wav), dtype="float32")
        language, prob, _ = model.detect_language(np.asarray(audio[: 16000 * 30]))
    segments, _ = model.transcribe(str(wav), language=language, beam_size=5, vad_filter=True, condition_on_previous_text=False)
    text = " ".join(s.text.strip() for s in segments).strip()
    if not text:
        raise ASRError("I couldn't make out any speech in that recording.")
    return Transcript(text, language, language_name(language), prob, "Whisper large-v3-turbo · CPU", round(secs, 2),
                      int((time.perf_counter() - t0) * 1000))
