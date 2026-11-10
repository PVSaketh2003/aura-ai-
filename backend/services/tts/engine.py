"""Text-to-speech in the answer's language.

  Kokoro-82M (local)  : English, Hindi, Spanish, French, Italian, Portuguese
  Meta MMS-TTS (VITS) : Indic fallback — Telugu, Tamil, Kannada, Malayalam, Bengali, Marathi, Gujarati, Punjabi,
                        Odia, Assamese, Urdu (+ a few others). Each ~145 MB, downloaded on first use.
Text is synthesized sentence by sentence so the first audio segment is ready quickly (streamed to the UI).
"""
from __future__ import annotations

import re
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator

import numpy as np

from services.jobs.registry import registry

KOKORO = {"en": ("a", "af_heart"), "hi": ("h", "hf_alpha"), "es": ("e", "ef_dora"), "fr": ("f", "ff_siwis"),
          "it": ("i", "if_sara"), "pt": ("p", "pf_dora")}
KOKORO_VOICES = {"en": ["af_heart", "af_bella", "af_nicole", "am_michael", "am_fenrir", "bf_emma", "bm_george"],
                 "hi": ["hf_alpha", "hf_beta", "hm_omega", "hm_psi"], "es": ["ef_dora", "em_alex"],
                 "fr": ["ff_siwis"], "it": ["if_sara", "im_nicola"], "pt": ["pf_dora", "pm_alex"]}
MMS = {"te": "tel", "ta": "tam", "kn": "kan", "ml": "mal", "bn": "ben", "mr": "mar", "gu": "guj", "pa": "pan",
       "or": "ory", "as": "asm", "ur": "urd-script_arabic", "ne": "npi", "de": "deu", "ru": "rus", "ar": "ara", "hi": "hin"}


class TTSError(RuntimeError):
    pass


@dataclass
class Segment:
    index: int
    path: Path
    seconds: float


def engine_for(lang: str) -> tuple[str, str]:
    from config.env import get_settings
    if not get_settings().local_speech:
        raise TTSError("Spoken answers aren't available on this server (LOCAL_SPEECH is off). The answer is shown as text.")
    if lang in KOKORO:
        return "kokoro", "Kokoro-82M"
    if lang in MMS:
        return "mms", f"MMS-TTS ({MMS[lang]})"
    raise TTSError(f"No speech voice is available for language '{lang}'. The answer is shown as text only.")


def speakable(text: str) -> str:
    t = re.sub(r"```.*?```", " ", text, flags=re.S)
    t = re.sub(r"`([^`]*)`", r"\1", t)
    t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)
    t = re.sub(r"https?://\S+", "", t)
    t = re.sub(r"\[(?:[DMWSC]\d+(?:,\s*)?)+\]", "", t)  # citation markers
    t = re.sub(r"^\s*[-*•]\s+", "", t, flags=re.M)
    t = re.sub(r"^\s*\|.*\|\s*$", "", t, flags=re.M)
    t = re.sub(r"[*_#>|]+", "", t)
    return re.sub(r"\s+", " ", t).strip()


def sentences(text: str, max_len: int = 280) -> list[str]:
    parts = re.split(r"(?<=[.!?।॥。])\s+", text)
    out, cur = [], ""
    for p in parts:
        if len(cur) + len(p) < max_len:
            cur = f"{cur} {p}".strip()
        else:
            if cur:
                out.append(cur)
            cur = p
    if cur:
        out.append(cur)
    return [s for s in out if re.search(r"\w", s)]


def _kokoro(lang_code: str):
    from kokoro import KPipeline
    return registry.get(f"tts:kokoro:{lang_code}", lambda: KPipeline(lang_code=lang_code, repo_id="hexgrad/Kokoro-82M", device="cpu"))


def _mms(code: str):
    def load():
        from transformers import AutoTokenizer, VitsModel
        name = f"facebook/mms-tts-{code}"
        return VitsModel.from_pretrained(name).eval(), AutoTokenizer.from_pretrained(name)
    return registry.get(f"tts:mms:{code}", load)


def _synth(text: str, lang: str, voice: str | None, speed: float) -> tuple[np.ndarray, int]:
    import torch
    if lang in KOKORO:
        code, default_voice = KOKORO[lang]
        pipe = _kokoro(code)
        chunks = [a.numpy() if hasattr(a, "numpy") else np.asarray(a)
                  for _, _, a in pipe(text, voice=voice or default_voice, speed=speed) if a is not None]
        if not chunks:
            raise TTSError("Kokoro produced no audio.")
        return np.concatenate(chunks), 24000
    model, tok = _mms(MMS[lang])
    if getattr(tok, "is_uroman", False):
        import uroman as ur
        text = ur.Uroman().romanize_string(text)
    inputs = tok(text, return_tensors="pt")
    if inputs["input_ids"].shape[-1] == 0:
        raise TTSError("Text could not be tokenized for speech.")
    with torch.no_grad():
        wav = model(**inputs).waveform[0].cpu().numpy()
    return wav, model.config.sampling_rate


def _encode(audio: np.ndarray, sr: int, dest: Path) -> None:
    import soundfile as sf
    wav = dest.with_suffix(".wav")
    sf.write(str(wav), audio.astype(np.float32), sr)
    try:
        subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav), "-c:a", "aac",
                        "-b:a", "64k", str(dest)], check=True, capture_output=True, timeout=120)
    finally:
        wav.unlink(missing_ok=True)


