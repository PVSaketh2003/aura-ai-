from rest_framework.generics import RetrieveAPIView

from .models import ExecutionRun
from .serializers import ExecutionRunSerializer


class ExecutionDetailView(RetrieveAPIView):
    serializer_class = ExecutionRunSerializer
    lookup_url_kwarg = "execution_id"

    def get_queryset(self):
        return ExecutionRun.objects.filter(user=self.request.user).prefetch_related("steps")


# Latest in-stage progress per run (ingest.progress), so a reloaded page can resume a journey mid-stage.
LAST_PROGRESS: dict[str, dict] = {}


class ActiveRunsView(RetrieveAPIView):
    """Runs of the signed-in user that are still running, or finished in the last few minutes (owner-scoped)."""

    def get(self, request, *args, **kwargs):
        from datetime import timedelta

        from django.db.models import Q
        from django.utils import timezone
        from rest_framework.response import Response
        recent = timezone.now() - timedelta(minutes=10)
        runs = (ExecutionRun.objects.filter(user=request.user).filter(Q(status="running") | Q(finished_at__gte=recent))
                .prefetch_related("steps").order_by("-started_at")[:12])
        return Response([{**ExecutionRunSerializer(r).data, "progress": LAST_PROGRESS.get(str(r.id), {})} for r in runs])
