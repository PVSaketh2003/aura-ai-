import uuid
from pathlib import Path

from config.env import get_settings


def voice_dir() -> Path:
    d = get_settings().media_root / "voice"
    d.mkdir(parents=True, exist_ok=True)
    return d


def tts_dir(message_id: str) -> Path:
    return get_settings().media_root / "tts" / str(uuid.UUID(str(message_id)))


def save_upload(f) -> Path:
    ext = {"audio/webm": ".webm", "audio/mp4": ".m4a", "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/x-wav": ".wav",
           "audio/mpeg": ".mp3"}.get((f.content_type or "").split(";")[0], ".webm")
    dest = voice_dir() / f"{uuid.uuid4().hex}{ext}"
    with open(dest, "wb") as out:
        for c in f.chunks():
            out.write(c)
    return dest
