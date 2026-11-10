"""One backend, two ways in: http://localhost (you, on the Mac) and https://*.pvsairamsaketh.in (through the tunnel).

A fixed SESSION_COOKIE_DOMAIN=".pvsairamsaketh.in" or SESSION_COOKIE_SECURE=True would break sign-in on localhost
(browsers reject cookies for another domain, and Secure cookies over http). So the session/CSRF cookies get the shared
domain and the Secure flag only when THIS request came in over HTTPS on a host under COOKIE_DOMAIN."""
from django.conf import settings

from config.env import get_settings

COOKIES = (settings.SESSION_COOKIE_NAME, settings.CSRF_COOKIE_NAME)


class SiteCookieMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response
        self.domain = get_settings().cookie_domain  # e.g. ".pvsairamsaketh.in"

    def __call__(self, request):
        response = self.get_response(request)
        if not self.domain:
            return response
        host = request.get_host().split(":")[0]
        public = request.is_secure() and (host == self.domain.lstrip(".") or host.endswith(self.domain))
        for name in COOKIES:
            c = response.cookies.get(name)
            if c is None:
                continue
            if public:
                c["domain"] = self.domain
                c["secure"] = True
                c["samesite"] = "Lax"
            else:
                c["domain"] = ""
        return response
