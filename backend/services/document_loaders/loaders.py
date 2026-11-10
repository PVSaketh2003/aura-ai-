"""Loader selection and extraction.

Selection is driven by the inspection report, never by the user:
  mostly scanned (≥60% pages)      → UnstructuredPDFLoader (strategy="ocr_only", Tesseract)
  tables or multi-column layouts   → PDFPlumberLoader (+ tables re-extracted as Markdown, kept whole)
  very large (>250 pages, or >150 with tables) → PyMuPDFLoader (fastest) + pdfplumber tables on table pages only
  standard text PDF                → PyPDFLoader
A few scanned pages inside a text PDF are OCR'd individually (OCR stage) instead of switching loaders.
"""
from __future__ import annotations

import logging
import subprocess
from dataclasses import dataclass
from functools import lru_cache

from .inspector import PdfInspection

log = logging.getLogger(__name__)

PYPDF, PDFPLUMBER, PYMUPDF, UNSTRUCTURED = "PyPDFLoader", "PDFPlumberLoader", "PyMuPDFLoader", "UnstructuredPDFLoader"


@dataclass
class LoaderChoice:
    loader: str
    reason: str
    ocr_pages: list[int]


@dataclass
class PageBlock:
    page: int  # 1-based
    text: str
    kind: str = "text"  # text | table | ocr


class ExtractionError(RuntimeError):
    pass


def select_loader(insp: PdfInspection) -> LoaderChoice:
    if insp.encrypted:
        raise ExtractionError("This PDF is password-protected. Remove the password and try again.")
    if insp.pages == 0:
        raise ExtractionError("This PDF has no pages.")
    if insp.scanned_ratio >= 0.6:
        return LoaderChoice(UNSTRUCTURED, f"{len(insp.scanned_pages)}/{insp.pages} pages are scanned images — OCR pipeline", [])
    layout = len(insp.table_pages) + len(insp.multicolumn_pages)
    if layout and insp.pages > 150:
        return LoaderChoice(PYMUPDF, f"Large document ({insp.pages} pages) — fast PyMuPDF text extraction; tables on "
                                     f"{len(insp.table_pages)} page(s) extracted separately with pdfplumber", insp.scanned_pages)
    if layout:
        bits = []
        if insp.table_pages:
            bits.append(f"tables on {len(insp.table_pages)} page(s)")
        if insp.multicolumn_pages:
            bits.append(f"multi-column layout on {len(insp.multicolumn_pages)} page(s)")
        return LoaderChoice(PDFPLUMBER, "Layout-sensitive: " + ", ".join(bits), insp.scanned_pages)
    if insp.pages > 250:
        return LoaderChoice(PYMUPDF, f"Large document ({insp.pages} pages) — fast extraction", insp.scanned_pages)
    return LoaderChoice(PYPDF, "Standard text-based PDF", insp.scanned_pages)


@lru_cache
def tesseract_languages() -> list[str]:
    try:
        out = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True, timeout=10).stdout
        return [l.strip() for l in out.splitlines()[1:] if l.strip() and l.strip() != "osd"]
    except (OSError, subprocess.SubprocessError):
        return []


def ocr_lang_string() -> str:
    wanted = ["eng", "hin", "tel", "tam", "kan", "mal", "ben", "mar", "guj", "pan"]
    have = set(tesseract_languages())
    return "+".join(l for l in wanted if l in have) or "eng"


def _rows_to_markdown(rows: list[list]) -> str:
    rows = [[(c or "").replace("\n", " ").strip() for c in r] for r in rows if r and any(c for c in r)]
    if len(rows) < 2:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    lines = ["| " + " | ".join(rows[0]) + " |", "|" + "---|" * width]
    lines += ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return "\n".join(lines)


def _extract_tables(path: str, pages: list[int]) -> list[PageBlock]:
    import pdfplumber

    blocks = []
    with pdfplumber.open(path) as pdf:
        for p in pages:
            try:
                for t in pdf.pages[p - 1].extract_tables():
                    md = _rows_to_markdown(t)
                    if md:
                        blocks.append(PageBlock(p, md, "table"))
            except Exception as e:
                log.warning("table extraction failed on page %s: %s", p, e)
    return blocks


