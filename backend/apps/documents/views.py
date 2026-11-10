from pathlib import Path

from django.db.models import Q
from rest_framework import generics, serializers, status
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.agent.runner import start_task
from config.env import get_settings

from . import tasks
from .ingestion import delete_document, new_staging_dir
from .models import Document
from .serializers import ChunkSerializer, DocumentSerializer


class DocumentListView(generics.ListAPIView):
    serializer_class = DocumentSerializer

    def get_queryset(self):
        qs = Document.objects.filter(user=self.request.user)
        if q := self.request.query_params.get("q"):
            qs = qs.filter(Q(filename__icontains=q[:200]) | Q(source_path__icontains=q[:200]))
        if st := self.request.query_params.get("status"):
            qs = qs.filter(status=st)
        return qs


class DocumentDetailView(APIView):
    def _get(self, request, document_id):
        return generics.get_object_or_404(Document, pk=document_id, user=request.user)

    def get(self, request, document_id):
        doc = self._get(request, document_id)
        chunks = doc.chunks.all()
        if q := request.query_params.get("q"):
            chunks = chunks.filter(text__icontains=q[:200])
        offset = max(0, int(request.query_params.get("offset", 0)))
        return Response({**DocumentSerializer(doc).data, "chunks_total": chunks.count(),
                         "chunks": ChunkSerializer(chunks[offset:offset + 50], many=True).data})

    def delete(self, request, document_id):
        delete_document(self._get(request, document_id))
        return Response(status=status.HTTP_204_NO_CONTENT)


class IngestInput(serializers.Serializer):
    query = serializers.CharField(max_length=500, required=False, help_text="Natural-language file description or name")
    path = serializers.CharField(max_length=2048, required=False, help_text="Path on the Mac (relative to an authorized folder)")
    directory = serializers.CharField(max_length=2048, required=False)


class IngestView(APIView):
    """Ingest an uploaded PDF (multipart `file`) or a file/folder on the Mac via the Local Mac Agent."""
    parser_classes = [MultiPartParser, FormParser, JSONParser]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "agent"

    def post(self, request):
        if up := request.FILES.get("file"):
            if not up.name.lower().endswith(".pdf"):
                return Response({"detail": "Only PDF files are supported."}, status=400)
            if up.size > get_settings().max_pdf_bytes:
                return Response({"detail": "File too large."}, status=413)
            staging = new_staging_dir()
            dest = staging / Path(up.name).name
            with open(dest, "wb") as f:
                for c in up.chunks():
                    f.write(c)
            run = start_task(request.user, f"Upload {up.name}", tasks.ingest_uploaded, staged=str(dest), filename=up.name)
            return Response({"execution_id": str(run.id)}, status=202)
        data = IngestInput(data=request.data)
        data.is_valid(raise_exception=True)
        d = data.validated_data
        if not any(d.get(k) for k in ("query", "path", "directory")):
            return Response({"detail": "Provide a file upload, a path, a directory or a query."}, status=400)
        label = d.get("path") or d.get("directory") or d.get("query")
        run = start_task(request.user, f"Load {label}", tasks.ingest_from_mac, **d)
        return Response({"execution_id": str(run.id)}, status=202)


class ReindexView(APIView):
    def post(self, request, document_id):
        doc = generics.get_object_or_404(Document, pk=document_id, user=request.user)
        run = start_task(request.user, f"Re-index {doc.filename}", tasks.reindex, document_id=str(doc.id))
        return Response({"execution_id": str(run.id)}, status=202)
