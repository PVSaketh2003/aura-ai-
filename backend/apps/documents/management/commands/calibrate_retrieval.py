"""Calibrate the retrieval-quality similarity threshold on a labelled dataset (JSONL):
  {"question": "...", "user": "<username>", "answerable": true}
Picks the threshold that maximizes F1 for "documents can answer this" and writes data/retrieval_calibration.json."""
import json
from datetime import datetime, timezone
from pathlib import Path

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from services.embeddings.qwen import QwenEmbeddings
from services.retrievers.pipeline import CALIBRATION_FILE
from services.vector_store import chroma_store as vs


class Command(BaseCommand):
    help = __doc__

    def add_arguments(self, p):
        p.add_argument("dataset", type=Path)

    def handle(self, dataset: Path, **kw):
        rows = [json.loads(l) for l in dataset.read_text().splitlines() if l.strip()]
        if len(rows) < 6 or not any(r["answerable"] for r in rows) or all(r["answerable"] for r in rows):
            raise CommandError("Need at least 6 rows with both answerable and unanswerable questions.")
        users = {u.username: u.id for u in get_user_model().objects.all()}
        emb, scored = QwenEmbeddings(), []
        for r in rows:
            hits = vs.query(vs.DOCUMENTS, emb.embed_query(r["question"]), k=1, where={"user_id": users[r["user"]]})
            scored.append((hits[0]["similarity"] if hits else 0.0, bool(r["answerable"])))
        best = (0.0, 0.5)
        for t in sorted({round(s, 3) for s, _ in scored}):
            tp = sum(1 for s, a in scored if s >= t and a)
            fp = sum(1 for s, a in scored if s >= t and not a)
            fn = sum(1 for s, a in scored if s < t and a)
            f1 = 2 * tp / (2 * tp + fp + fn) if tp else 0.0
            if f1 > best[0]:
                best = (f1, t)
        out = {"min_similarity": best[1], "f1": round(best[0], 3), "n": len(rows),
               "embedding_model": emb.model, "created": datetime.now(timezone.utc).isoformat()}
        CALIBRATION_FILE.write_text(json.dumps(out, indent=2))
        self.stdout.write(self.style.SUCCESS(f"Threshold {best[1]} (F1 {best[0]:.3f}) written to {CALIBRATION_FILE}"))
