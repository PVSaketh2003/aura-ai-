"""Train my voice → Talk freely: segmentation, learning from corrections, the API and personalised transcription.
Speech models are replaced by stand-ins where noted; ffmpeg, PostgreSQL and the API are real."""
import json
import subprocess

import numpy as np
import pytest
import soundfile as sf

from apps.speech import free_talk as FT
from apps.speech.models import FreeTalkSegment, FreeTalkSession
from config.env import get_settings
from services.asr import free_talk as ft
from services.asr.engine import Transcript

pytestmark = pytest.mark.django_db


# --------------------------------------------------------------------------------------------- pure functions
def test_pauses_split_utterances_short_gaps_join_and_fragments_merge():
    spans = [(0.0, 3.0), (3.4, 6.0), (8.0, 12.0), (12.2, 12.4), (20.0, 40.0)]
    assert ft.merge_spans(spans, 40.0) == [(0.0, 6.0), (8.0, 12.4), (20.0, 40.0)]


def test_silence_has_no_utterances():
    assert ft.split_speech(np.zeros(16000 * 5, dtype=np.float32)) == []


def test_learns_a_recurring_mistake_but_never_one_that_damages_words_the_user_says():
    pairs = [("te", "సపోర్ట్ ఎక్టర్ మెషిన్ గురించి", "సపోర్ట్ వెక్టర్ మెషిన్ గురించి"),
             ("te", "ఎక్టర్ అంటే ఏమిటి", "వెక్టర్ అంటే ఏమిటి"),
             ("en", "explain the colonel trick", "explain the kernel trick"),
             # "machine" was heard as "the" here, but the user says "the" elsewhere → must not learn the → machine
             ("en", "support vector the", "support vector machine")]
    rules = ft.learn_corrections(pairs)
    assert rules["te"] == [("ఎక్టర్", "వెక్టర్", 2)]
    assert ("colonel", "kernel", 1) in rules["en"] and all(w != "the" for w, _, _ in rules["en"])


def test_corrections_apply_to_whole_words_only():
    text, applied = ft.apply_corrections("సపోర్ట్ ఎక్టర్ మెషిన్, ఎక్టర్స్", [["ఎక్టర్", "వెక్టర్", 2]])
    assert text == "సపోర్ట్ వెక్టర్ మెషిన్, ఎక్టర్స్" and applied == ["ఎక్టర్ → వెక్టర్"]


def test_vocabulary_prefers_words_recognition_missed():
    v = ft.learn_vocabulary([("te", "నా పేరు సాకేత్ నేను గో లాంగ్ వాడతాను", "నా పేరు సాకేత్ నేను Golang వాడతాను")])
    assert v["te"][0] == "Golang"


def test_whisper_stock_phrases_on_short_noise_are_not_transcripts():
    assert ft.likely_hallucination("Thank you.", 0.94, "Whisper large-v3-turbo · MLX GPU")
    assert not ft.likely_hallucination("Thank you.", 6.0, "Whisper large-v3-turbo · MLX GPU")  # said deliberately
    assert not ft.likely_hallucination("What is the capital of Italy?", 1.5, "Whisper")


def test_vocabulary_goes_into_the_whisper_prompt():
    from services.asr.engine import personal_prompt
    assert personal_prompt("te", ["Golang", "Saketh"]).endswith("Golang, Saketh.")
    assert personal_prompt("en", None).startswith("Hello.")


# --------------------------------------------------------------------------------------------------------- API
@pytest.fixture
def media(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "media_root", tmp_path)
    return tmp_path


@pytest.fixture
def fake_asr(monkeypatch):
    """Three utterances; the stand-in 'recognises' them by order, like a real ASR with one mistake."""
    monkeypatch.setattr(ft, "split_speech", lambda a: [(0.0, 1.5), (2.0, 3.5), (4.0, 5.5)])
    script = iter([("te", "సపోర్ట్ ఎక్టర్ మెషిన్ గురించి చెప్పు", 0.93), ("en", "what is the kernel trick", 0.97),
                   ("hi", "मुझे पीसीए समझाओ", 0.9)])
    seen = []

    def transcribe(path, language="auto", candidates=None, personal=None, **kw):
        seen.append({"candidates": candidates, "personal": personal})
        lang, text, p = next(script)
        return Transcript(text, lang, lang, p, "stand-in", 1.5, 10)
    monkeypatch.setattr("services.asr.engine.transcribe", transcribe)
    monkeypatch.setattr(FT, "submit", FT.process_session)  # synchronous in tests
    return seen


def _webm(tmp_path, seconds=6.0):
    wav = tmp_path / "in.wav"
    t = np.arange(int(16000 * seconds)) / 16000
    sf.write(str(wav), (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), 16000)
    out = tmp_path / "talk.webm"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-c:a", "libopus", str(out)], check=True)
    return out