def ocr_pages(path: str, pages: list[int], dpi: int = 300, on_page=None) -> list[PageBlock]:
    import fitz
    import pytesseract
    from PIL import Image

    if not tesseract_languages():
        raise ExtractionError("OCR is required but Tesseract is not installed (brew install tesseract).")
    lang = ocr_lang_string()
    out = []
    doc = fitz.open(path)
    try:
        for p in pages:
            pix = doc[p - 1].get_pixmap(dpi=dpi)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            text = pytesseract.image_to_string(img, lang=lang).strip()
            if text:
                out.append(PageBlock(p, text, "ocr"))
            if on_page:
                on_page(pages.index(p) + 1, len(pages), recovered=len(out))
    finally:
        doc.close()
    return out


def _page_of(meta: dict) -> int:
    if "page_number" in meta:
        return int(meta["page_number"])
    return int(meta.get("page", 0)) + 1  # PyPDF / PyMuPDF / PDFPlumber use 0-based "page"


def _lazy(loader, on_page, total) -> list:
    """Load page by page so extraction progress is real (pages actually read so far)."""
    docs = []
    for d in loader.lazy_load():
        docs.append(d)
        if on_page:
            on_page(len(docs), total, chars=sum(len(x.page_content or "") for x in docs))
    return docs


def extract(path: str, choice: LoaderChoice, insp: PdfInspection, on_page=None) -> list[PageBlock]:
    if choice.loader == PYPDF:
        from langchain_community.document_loaders import PyPDFLoader
        docs = _lazy(PyPDFLoader(path), on_page, insp.pages)
    elif choice.loader == PDFPLUMBER:
        from langchain_community.document_loaders import PDFPlumberLoader
        docs = _lazy(PDFPlumberLoader(path), on_page, insp.pages)
    elif choice.loader == PYMUPDF:
        from langchain_community.document_loaders import PyMuPDFLoader
        docs = _lazy(PyMuPDFLoader(path), on_page, insp.pages)
    elif choice.loader == UNSTRUCTURED:
        from langchain_community.document_loaders import UnstructuredPDFLoader
        docs = UnstructuredPDFLoader(path, mode="elements", strategy="ocr_only",
                                     languages=ocr_lang_string().split("+")).load()
    else:
        raise ExtractionError(f"Unknown loader {choice.loader}")

    by_page: dict[int, list[str]] = {}
    for d in docs:
        t = (d.page_content or "").strip()
        if t:
            by_page.setdefault(_page_of(d.metadata), []).append(t)
    sep = "\n\n" if choice.loader == UNSTRUCTURED else "\n"
    blocks = [PageBlock(p, sep.join(parts), "ocr" if choice.loader == UNSTRUCTURED else "text")
              for p, parts in sorted(by_page.items())]
    if choice.loader in (PDFPLUMBER, PYMUPDF) and insp.table_pages:
        blocks += _extract_tables(path, insp.table_pages)
    return blocks


class AutoPDFLoader:
    """LangChain-style loader that inspects each file and delegates to the right loader.
    Used as DirectoryLoader's `loader_cls` for batch ingestion; records a per-file report."""

    reports: dict[str, dict] = {}

    def __init__(self, file_path: str, **_):
        self.file_path = file_path

    def load(self):
        from langchain_core.documents import Document as LCDocument

        from .inspector import inspect_pdf
        try:
            insp = inspect_pdf(self.file_path)
            choice = select_loader(insp)
            blocks = extract(self.file_path, choice, insp)
            if choice.ocr_pages:
                blocks += ocr_pages(self.file_path, choice.ocr_pages)
            AutoPDFLoader.reports[self.file_path] = {"ok": True, "loader": choice.loader, "reason": choice.reason,
                                                     "inspection": insp.as_dict(), "blocks": blocks}
            return [LCDocument(page_content=b.text, metadata={"page_number": b.page, "kind": b.kind,
                                                               "source": self.file_path}) for b in blocks]
        except Exception as e:
            AutoPDFLoader.reports[self.file_path] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
            raise

    def lazy_load(self):
        yield from self.load()
