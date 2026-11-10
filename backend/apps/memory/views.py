from django.db.models import Q
from rest_framework import generics, serializers, status
from rest_framework.response import Response
from rest_framework.views import APIView

from services.memory_manager import manager

from .models import Memory


class MemorySerializer(serializers.ModelSerializer):
    category_label = serializers.CharField(source="get_category_display", read_only=True)

    class Meta:
        model = Memory
        fields = ["id", "content", "category", "category_label", "tags", "language", "original_text", "status",
                  "vector_status", "source_conversation", "created_at", "updated_at"]
        read_only_fields = ["id", "status", "vector_status", "source_conversation", "created_at", "updated_at",
                            "original_text", "category_label"]


class MemoryInput(serializers.Serializer):
    content = serializers.CharField(max_length=2000)
    category = serializers.ChoiceField(choices=Memory.Category.choices, default=Memory.Category.OTHER)
    tags = serializers.ListField(child=serializers.CharField(max_length=32), max_length=8, default=list)
    language = serializers.CharField(max_length=8, default="en")


class MemoryListView(generics.ListAPIView):
    serializer_class = MemorySerializer

    def get_queryset(self):
        qs = Memory.objects.filter(user=self.request.user, status=Memory.Status.ACTIVE)
        if c := self.request.query_params.get("category"):
            qs = qs.filter(category=c)
        if q := self.request.query_params.get("q"):
            qs = qs.filter(Q(content__icontains=q[:200]) | Q(tags__icontains=q[:50]))
        return qs


class MemorySaveView(APIView):
    def post(self, request):
        data = MemoryInput(data=request.data)
        data.is_valid(raise_exception=True)
        d = data.validated_data
        m, outcome, indexed = manager.save_memory(request.user, d["content"], d["category"], d["tags"], language=d["language"],
                                                  original_text=d["content"])
        return Response({"memory": MemorySerializer(m).data, "outcome": outcome, "indexed": indexed},
                        status=status.HTTP_201_CREATED if outcome == "created" else status.HTTP_200_OK)


class MemorySearchView(APIView):
    def post(self, request):
        q = str(request.data.get("query", "")).strip()[:500]
        if not q:
            return Response({"detail": "query is required"}, status=400)
        hits = manager.search_memories(request.user.id, q, k=int(request.data.get("k", 10)), min_similarity=0.3)
        return Response({"results": [{**MemorySerializer(h["memory"]).data, "similarity": h["similarity"], "match": h["match"]}
                                     for h in hits]})


class MemoryDetailView(APIView):
    def _get(self, request, memory_id):
        return generics.get_object_or_404(Memory, pk=memory_id, user=request.user, status=Memory.Status.ACTIVE)

    def get(self, request, memory_id):
        return Response(MemorySerializer(self._get(request, memory_id)).data)

    def put(self, request, memory_id):
        m = self._get(request, memory_id)
        data = MemoryInput(data={**MemorySerializer(m).data, **request.data})
        data.is_valid(raise_exception=True)
        m = manager.update_memory(m, **{k: data.validated_data[k] for k in ("content", "category", "tags")})
        return Response(MemorySerializer(m).data)

    def delete(self, request, memory_id):
        manager.delete_memory(self._get(request, memory_id))
        return Response(status=status.HTTP_204_NO_CONTENT)


class MemoryRebuildView(APIView):
    def post(self, request):
        return Response({"indexed": manager.rebuild_index(request.user.id)})
