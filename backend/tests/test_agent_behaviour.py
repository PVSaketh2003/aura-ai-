"""Agent behaviour found wrong in real end-to-end voice tests (Nov 2026) and fixed:
exact arithmetic, junk "memories", name-recall intent in Telugu/Hindi, multi-part questions."""
import pytest

from services.agent_orchestrator.calculator import detect
from services.agent_orchestrator.intent import classify
from services.agent_orchestrator.schemas import Intent
from services.memory_manager.manager import MemoryExtraction, _no_content

from .test_agent import keys, llm, run_sync  # noqa: F401  (fixture)

pytestmark = pytest.mark.django_db


# ------------------------------------------------------------------------------------------------ calculator
@pytest.mark.parametrize("text,expr,result", [
    # the owner's real voice question (Whisper transcript) — the old agent answered "I don't know"
    ("99 plus 89 plus 79 minus 69 plus 59 into 2 plus 0 is equal to how much?", "99 + 89 + 79 − 69 + 59 × 2 + 0", 316),
    ("what is 25 * 4 + 10?", "25 × 4 + 10", 110),
    ("25 गुणा 4 कितना है", "25 × 4", 100),
    ("100 మైనస్ 37 ఎంత", "100 − 37", 63),
    ("(3+4)*5", "(3 + 4) × 5", 35),
    ("how much is 3/4?", "3 ÷ 4", 0.75),
    ("2 to the power of 10?", "2 ^ 10", 1024),
])
def test_calculator_is_exact(text, expr, result):
    c = detect(text)
    assert c is not None and (c.expression, c.result) == (expr, result)


@pytest.mark.parametrize("text", ["What happened in 2019-2020?", "Read chapters 2-3", "3/4 of students passed?",
                                  "Explain SVM", "12 divided by 0?", "__import__('os').system('ls') + 1",
                                  "9 ** 99999 how much"])
def test_calculator_ignores_ranges_and_never_evaluates_code(text):
    assert detect(text) is None


def test_calculation_skips_retrieval_and_gives_the_llm_the_exact_result(api, llm):  # noqa: F811
    _, run = run_sync(api, "99 plus 89 plus 79 minus 69 plus 59 into 2 plus 0 is equal to how much?")
    k = keys(run)
    assert "calculator" in k and "similarity_search" not in k and "wikipedia" not in k and "web_search" not in k
    assert run.steps.get(key="calculator").detail["result"] == 316
    assert "= 316" in llm.prompts[-1][-1]["content"]


# --------------------------------------------------------------------------------------------------- memory
@pytest.mark.parametrize("text,junk", [("This in our database.", True), ("Save it permanently", True),
                                       ("Remember this.", True),
                                       ("The user's favourite backend programming language is Golang.", False),
                                       ("The user is 25 years old.", False), ("వినియోగదారుని పేరు సాకేత్.", False)])
def test_storage_only_fragments_are_not_memories(text, junk):
    assert _no_content(text) is junk


def test_extraction_drops_the_save_instruction_itself(monkeypatch):
    from services.memory_manager import manager
    fake = MemoryExtraction.model_validate({"memories": [
        {"content": "The user's favourite backend programming language is Golang.", "category": "personal_preference"},
        {"content": "This in our database.", "category": "instruction"}]})
    monkeypatch.setattr("services.llm.structured.generate_structured", lambda *a, **k: (fake, {}))
    got = manager.extract_memories("Remember that my favourite backend language is Golang. Save this in our database.")
    assert [m.content for m in got.memories] == ["The user's favourite backend programming language is Golang."]


# --------------------------------------------------------------------------------------------------- intent
@pytest.mark.parametrize("text,intent", [
    ("హలో నీకు నా పేరు తెలుసా", Intent.RECALL_MEMORY),  # real transcript; used to go to Wikipedia ("Hello My Name Is")
    ("क्या तुम्हें मेरा नाम पता है", Intent.RECALL_MEMORY),
    ("Do you know my name?", Intent.RECALL_MEMORY),
    ("मेरा नाम साकेत है, याद रखना", Intent.GENERAL),  # a save request (LLM intent decides), never a recall
    ("నా పేరు సాకేత్, గుర్తుంచుకో", Intent.GENERAL),
    ("What is the capital of Italy?", Intent.GENERAL),
])
def test_name_questions_recall_memory(text, intent):
    assert classify(text).intent is intent


def test_multi_part_questions_must_answer_every_part():
    from services.agent_orchestrator.prompts import plan_prompt
    ev = [{"id": "W1", "kind": "wikipedia", "title": "Rome", "text": "Rome is the capital of Italy.", "similarity": 0.8}]
    p = plan_prompt(question="What is the capital of Italy and what is its currency?", language="en", evidence=ev,
                    status="sufficient", attempted=[], documents_only=False, recall=False, voice=False, strong_memory=False)
    assert "answer EACH part" in p.system()


# ------------------------------------------------------------------------------ code-mixed retrieval queries
@pytest.mark.parametrize("text,acr", [
    ("भाई थोड़ा मेरे को एसवीएम के बारे में समझाओ यार", ["SVM"]),  # real IndicConformer transcript
    ("నాకు ఎస్వీఎం గురించి చెప్పు", ["SVM"]), ("पीसीए क्या है", ["PCA"]), ("సీఎన్ఎన్ అంటే ఏమిటి", ["CNN"]),
    ("सीएनएन और आरएनएन में अंतर", ["CNN", "RNN"]),
    ("హలో నీకు నా పేరు తెలుసా", []), ("भाई जी क्या हाल", []), ("కొంచెం నాకు సపోర్ట్ వెక్టర్ మెషిన్ గురించి", []),
])
def test_acronyms_spelled_in_native_script_are_recovered(text, acr):
    from services.language import native_acronyms
    assert [a for _, a in native_acronyms(text)] == acr


def test_invented_qualifiers_are_dropped_but_spoken_ones_kept():
    from services.retrievers.pipeline import _drop_invented_qualifiers
    assert _drop_invented_qualifiers("SVM men's 2023", "भाई थोड़ा मेरे को एसवीएम के बारे में समझाओ यार") == "SVM"
    assert _drop_invented_qualifiers("PCA cricket", "నాకు పీసీఏ గురించి చెప్పు") == "PCA"
    assert _drop_invented_qualifiers("India men's Test cricket team 2024", "2024 లో ఇండియన్ టెస్ట్ క్రికెట్ టీం") == \
        "India men's Test cricket team 2024"


def test_english_query_never_loses_the_acronym(monkeypatch):
    from services.retrievers import pipeline as rp
    rp._EN_QUERY.clear()

    class Bad:  # the model replies in Hindi: unusable as an English query
        query = "के बारे में समझाओ"
    monkeypatch.setattr("services.llm.structured.generate_structured", lambda *a, **k: (Bad(), {}))
    assert rp.english_query("भाई थोड़ा मेरे को एसवीएम के बारे में समझाओ यार", "hi") == "SVM"
