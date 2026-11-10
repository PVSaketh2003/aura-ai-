from rest_framework import serializers

from .models import Chunk, Document


class DocumentSerializer(serializers.ModelSerializer):
    class Meta:
        model = Document
        fields = ["id", "filename", "file_type", "source", "source_path", "source_directory", "size_bytes",
                  "page_count", "chunk_count", "loader", "loader_reason", "inspection", "chunking_config",
                  "embedding_model", "status", "embedding_status", "index_status", "error", "content_hash",
                  "created_at", "updated_at", "indexed_at"]


class ChunkSerializer(serializers.ModelSerializer):
    class Meta:
        model = Chunk
        fields = ["id", "index", "page_number", "page_end", "kind", "text"]
