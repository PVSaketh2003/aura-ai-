import hashlib
import math
import re

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient


@pytest.fixture(autouse=True)
def _inmemory_channels(settings):
    settings.CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
    settings.REST_FRAMEWORK = {**settings.REST_FRAMEWORK, "DEFAULT_THROTTLE_CLASSES": []}


@pytest.fixture
def user(db):
    return get_user_model().objects.create_user("owner", password="correct-horse-battery")


@pytest.fixture
def api(user):
    c = APIClient()
    c.force_authenticate(user)
    return c


def bow_vector(text: str, dim: int = 2560) -> list[float]:
    """Deterministic bag-of-words embedding: texts sharing words are similar. Stands in for the network model."""
    v = [0.0] * dim
    for w in re.findall(r"\w+", text.lower()):
        v[int(hashlib.md5(w.encode()).hexdigest(), 16) % dim] += 1.0
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


@pytest.fixture
def fake_embeddings(monkeypatch):
    from services.embeddings.qwen import QwenEmbeddings

    def _embed(self, texts, attempts=3, keep_alive="60s"):
        self.last_stats = {"count": len(texts), "ms": 1, "dim": self.dim}
        return [bow_vector(t.split("Query: ")[-1]) for t in texts]
    monkeypatch.setattr(QwenEmbeddings, "_embed", _embed)


@pytest.fixture
def temp_chroma(tmp_path):
    from config.env import get_settings
    from services.vector_store import chroma_store
    s = get_settings()
    old = s.chroma_path
    s.chroma_path = tmp_path / "chroma"
    chroma_store.client.cache_clear()
    yield
    s.chroma_path = old
    chroma_store.client.cache_clear()
