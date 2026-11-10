"""Language routing: authoritative language choice, fused Auto detection, transcript validation, clarification instead
of guessing, romanized/code-mixed text, and the voice retry endpoint. Speech models are replaced by stand-ins; the
agent graph, PostgreSQL and the API are real."""
from pathlib import Path

import pytest

from apps.agent import runner
from apps.conversations.models import Message
from apps.execution_traces.models import ExecutionRun, Status
from apps.preferences.models import Preferences
from services.asr import engine as E
from services.asr.engine import Transcript, fuse_scores, validate_transcript
from services.language import detect_text_language, romanized_language

from .test_agent import llm  # noqa: F401  (fixture)


# ----------------------------------------------------------------------------------------------- text language
@pytest.mark.parametrize("text,code,method", [
    ("Naaku YOLO model training gurinchi explain cheyyi", "te", "romanized"),
    ("konchem naaku support vector machine gurinchi detail information istara", "te", "romanized"),
    ("mujhe SVM ke baare mein samjhao", "hi", "romanized"),
    ("PCA గురించి వివరించండి", "te", "script"),
    ("मुझे linear regression का python code दिखाओ", "hi", "script+statistical"),
    ("Explain about SVM in machine learning", "en", "latin-default"),
    ("I like to go to the market with my friends", "en", "latin-default"),
])
def test_text_language_keeps_romanized_and_code_mixed_identity(text, code, method):
    d = detect_text_language(text)
    assert (d.code, d.method) == (code, method)


def test_plain_english_is_never_romanized():
    for t in ["What is the capital of India?", "Tell me about kernel methods", "ok", "Who built the Taj Mahal"]:
        assert romanized_language(t) is None


# ------------------------------------------------------------------------------------------------- fusion / validation
def test_fusion_overrules_an_accent_driven_detector_with_transcript_fit():
    # The real failure: VoxLingua says Marathi for code-mixed Telugu. Among the user's languages (te/hi/en) the Telugu
    # transcript is the one that fits (right script, decent log-prob), so Telugu must win.
    vox = {"te": 0.02, "hi": 0.06, "en": 0.01}
    wl = {"te": 0.30, "hi": 0.50, "en": 0.20}
    cand = {"te": {"logprob": -0.45, "script": 0.9, "degen": 0.0},
            "hi": {"logprob": -1.4, "script": 0.95, "degen": 0.3},
            "en": {"logprob": -1.9, "script": 0.4, "degen": 0.0}}
    fused = fuse_scores(vox, wl, cand)
    assert next(iter(fused)) == "te"
    assert abs(sum(fused.values()) - 1) < 1e-6


def test_validation_rejects_wrong_script_and_loops():
    assert validate_transcript("PCA గురించి చెప్పండి", "te")[0]
    assert not validate_transcript("कुण्चम्णाकू सपोर्ट्वेक्टर", "te")[0]  # Telugu speech written in Devanagari
    assert not validate_transcript("అ అ అ అ అ అ అ అ అ అ అ అ అ అ అ అ", "te")[0]
    assert not validate_transcript("   ", "hi")[0]
    assert validate_transcript("what is the capital of Mexico", "en")[0]


# --------------------------------------------------------------------------------------------------- router
@pytest.fixture
def fake_audio(monkeypatch, tmp_path):
    """Skip ffmpeg/MLX: a 3-second 'recording' whose trial transcripts we control."""
    import numpy as np
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"x")
    monkeypatch.setattr(E, "to_wav16k", lambda src: Path(str(wav)))
    monkeypatch.setattr(E, "_audio_seconds", lambda w: 3.0)
    monkeypatch.setattr(E, "_mlx_ok", lambda: True)
    monkeypatch.setattr(E, "_on_mlx", lambda fn, *a, **k: fn(*a, **k))
    monkeypatch.setattr(E, "load_audio", lambda p: np.zeros(48000, dtype="float32"))
    monkeypatch.setattr(E, "indic_available", lambda: (False, "gated"))
    monkeypatch.setattr(E, "_personal_langs", lambda: set())
    calls = []
    texts = {"te": ("PCA గురించి చెప్పండి", -0.4), "hi": ("पीसीए गुरिंची चेप्पंडी", -1.3), "en": ("PCA Gurinchi Cheppandi", -1.6),
             "mr": ("पीसीए गुरिंची", -1.0)}

    def trial(audio, lang, quick=False):
        calls.append((lang, quick))
        return texts.get(lang, ("", -5.0))
    monkeypatch.setattr(E, "_mlx_transcribe", trial)
    return calls