def test_free_talk_end_to_end(api, user, media, fake_asr, tmp_path):
    from django.core.files.uploadedfile import SimpleUploadedFile
    up = SimpleUploadedFile("talk.webm", _webm(tmp_path).read_bytes(), content_type="audio/webm")
    r = api.post("/api/voice-profile/free/", {"audio": up}, format="multipart")
    assert r.status_code == 202
    s = api.get(f"/api/voice-profile/free/{r.json()['id']}/").json()
    assert s["status"] == "done" and 5.5 < s["seconds"] < 6.5
    assert [x["language"] for x in s["segments"]] == ["te", "en", "hi"]  # each utterance has its own language
    assert fake_asr[0]["candidates"] == ["te", "hi", "en"]

    # each utterance's audio is served to its owner
    seg = s["segments"][0]
    assert api.get(f"/api/voice-profile/free/segments/{seg['id']}/").status_code == 200

    # correct one, confirm one as-is
    r = api.patch(f"/api/voice-profile/free/segments/{seg['id']}/", {"text": "సపోర్ట్ వెక్టర్ మెషిన్ గురించి చెప్పు"}, format="json")
    assert r.json()["verified"] and 0.8 < r.json()["accuracy"] < 1
    r = api.patch(f"/api/voice-profile/free/segments/{s['segments'][1]['id']}/", {"text": s["segments"][1]["heard"]}, format="json")
    assert r.json()["accuracy"] == 1.0

    summ = api.get("/api/voice-profile/free/").json()["summary"]
    assert summ["verified"] == 2 and summ["language_mix"] == {"te": 1, "en": 1, "hi": 1}
    assert summ["corrections"]["te"][0] == {"wrong": "ఎక్టర్", "right": "వెక్టర్", "times": 1}

    # confirmed utterances are fine-tuning pairs
    rows = [json.loads(x) for x in (media / "voice_profile" / str(user.id) / "manifest.jsonl").read_text().splitlines()]
    assert {r["text"] for r in rows} == {"సపోర్ట్ వెక్టర్ మెషిన్ గురించి చెప్పు", "what is the kernel trick"}

    # and the learned correction reaches the next voice turn's transcription
    assert FT.personal_model(user.id)["corrections"]["te"][0][:2] == ("ఎక్టర్", "వెక్టర్")

    # deleting the recording removes its files, rows and training pairs
    assert api.delete(f"/api/voice-profile/free/{s['id']}/").status_code == 204
    assert not FreeTalkSegment.objects.exists() and not (media / "voice_profile" / str(user.id) / "free" / s["id"]).exists()
    assert (media / "voice_profile" / str(user.id) / "manifest.jsonl").read_text() == ""


def test_other_users_cannot_see_or_edit_my_recordings(api, user, media, fake_asr, tmp_path):
    from django.contrib.auth import get_user_model
    from rest_framework.test import APIClient
    s = FreeTalkSession.objects.create(user=user, audio_file="x")
    seg = FreeTalkSegment.objects.create(session=s, user=user, index=0, start=0, end=1, audio_file="x", heard="hi", language="en")
    other = APIClient()
    other.force_authenticate(get_user_model().objects.create_user("intruder", password="pw-12345678"))
    assert other.get(f"/api/voice-profile/free/{s.id}/").status_code == 404
    assert other.get(f"/api/voice-profile/free/segments/{seg.id}/").status_code == 404
    assert other.patch(f"/api/voice-profile/free/segments/{seg.id}/", {"text": "x"}, format="json").status_code == 404


def test_correction_language_must_be_one_of_mine(api, user, media):
    s = FreeTalkSession.objects.create(user=user, audio_file="x")
    seg = FreeTalkSegment.objects.create(session=s, user=user, index=0, start=0, end=1, audio_file="x", heard="hi", language="en")
    r = api.patch(f"/api/voice-profile/free/segments/{seg.id}/", {"text": "hello", "language": "fr"}, format="json")
    assert r.status_code == 400


def test_engine_applies_learned_corrections(monkeypatch, tmp_path):
    from services.asr import engine as E
    wav = tmp_path / "a.wav"
    sf.write(str(wav), (0.1 * np.random.default_rng(0).standard_normal(16000 * 2)).astype(np.float32), 16000)
    monkeypatch.setattr(E, "_mlx_ok", lambda: True)
    monkeypatch.setattr(E, "_engine_for", lambda lang, pref: "indic-conformer")
    monkeypatch.setattr(E, "_indic_transcribe", lambda audio, lang: ("సపోర్ట్ ఎక్టర్ మెషిన్", 0.9))
    monkeypatch.setattr(E.registry, "record", lambda *a: None)
    tr = E.transcribe(wav, language="te", personal={"corrections": {"te": [["ఎక్టర్", "వెక్టర్", 2]]}})
    assert tr.text == "సపోర్ట్ వెక్టర్ మెషిన్" and "your corrections" in tr.note
