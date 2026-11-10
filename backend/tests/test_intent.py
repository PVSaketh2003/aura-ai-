import pytest

from services.agent_orchestrator.intent import classify
from services.agent_orchestrator.schemas import Intent


@pytest.mark.parametrize("text,intent", [
    ("Remember that my favourite backend programming language is Golang. Save this in our database.", Intent.SAVE_MEMORY),
    ("Save this in our database. I am currently working on a computer vision project.", Intent.SAVE_MEMORY),
    ("What programming language did I tell you I prefer for backend development?", Intent.RECALL_MEMORY),
    ("Go to my Documents folder and load Machine Learning Notes.pdf.", Intent.INGEST_DOCUMENT),
    ("Load all the PDF files from my Research folder.", Intent.INGEST_DOCUMENT),
    ("Search my Downloads folder for a PDF containing information about computer vision.", Intent.FILE_SEARCH),
    ("Explain the difference between supervised and unsupervised learning from my PDF.", Intent.DOCUMENT_QUESTION),
    ("What is the latest version of Django?", Intent.WEB_QUESTION),
    ("Write a haiku about the monsoon.", Intent.GENERAL),
])
def test_acceptance_phrases(text, intent):
    assert classify(text).intent == intent


def test_do_not_remember_is_never_a_save():
    r = classify("Don't remember this, but my bank PIN hint is a bird. Save it nowhere.")
    assert r.intent != Intent.SAVE_MEMORY and r.forbid_memory


def test_documents_only_flag():
    assert classify("Answer only from my documents: what is backprop?").documents_only


def test_long_filenames_are_ingest_requests():
    t = "Go to my Documents folder and load Introduction to Machine Learning with Python ( PDFDrive.com )-min.pdf"
    assert classify(t).intent == Intent.INGEST_DOCUMENT
    assert classify("What does my PDF say about SVMs?").intent == Intent.DOCUMENT_QUESTION