def test_selected_language_is_authoritative(fake_audio, monkeypatch):
    monkeypatch.setattr(E, "choose_language", lambda *a, **k: pytest.fail("a chosen language must never be re-detected"))
    t = E.transcribe(Path("x.webm"), language="te", candidates=["te", "hi", "en"])
    assert (t.language, t.selected_language, t.status) == ("te", "te", "ok")
    assert t.lid_model == "your language selection"
    assert fake_audio == [("te", False)]


def test_auto_considers_only_the_users_languages(fake_audio, monkeypatch):
    monkeypatch.setattr(E, "_vox_restricted", lambda audio, langs: {"te": 0.03, "hi": 0.04, "en": 0.01})  # weak, accent-ish
    monkeypatch.setattr(E, "_whisper_restricted", lambda audio, langs: {k: 1 / len(langs) for k in langs})
    t = E.transcribe(Path("x.webm"), language="auto", candidates=["te", "hi", "en"])
    assert t.language == "te" and t.text == "PCA గురించి చెప్పండి"
    assert "mr" not in {l for l, _ in fake_audio}  # Marathi was never even considered
    assert set(t.debug["fused"]) == {"te", "hi", "en"}


def test_low_confidence_asks_instead_of_guessing(fake_audio, monkeypatch):
    monkeypatch.setattr(E, "fuse_scores", lambda vox, wl, cand: {"te": 0.45, "hi": 0.40, "en": 0.15})
    monkeypatch.setattr(E, "_vox_restricted", lambda audio, langs: None)
    monkeypatch.setattr(E, "_whisper_restricted", lambda audio, langs: {k: 1 / len(langs) for k in langs})
    t = E.transcribe(Path("x.webm"), language="auto", candidates=["te", "hi", "en"])
    assert t.status == "uncertain"
    assert [o["language"] for o in t.options] == ["te", "hi", "en"]


def test_rejected_primary_transcript_falls_back(fake_audio, monkeypatch):
    monkeypatch.setattr(E, "indic_available", lambda: (True, ""))
    monkeypatch.setattr(E, "_indic_transcribe", lambda audio, lang: ("pca gurinchi", 0.9))  # wrong script → rejected
    t = E.transcribe(Path("x.webm"), language="te", candidates=["te"])
    assert t.engine.startswith("Whisper") and t.text == "PCA గురించి చెప్పండి"
    assert "rejected" in t.note


# ------------------------------------------------------------------------------- two-stage (IndicConformer) Auto
class _FakeIndic:
    """IndicConformer stand-in: per-language CTC confidences + transcripts; counts encoder passes."""
    def __init__(self, conf, texts):
        self.conf, self.texts, self.passes = conf, texts, 0

    def transcribe_many(self, audio, langs):
        from services.asr.indic_conformer import IndicResult
        self.passes += 1
        return {L: IndicResult(self.texts.get(L, ""), self.conf.get(L), "ctc") for L in langs}

    def transcribe(self, audio, lang, decoding="ctc"):
        from services.asr.indic_conformer import IndicResult
        self.passes += 1
        return IndicResult(self.texts.get(lang, ""), self.conf.get(lang), decoding)


@pytest.fixture
def two_stage(fake_audio, monkeypatch):
    monkeypatch.setattr(E, "indic_available", lambda: (True, ""))

    def install(conf, wl, vox=None):
        fake = _FakeIndic(conf, {"te": "నాకు మెషిన్ లెర్నింగ్ గురించి చెప్తావా", "hi": "नक मेशीन लर्नंग गरी च"})
        monkeypatch.setattr(E, "_indic", lambda: fake)
        monkeypatch.setattr(E, "_whisper_restricted", lambda audio, langs: wl)
        monkeypatch.setattr(E, "_vox_restricted", lambda audio, langs: vox)
        return fake
    return install


