"""PDF inspection before loader selection (PyMuPDF): text layer, scanned pages, tables, multi-column layout."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field

import fitz  # PyMuPDF


@dataclass
class PdfInspection:
    pages: int
    text_pages: int
    scanned_pages: list[int] = field(default_factory=list)  # 1-based page numbers with no usable text layer
    table_pages: list[int] = field(default_factory=list)
    multicolumn_pages: list[int] = field(default_factory=list)
    encrypted: bool = False
    avg_chars_per_page: int = 0
    title: str = ""

    @property
    def scanned_ratio(self) -> float:
        return len(self.scanned_pages) / self.pages if self.pages else 0.0

    def as_dict(self) -> dict:
        return {**asdict(self), "scanned_ratio": round(self.scanned_ratio, 3)}


def _is_multicolumn(page) -> bool:
    blocks = [b for b in page.get_text("blocks") if b[6] == 0 and len(b[4].strip()) > 40]
    if len(blocks) < 6:
        return False
    w = page.rect.width
    left = sum(1 for b in blocks if b[2] < w * 0.55)
    right = sum(1 for b in blocks if b[0] > w * 0.45)
    return left >= 3 and right >= 3 and (left + right) >= len(blocks) * 0.7


def inspect_pdf(path: str, sample_limit: int = 60) -> PdfInspection:
    doc = fitz.open(path)
    try:
        if doc.needs_pass:
            return PdfInspection(pages=doc.page_count, text_pages=0, encrypted=True)
        n = doc.page_count
        # Inspect every page for small docs; sample evenly for very large ones (scanned detection is per page later).
        idx = list(range(n)) if n <= sample_limit else sorted({int(i * n / sample_limit) for i in range(sample_limit)})
        insp = PdfInspection(pages=n, text_pages=0, title=(doc.metadata or {}).get("title") or "")
        total = 0
        for i in range(n):
            page = doc[i]
            text = page.get_text("text").strip()
            chars = len(text)
            total += chars
            has_images = bool(page.get_images(full=False))
            if chars < 25 and (has_images or chars == 0):
                insp.scanned_pages.append(i + 1)
            else:
                insp.text_pages += 1
            if i in idx and chars >= 25:
                try:
                    if page.find_tables().tables:
                        insp.table_pages.append(i + 1)
                except Exception:
                    pass
                if _is_multicolumn(page):
                    insp.multicolumn_pages.append(i + 1)
        insp.avg_chars_per_page = total // max(1, n)
        return insp
    finally:
        doc.close()