def synthesize(text: str, lang: str, out_dir: Path, *, voice: str | None = None, speed: float = 1.0,
               on_segment: Callable[[Segment], None] | None = None) -> tuple[Path, float, str]:
    """Synthesizes per sentence (emitting segments as they finish) and writes the full answer to `answer.m4a`."""
    kind, label = engine_for(lang)
    text = speakable(text)
    if not text:
        raise TTSError("Nothing to speak.")
    out_dir.mkdir(parents=True, exist_ok=True)
    full: list[np.ndarray] = []
    sr = 24000
    t0 = time.perf_counter()
    for i, sent in enumerate(sentences(text)):
        audio, sr = _synth(sent, lang, voice, speed)
        full.append(audio)
        full.append(np.zeros(int(sr * 0.12), dtype=np.float32))
        seg = out_dir / f"seg-{i:03d}.m4a"
        _encode(audio, sr, seg)
        if on_segment:
            on_segment(Segment(i, seg, len(audio) / sr))
    registry.record(f"tts:{kind}", int((time.perf_counter() - t0) * 1000))
    final = out_dir / "answer.m4a"
    joined = np.concatenate(full)
    _encode(joined, sr, final)
    return final, len(joined) / sr, label


def iter_supported() -> Iterator[tuple[str, str]]:
    for l in sorted(set(KOKORO) | set(MMS)):
        yield l, engine_for(l)[1]


class SpeechStreamer:
    """Speaks an answer while the LLM is still writing it.

    `feed()` receives answer text deltas; each completed sentence is synthesized on a worker thread and announced via
    `on_segment` immediately, so the first audio plays ~1 s after the first sentence is written instead of after the
    whole answer. `finish()` flushes the tail, waits, and writes the full `answer.m4a` for replay.
    """

    _END = re.compile(r"(?<=[.!?।॥。])\s+|\n{1,}")

    def __init__(self, lang: str, out_dir: Path, *, voice: str | None = None, speed: float = 1.0,
                 on_segment: Callable[[Segment], None] | None = None):
        import queue
        import threading
        self.kind, self.label = engine_for(lang)
        self.lang, self.out_dir, self.voice, self.speed, self.on_segment = lang, out_dir, voice, speed, on_segment
        out_dir.mkdir(parents=True, exist_ok=True)
        self.buf = ""
        self.q: "queue.Queue[str | None]" = queue.Queue()
        self.audio: list[np.ndarray] = []
        self.sr = 24000
        self.index = 0
        self.error: Exception | None = None
        self.first_audio_at: float | None = None
        self.t0 = time.perf_counter()
        self.thread = threading.Thread(target=self._work, daemon=True, name="tts-stream")
        self.thread.start()

    in_code = False
    _raw = ""

    def feed(self, delta: str) -> None:
        # Code blocks are shown on screen, never spoken: drop everything between ``` fences as it streams.
        self._raw += delta
        while True:
            i = self._raw.find("```")
            if i == -1:
                keep = len(self._raw) - 2 if self._raw.endswith(("`", "``")) else len(self._raw)
                if not self.in_code:
                    self.buf += self._raw[:keep]
                self._raw = self._raw[keep:]
                break
            if not self.in_code:
                self.buf += self._raw[:i] + "\n"
            self.in_code = not self.in_code
            self._raw = self._raw[i + 3:]
        while True:
            m = self._END.search(self.buf)
            # The first sentence is released early (shorter) so speech starts fast; later ones are batched a bit.
            min_len = 25 if self.index == 0 and self.q.empty() else 60
            if not m:
                # long comma-separated runs (lists) never end a sentence: speak them in chunks at a comma
                if len(self.buf) > 160 and ("," in self.buf[60:] or "، " in self.buf):
                    k = self.buf.rfind(",", 60, 240) + 1
                    if k > 0:
                        sent, self.buf = self.buf[:k], self.buf[k:]
                        self._push(sent)
                        continue
                return
            cut = m.end()
            if len(self.buf[:cut].strip()) < min_len and len(self.buf) < 400:
                nxt = self._END.search(self.buf, cut)
                if not nxt:
                    return
                cut = nxt.end()
            sent, self.buf = self.buf[:cut], self.buf[cut:]
            self._push(sent)

    def _push(self, text: str) -> None:
        t = speakable(text)
        if re.search(r"\w", t):
            for part in sentences(t):
                self.q.put(part)

    def _work(self) -> None:
        while True:
            sent = self.q.get()
            if sent is None:
                return
            try:
                audio, self.sr = _synth(sent, self.lang, self.voice, self.speed)
                seg = self.out_dir / f"seg-{self.index:03d}.m4a"
                _encode(audio, self.sr, seg)
                self.audio += [audio, np.zeros(int(self.sr * 0.12), dtype=np.float32)]
                if self.first_audio_at is None:
                    self.first_audio_at = time.perf_counter() - self.t0
                if self.on_segment:
                    self.on_segment(Segment(self.index, seg, len(audio) / self.sr))
                self.index += 1
            except Exception as e:  # keep going: one unspeakable sentence shouldn't silence the rest
                self.error = e

    def finish(self, timeout: float = 300) -> tuple[Path, float, str]:
        if not self.in_code and self._raw:
            self.buf += self._raw
        if self.buf.strip():
            self._push(self.buf)
            self.buf = ""
        self.q.put(None)
        self.thread.join(timeout)
        if not self.audio:
            raise TTSError(f"No audio was produced{f': {self.error}' if self.error else ''}.")
        registry.record(f"tts:{self.kind}", int((time.perf_counter() - self.t0) * 1000))
        final = self.out_dir / "answer.m4a"
        joined = np.concatenate(self.audio)
        _encode(joined, self.sr, final)
        return final, len(joined) / self.sr, self.label

    def cancel(self) -> None:
        self.q.put(None)
