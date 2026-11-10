"""AI4Bharat IndicConformer-600M (multilingual, 22 Indian languages), run locally from its ONNX + TorchScript files.

The Hugging Face repo ships a `trust_remote_code` loader; Aura does not execute downloaded Python. This module loads
the same artefacts directly (TorchScript feature extractor, ONNX encoder, CTC decoder and RNNT joint network with one
output head per language) and adds what the stock loader lacks:

  * a confidence for every transcript (CTC: exp of the mean log-probability of the emitted tokens), and
  * `language_scores()` — how well each candidate language's vocabulary explains the audio, from ONE encoder pass.
    Used by Auto mode as an extra, script-independent signal to separate Telugu from Hindi/Tamil/Marathi etc.

Decoding: "ctc" (greedy, one matrix op — fast) or "rnnt" (greedy transducer, slightly more accurate, slower).
"""
from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

LANGS = ["as", "bn", "brx", "doi", "gu", "hi", "kn", "kok", "ks", "mai", "ml", "mni", "mr", "ne", "or", "pa", "sa",
         "sat", "sd", "ta", "te", "ur"]
BLANK_ID = 256
SOS = 256
RNNT_MAX_SYMBOLS = 10
PRED_LAYERS, PRED_HIDDEN = 2, 640
REQUIRED = ["preprocessor.ts", "encoder.onnx", "ctc_decoder.onnx", "rnnt_decoder.onnx", "joint_enc.onnx",
            "joint_pred.onnx", "joint_pre_net.onnx", "vocab.json", "language_masks.json"]


@dataclass
class IndicResult:
    text: str
    confidence: float | None  # 0..1, from the decoder's own probabilities
    decoding: str


def weights_dir(repo: str, local_only: bool = True) -> Path:
    from huggingface_hub import snapshot_download
    return Path(snapshot_download(repo, local_files_only=local_only)) / "assets"


def is_downloaded(repo: str) -> bool:
    try:
        d = weights_dir(repo)
    except Exception:
        return False
    return all((d / f).exists() for f in REQUIRED) and all((d / f"joint_post_net_{l}.onnx").exists() for l in ("te", "hi"))


