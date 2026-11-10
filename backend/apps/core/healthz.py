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
    """Django admin is only for the owner on the Mac itself: on the public hosts (COOKIE_DOMAIN, e.g.
    *.pvsairamsaketh.in through Cloudflare Tunnel) /admin/ simply doesn't exist."""

    def __init__(self, get_response):
        from config.env import get_settings
        self.get_response = get_response
        self.domain = get_settings().cookie_domain

    def __call__(self, request):
        if self.domain and request.path.startswith("/admin"):
            host = request.get_host().split(":")[0]
            if host == self.domain.lstrip(".") or host.endswith(self.domain):
                from django.http import Http404
                raise Http404
        return self.get_response(request)
