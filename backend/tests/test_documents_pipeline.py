import fitz
import pytest

from services.chunking.chunker import chunk_blocks, choose_strategy
from services.document_loaders.inspector import inspect_pdf
from services.document_loaders.loaders import PDFPLUMBER, PYPDF, UNSTRUCTURED, PageBlock, extract, select_loader


def make_pdf(path, pages):
    doc = fitz.open()
    for p in pages:
        page = doc.new_page()
        if p == "scan":
            pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 50, 50), 1)
            page.insert_image(fitz.Rect(50, 50, 300, 300), pixmap=pix)
        else:
            page.insert_textbox(fitz.Rect(50, 50, 550, 800), p, fontsize=11)
    doc.save(path)
    return str(path)


def test_text_pdf_selects_pypdf_and_extracts_pages(tmp_path):
    text = "Supervised learning uses labelled data. " * 20
    path = make_pdf(tmp_path / "a.pdf", [text, "Unsupervised learning finds structure. " * 20])
    insp = inspect_pdf(path)
    choice = select_loader(insp)
    assert insp.pages == 2 and not insp.scanned_pages and choice.loader == PYPDF
    blocks = extract(path, choice, insp)
    assert [b.page for b in blocks] == [1, 2] and "labelled" in blocks[0].text


def test_scanned_pdf_selects_ocr_pipeline(tmp_path):
    insp = inspect_pdf(make_pdf(tmp_path / "s.pdf", ["scan", "scan", "scan"]))
    assert insp.scanned_ratio == 1.0 and select_loader(insp).loader == UNSTRUCTURED


def test_mixed_pdf_ocrs_only_scanned_pages(tmp_path):
    insp = inspect_pdf(make_pdf(tmp_path / "m.pdf", ["Real text here. " * 30, "scan", "More real text. " * 30, "Text " * 50]))
    c = select_loader(insp)
    assert c.loader == PYPDF and c.ocr_pages == [2]


def test_tables_select_pdfplumber():
    from services.document_loaders.inspector import PdfInspection
    assert select_loader(PdfInspection(pages=4, text_pages=4, table_pages=[2])).loader == PDFPLUMBER


def test_chunks_keep_page_references_and_tables_whole():
    blocks = [PageBlock(1, "Alpha. " * 300), PageBlock(2, "Beta. " * 300), PageBlock(2, "| a | b |\n|---|---|\n| 1 | 2 |", "table")]
    chunks, cfg = chunk_blocks(blocks, embeddings=None, forced="recursive")
    assert cfg["strategy"] == "recursive" and cfg["chunk_size"] == 1200
    assert any(c.page == 1 and "Alpha" in c.text for c in chunks)
    assert any(c.page == 2 and c.text.startswith("Beta") for c in chunks)
    assert [c.text for c in chunks if c.kind == "table"] == ["| a | b |\n|---|---|\n| 1 | 2 |"]
    assert all("Beta" not in c.text for c in chunks if c.page_end == 1)


def test_strategy_selection():
    assert choose_strategy([PageBlock(1, "short prose. " * 100)])["strategy"] == "semantic"
    assert choose_strategy([PageBlock(i, "x" * 5000) for i in range(1, 30)])["strategy"] == "recursive"
    assert choose_strategy([PageBlock(1, "ocr text " * 400, "ocr")])["strategy"] == "recursive"
