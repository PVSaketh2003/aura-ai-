import pytest

from apps.documents.tasks import parse_file_request
from services.language import detect_text_language
from services.llm.structured import AnswerStreamExtractor
from services.tts.engine import engine_for, sentences, speakable


@pytest.mark.parametrize("text,code", [
    ("What programming language did I tell you I prefer?", "en"),
    ("नेरे पसंदीदा प्रोग्रामिंग भाषा क्या है?", "hi"),
    ("నేను బ్యాకెండ్ కోసం ఏ భాషను ఇష్టపడతాను?", "te"),
    ("என் பிடித்த நிரலாக்க மொழி எது?", "ta"),
    ("ನನ್ನ ನೆಚ್ಚಿನ ಭಾಷೆ ಯಾವುದು?", "kn"),
    ("എന്റെ പ്രിയപ്പെട്ട ഭാഷ ഏതാണ്?", "ml"),
    ("আমার প্রিয় প্রোগ্রামিং ভাষা কোনটি?", "bn"),
    ("¿Cuál es la diferencia entre aprendizaje supervisado y no supervisado?", "es"),
])
def test_answer_language_follows_question(text, code):
    assert detect_text_language(text).code == code


def test_every_detected_indic_language_has_a_voice():
    for code in ["en", "hi", "te", "ta", "kn", "ml", "bn", "mr", "gu", "pa", "or", "ur"]:
        assert engine_for(code)[0] in ("kokoro", "mms")


def test_stream_extractor_handles_escapes_and_unicode():
    raw = '{"answer": "Line 1\\nసమాధానం \\"quoted\\" \\u0905 [D1]", "summary": "x", "cited_sources": ["D1"], "confidence": 0.9}'
    ex, out = AnswerStreamExtractor(), []
    for i in range(0, len(raw), 3):  # token-sized chunks split escapes mid-way
        out.append(ex.feed(raw[i:i + 3]))
    assert "".join(out) == 'Line 1\nసమాధానం "quoted" अ [D1]'


def test_speakable_strips_markdown_and_citations():
    assert speakable("**Golang** is fast [D1][M2]. See `code`.\n- item") == "Golang is fast . See code. item"
    assert len(sentences("A. " * 300)) > 1


@pytest.mark.parametrize("text,expect", [
    ("Go to my Documents folder and load Machine Learning Notes.pdf.", {"filename": "Machine Learning Notes.pdf", "folder": "Documents"}),
    ("Load all the PDF files from my Research folder.", {"folder": "Research", "all_in_folder": True}),
    ("Search my Downloads folder for a PDF containing information about computer vision.",
     {"folder": "Downloads", "topic": "computer vision"}),
])
def test_file_request_parsing(text, expect):
    r = parse_file_request(text, use_llm=False).model_dump()
    for k, v in expect.items():
        assert r[k] == v, (k, r)


def test_multi_query_skipped_when_first_pass_is_strong():
    from services.retrievers.pipeline import needs_multi_query
    assert needs_multi_query("నా PDF ప్రకారం kNN ఎలా పని చేస్తుంది?", "te", 0.74) is None
    assert needs_multi_query("నా PDF ప్రకారం kNN ఎలా పని చేస్తుంది?", "te", 0.4)