def test_telugu_that_whisper_hears_as_hindi_is_telugu(two_stage, fake_audio):
    """The owner's real failure: Whisper LID said Hindi (0.92) for Telugu speech. IndicConformer's Telugu head explains
    the audio far better (0.938 vs 0.706, measured on that recording), so the answer is Telugu — with no Whisper trial
    transcriptions and a single IndicConformer pass whose transcript is reused."""
    fake = two_stage({"te": 0.938, "hi": 0.706}, {"te": 0.07, "hi": 0.92, "en": 0.01}, {"te": 0.51, "hi": 0.11, "en": 0.0})
    t = E.transcribe(Path("x.webm"), language="auto", candidates=["te", "hi", "en"])
    assert (t.language, t.status, t.engine) == ("te", "ok", "AI4Bharat IndicConformer-600M")
    assert t.text == "నాకు మెషిన్ లెర్నింగ్ గురించి చెప్తావా" and t.asr_confidence == 0.938
    assert t.debug["method"] == "two-stage" and t.language_probability > 0.9
    assert fake.passes == 1 and fake_audio == []  # no Whisper decoding at all


def test_english_is_decided_by_whisper_lid_not_by_indic_confidence(two_stage, fake_audio):
    # measured: Indian-accented English scored 0.90 on the Hindi head — it must still be English
    two_stage({"te": 0.83, "hi": 0.90}, {"te": 0.0, "hi": 0.0, "en": 1.0}, {"te": 0.38, "hi": 0.05, "en": 0.02})
    t = E.transcribe(Path("x.webm"), language="auto", candidates=["te", "hi", "en"])
    assert t.language == "en" and t.engine.startswith("Whisper")


def test_no_clear_indian_speech_asks_instead_of_guessing(two_stage, fake_audio):
    two_stage({"te": 0.32, "hi": 0.28}, {"te": 0.07, "hi": 0.79, "en": 0.14}, {"te": 0.96, "hi": 0.0, "en": 0.0})
    t = E.transcribe(Path("x.webm"), language="auto", candidates=["te", "hi", "en"])
    assert t.status == "uncertain" and t.language_probability == 0.0
    assert {o["language"] for o in t.options} >= {"te", "hi"}


def test_two_stage_failure_falls_back_to_fusion(two_stage, fake_audio, monkeypatch):
    two_stage({"te": 0.9}, {"te": 0.4, "hi": 0.3, "en": 0.3}, {"te": 0.3, "hi": 0.1, "en": 0.0})

    def boom():
        raise RuntimeError("onnx crashed")
    monkeypatch.setattr(E, "_indic", boom)
    lang, p, dbg = E.choose_language(__import__("numpy").zeros(48000, dtype="float32"), ["te", "hi", "en"])
    assert dbg["method"] == "fused" and lang == "te"


# ------------------------------------------------------------------------------------------------ graph + API
def _voice_turn(api, monkeypatch, tr: Transcript, language=None):
    from django.core.files.uploadedfile import SimpleUploadedFile
    monkeypatch.setattr("services.asr.engine.transcribe", lambda *a, **k: tr)
    data = {"audio": SimpleUploadedFile("v.webm", b"\x1a\x45\xdf\xa3" + b"0" * 2000, content_type="audio/webm")}
    if language:
        data["language"] = language
    r = api.post("/api/agent/voice/", data, format="multipart")
    assert r.status_code == 202, r.content
    runner.execute_run(r.json()["execution_id"])
    return r.json(), ExecutionRun.objects.get(pk=r.json()["execution_id"])


