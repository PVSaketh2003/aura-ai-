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


class PublicAdminGuardMiddleware:
    """Django admin is only reachable from the machine itself (localhost). On every public host (custom domain or the
    platform's own *.onrender.com address) /admin/ doesn't exist."""

    def __init__(self, get_response):
        from config.env import get_settings
        self.get_response = get_response
        self.domain = get_settings().cookie_domain

    def __call__(self, request):
        if self.domain and request.path.startswith("/admin"):
            # production (COOKIE_DOMAIN set): admin only on the machine itself, never on a public host
            host = request.get_host().split(":")[0]
            if host not in ("localhost", "127.0.0.1"):
                from django.http import Http404
                raise Http404
        return self.get_response(request)
