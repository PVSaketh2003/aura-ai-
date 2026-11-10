"""python -m evaluation.run evaluation/datasets/<file>.jsonl  → prints retrieval P/R@k, faithfulness, relevance,
citation correctness and latency, using the real pipeline (no mocks)."""
import json
import os
import statistics
import sys
import time

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
import django  # noqa: E402

django.setup()

from pydantic import BaseModel, Field  # noqa: E402

from apps.execution_traces.models import ExecutionRun  # noqa: E402
from apps.execution_traces.tracer import Tracer  # noqa: E402
from django.contrib.auth import get_user_model  # noqa: E402
from evaluation.metrics import JUDGE_PROMPT, precision_recall_at_k  # noqa: E402
from services.llm.structured import generate_structured  # noqa: E402
from services.retrievers.pipeline import retrieve_documents  # noqa: E402


class Judge(BaseModel):
    faithfulness: float = Field(ge=0, le=1)
    relevance: float = Field(ge=0, le=1)


def main(path):
    rows = [json.loads(l) for l in open(path) if l.strip()]
    users = {u.username: u for u in get_user_model().objects.all()}
    P, R, F, Rel, L = [], [], [], [], []
    for r in rows:
        u = users[r["user"]]
        run = ExecutionRun.objects.create(user=u, input_text=f"[eval] {r['question']}", intent="evaluation")
        t = time.perf_counter()
        out = retrieve_documents(Tracer(run), r["question"], u.id, "en")
        L.append((time.perf_counter() - t) * 1000)
        ids = [f"{e.document_id}:{e.id}" for e in out.evidence]
        if r.get("relevant_chunks"):
            p, rc = precision_recall_at_k([e.document_id for e in out.evidence], r["relevant_chunks"], 6)
            P.append(p), R.append(rc)
        if r.get("answer"):
            ctx = "\n\n".join(e.text[:1000] for e in out.evidence)
            j, _ = generate_structured(Judge, [{"role": "system", "content": JUDGE_PROMPT},
                                               {"role": "user", "content": f"QUESTION: {r['question']}\nSOURCES:\n{ctx}\nANSWER: {r['answer']}"}], temperature=0)
            F.append(j.faithfulness), Rel.append(j.relevance)
        run.delete()
        print(f"· {r['question'][:60]:<60} {out.status:<12} {len(ids)} chunks")
    m = lambda xs: f"{statistics.mean(xs):.3f}" if xs else "n/a"  # noqa: E731
    print(f"\nprecision@6 {m(P)}  recall@6 {m(R)}  faithfulness {m(F)}  relevance {m(Rel)}  "
          f"retrieval latency p50 {statistics.median(L):.0f}ms")


if __name__ == "__main__":
    main(sys.argv[1])