def test_unclear_language_ends_with_a_question_and_retry_uses_the_chosen_language(api, llm, monkeypatch, user):  # noqa: F811
    opts = [{"language": "te", "language_name": "Telugu", "text": "నమస్కారం", "probability": 0.5},
            {"language": "hi", "language_name": "Hindi", "text": "नमस्कारम", "probability": 0.4}]
    unclear = Transcript("నమస్కారం", "te", "Telugu", 0.5, "—", 2.0, 10, "language unclear", {}, "auto", "fused", None,
                         "uncertain", opts)
    data, run = _voice_turn(api, monkeypatch, unclear)
    assert run.status == Status.COMPLETED, run.error
    assert "llm_generation" not in [s.key for s in run.steps.all()]  # nothing was answered on a guess
    reply = Message.objects.get(execution=run, role="assistant")
    assert reply.payload["clarify"]["options"][0]["language"] == "te"
    src = Message.objects.get(execution=run, role="user")
    assert src.payload["speech"]["status"] == "uncertain"

    seen = {}

    def confirmed(path, language="auto", **k):
        seen["language"] = language
        return Transcript("హలో", language, "Telugu", None, "Whisper large-v3-turbo · MLX GPU", 2.0, 10, "", {}, language,
                          "your language selection", 0.9)
    monkeypatch.setattr("services.asr.engine.transcribe", confirmed)
    r = api.post("/api/agent/voice/retry/", {"message_id": str(src.id), "language": "te"}, format="json")
    assert r.status_code == 202, r.content
    runner.execute_run(r.json()["execution_id"])
    assert seen["language"] == "te"
    m = Message.objects.get(pk=r.json()["message"]["id"])
    assert m.language == "te" and m.payload["speech"]["selected_language"] == "te"


def test_language_sent_with_the_recording_overrides_preferences(api, llm, monkeypatch, user):  # noqa: F811
    Preferences.objects.filter(user=user).update(asr_language="hi")
    seen = {}

    def tr(path, language="auto", **k):
        seen.update(language=language, candidates=k.get("candidates"))
        return Transcript("హలో", language, "Telugu", None, "Whisper", 1.0, 5, "", {}, language, "your language selection", 0.9)
    monkeypatch.setattr("services.asr.engine.transcribe", tr)
    from django.core.files.uploadedfile import SimpleUploadedFile
    r = api.post("/api/agent/voice/", {"audio": SimpleUploadedFile("v.webm", b"0" * 2000, content_type="audio/webm"),
                                       "language": "te"}, format="multipart")
    runner.execute_run(r.json()["execution_id"])
    assert seen["language"] == "te"


def test_retry_rejects_other_users_messages(api, client, django_user_model):
    other = django_user_model.objects.create_user("intruder", password="x" * 12)
    from apps.conversations.models import Conversation
    conv = Conversation.objects.create(user=other, title="x")
    m = Message.objects.create(conversation=conv, role="user", content="🎙", modality="voice", payload={"audio_file": "/tmp/a.webm"})
    r = api.post("/api/agent/voice/retry/", {"message_id": str(m.id), "language": "te"}, format="json")
    assert r.status_code == 404


def test_preferences_validate_spoken_languages(api):
    assert api.put("/api/settings/", {"spoken_languages": ["te", "hi", "en"]}, format="json").status_code == 200
    assert api.put("/api/settings/", {"spoken_languages": []}, format="json").status_code == 400
    assert api.put("/api/settings/", {"spoken_languages": ["xx"]}, format="json").status_code == 400
    assert api.put("/api/settings/", {"asr_engine": "whisper"}, format="json").json()["asr_engine"] == "whisper"


def test_english_search_query_never_gets_the_users_language_appended():
    from services.retrievers.pipeline import _drop_added_language_words as drop
    assert drop("YOLO model training explanation Telugu", "Naaku YOLO model training gurinchi explain cheyyi") == "YOLO model training"
    assert drop("Telugu literature history", "Telugu sahityam charitra") == "Telugu literature history"  # user said it


def test_answer_language_validation_catches_script_drift():
    from services.agent_orchestrator.graph import answer_language_ok as ok
    assert ok("SVM అనేది ఒక supervised machine learning algorithm. ఇది data ని రెండు classes గా విభజిస్తుంది [D1].", "te")[0]
    assert not ok("SVM એક supervised machine learning algorithm છે. તે data ને બે classes માં વિભાજિત કરે છે.", "te")[0]  # Gujarati
    assert not ok("SVM is a supervised machine learning algorithm that separates data into classes.", "te")[0]
    assert ok("```python\nprint('hi')\n```\nఇది కోడ్.", "te")[0]  # code is ignored
