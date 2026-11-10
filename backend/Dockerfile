# Aura backend — Django + Channels (Daphne), LangGraph RAG, speech on CPU. Linux image: runs on any OS with Docker.
# Apple-Silicon-only MLX Whisper is not available in containers; Aura falls back to faster-whisper (CPU) automatically.
FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/var/data/hf PORT=8000

# ffmpeg (audio decoding), tesseract (OCR for scanned PDFs), libsndfile (soundfile), espeak-ng (TTS phonemes)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg tesseract-ocr tesseract-ocr-hin tesseract-ocr-tel libsndfile1 espeak-ng curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only PyTorch first (the default Linux wheels pull ~3 GB of CUDA libraries that Render can't use)
COPY requirements.txt .
RUN TORCH=$(grep -E '^torch==' requirements.txt | cut -d= -f3) && \
    TA=$(grep -E '^torchaudio==' requirements.txt | cut -d= -f3) && \
    TV=$(grep -E '^torchvision==' requirements.txt | cut -d= -f3) && \
    pip install --index-url https://download.pytorch.org/whl/cpu "torch==$TORCH" "torchaudio==$TA" "torchvision==$TV" && \
    pip install -r requirements.txt

COPY . .
RUN chmod +x docker-entrypoint.sh && useradd --create-home --uid 10001 aura && \
    mkdir -p /var/data && chown -R aura:aura /app /var/data
USER aura

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/api/health/" || exit 1
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["sh", "-c", "daphne -b 0.0.0.0 -p ${PORT} --proxy-headers config.asgi:application"]
