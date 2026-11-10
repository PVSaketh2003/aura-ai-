"""Liveness probe for the hosting platform: answers before host validation and without touching the database, so a
slow database or an unexpected Host header from the platform's health checker can't make a healthy process look dead.
Readiness with real dependency checks stays at /api/health/."""
from django.http import HttpResponse


class HealthzMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path == "/healthz":
            return HttpResponse("ok", content_type="text/plain")
        return self.get_response(request)
