"""Export consented feedback into SFT and preference datasets."""
import json
import os
from pathlib import Path

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
import django  # noqa: E402

django.setup()
from apps.conversations.models import MessageFeedback  # noqa: E402

OUT = Path(__file__).parent / "data"


def main():
    OUT.mkdir(exist_ok=True)
    sft, prefs = [], []
    for fb in MessageFeedback.objects.filter(consent=True).select_related("message"):
        msg = fb.message
        q = msg.conversation.messages.filter(role="user", created_at__lt=msg.created_at).order_by("-created_at").first()
        if not q:
            continue
        if fb.correction:
            sft.append({"messages": [{"role": "user", "content": q.content}, {"role": "assistant", "content": fb.correction}]})
            prefs.append({"prompt": q.content, "chosen": fb.correction, "rejected": msg.content})
        elif fb.rating == 1:
            sft.append({"messages": [{"role": "user", "content": q.content}, {"role": "assistant", "content": msg.content}]})
    (OUT / "sft.jsonl").write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in sft))
    (OUT / "preferences.jsonl").write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in prefs))
    print(f"{len(sft)} SFT examples, {len(prefs)} preference pairs → {OUT}")


if __name__ == "__main__":
    main()