class IndicConformer:
    def __init__(self, assets: Path, threads: int | None = None, encoder: Path | None = None):
        """encoder: optional replacement encoder (e.g. the int8 build from `quantize_encoder`)."""
        import onnxruntime as ort
        import torch
        self._torch = torch
        self.assets = assets
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads or max(2, (os.cpu_count() or 8) - 2)
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self._so, self._ort = so, ort
        self.pre = torch.jit.load(str(assets / "preprocessor.ts"), map_location="cpu").eval()
        self.s = {n: self._session(n) for n in ("ctc_decoder", "rnnt_decoder", "joint_enc", "joint_pred", "joint_pre_net")}
        self.encoder_path = encoder if encoder and encoder.exists() else assets / "encoder.onnx"
        self.s["encoder"] = self._ort.InferenceSession(str(self.encoder_path), sess_options=so, providers=["CPUExecutionProvider"])
        self._heads: dict[str, object] = {}
        self.vocab = json.loads((assets / "vocab.json").read_text(encoding="utf-8"))
        self.masks = json.loads((assets / "language_masks.json").read_text(encoding="utf-8"))
        self._lock = threading.Lock()  # onnxruntime sessions are thread-safe, but keep one decode at a time (RAM/CPU)

    def _session(self, name: str):
        return self._ort.InferenceSession(str(self.assets / f"{name}.onnx"), sess_options=self._so,
                                          providers=["CPUExecutionProvider"])

    def _head(self, lang: str):
        if lang not in self._heads:
            self._heads[lang] = self._session(f"joint_post_net_{lang}")
        return self._heads[lang]

    # ------------------------------------------------------------------------------------------------ encoder
    def encode(self, audio):
        """audio: float32 numpy array, 16 kHz mono. Returns (encoder outputs [1, D, T], lengths)."""
        torch = self._torch
        wav = torch.from_numpy(audio).float().unsqueeze(0)
        with torch.no_grad():
            feats, length = self.pre(input_signal=wav, length=torch.tensor([wav.shape[-1]]))
        out, lens = self.s["encoder"].run(["outputs", "encoded_lengths"],
                                          {"audio_signal": feats.numpy(), "length": length.numpy()})
        return out, lens

    def _ctc_logprobs(self, enc):
        return self.s["ctc_decoder"].run(["logprobs"], {"encoder_output": enc})[0]  # [1, T, V_all]

    def _ctc_lang(self, logits_all, lang: str):
        import numpy as np
        x = logits_all[0][:, self.masks[lang]]
        x = x - x.max(axis=-1, keepdims=True)
        return x - np.log(np.exp(x).sum(axis=-1, keepdims=True))  # log-softmax over the language's vocabulary

    def _ctc_decode(self, lp, lang: str) -> IndicResult:
        import numpy as np
        idx = lp.argmax(-1)
        best = lp.max(-1)
        toks, conf = [], []
        prev = -1
        for t, i in enumerate(idx.tolist()):
            if i != prev and i != BLANK_ID:
                toks.append(i)
                conf.append(best[t])
            prev = i
        text = "".join(self.vocab[lang][i] for i in toks).replace("▁", " ").strip()
        c = float(np.exp(np.mean(conf))) if conf else None
        return IndicResult(" ".join(text.split()), round(c, 3) if c is not None else None, "ctc")

    def _rnnt_decode(self, enc, lang: str) -> IndicResult:
        import numpy as np
        head = self._head(lang)
        je = self.s["joint_enc"].run(["output"], {"input": enc.transpose(0, 2, 1)})[0]  # [1, T, H]
        hyp = [SOS]
        state = (np.zeros((PRED_LAYERS, 1, PRED_HIDDEN), np.float32), np.zeros((PRED_LAYERS, 1, PRED_HIDDEN), np.float32))
        g_cache = None
        lps = []
        for t in range(je.shape[1]):
            f = je[:, t:t + 1, :]
            for _ in range(RNNT_MAX_SYMBOLS):
                if g_cache is None:
                    g, _, s0, s1 = self.s["rnnt_decoder"].run(
                        ["outputs", "prednet_lengths", "states", "162"],
                        {"targets": np.array([[hyp[-1]]], np.int32), "target_length": np.array([1], np.int32),
                         "states.1": state[0], "onnx::Slice_3": state[1]})
                    g = self.s["joint_pred"].run(["output"], {"input": g.transpose(0, 2, 1)})[0]
                    g_cache = (g, s0, s1)
                g, s0, s1 = g_cache
                j = self.s["joint_pre_net"].run(["output"], {"input": f + g})[0]
                logits = head.run(["output"], {"input": j})[0].reshape(-1)
                logits = logits - logits.max()
                lp = logits - np.log(np.exp(logits).sum())
                k = int(lp.argmax())
                if k == BLANK_ID:
                    break
                hyp.append(k)
                lps.append(float(lp[k]))
                state = (s0, s1)
                g_cache = None  # the prediction network advances only after a non-blank symbol
        text = "".join(self.vocab[lang][x] for x in hyp[1:]).replace("▁", " ").strip()
        c = float(np.exp(np.mean(lps))) if lps else None
        return IndicResult(" ".join(text.split()), round(c, 3) if c is not None else None, "rnnt")

    # ---------------------------------------------------------------------------------------------- public API
    def transcribe(self, audio, lang: str, decoding: str = "ctc") -> IndicResult:
        if lang not in self.masks:
            raise ValueError(f"IndicConformer does not support language '{lang}'")
        with self._lock:
            enc, _ = self.encode(audio)
            if decoding == "rnnt":
                return self._rnnt_decode(enc, lang)
            return self._ctc_decode(self._ctc_lang(self._ctc_logprobs(enc), lang), lang)

    def transcribe_many(self, audio, langs: list[str]) -> dict[str, IndicResult]:
        """CTC transcripts in several languages from one encoder pass (Auto mode: compare candidate languages)."""
        with self._lock:
            enc, _ = self.encode(audio)
            raw = self._ctc_logprobs(enc)
            return {L: self._ctc_decode(self._ctc_lang(raw, L), L) for L in langs if L in self.masks}


def quantize_encoder(repo: str, out: Path) -> Path:
    """int8 dynamic quantisation of the encoder's MatMul weights (2.4 GB fp32 → 0.88 GB). ONNX refuses external-data
    files that are symlinks (the Hugging Face cache) or hard links, so the assets are first APFS-cloned (`cp -c`:
    copy-on-write, no extra disk) into a temporary folder next to `out`."""
    import shutil
    import subprocess
    from onnxruntime.quantization import QuantType, quantize_dynamic
    src = weights_dir(repo)
    tmp = out.parent / "_clones"
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        for f in src.iterdir():
            subprocess.run(["cp", "-c", str(f.resolve()), str(tmp / f.name)], check=True)
        quantize_dynamic(str(tmp / "encoder.onnx"), str(out), weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul"])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return out
