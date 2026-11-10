from rest_framework import serializers

from .models import ExecutionRun, ExecutionStep


class ExecutionStepSerializer(serializers.ModelSerializer):
    class Meta:
        model = ExecutionStep
        fields = ["id", "seq", "key", "name", "status", "summary", "detail", "error",
                  "started_at", "finished_at", "duration_ms"]


class ExecutionRunSerializer(serializers.ModelSerializer):
    steps = ExecutionStepSerializer(many=True, read_only=True)

    class Meta:
        model = ExecutionRun
        fields = ["id", "conversation", "status", "intent", "input_text", "error",
                  "started_at", "finished_at", "duration_ms", "steps"]
