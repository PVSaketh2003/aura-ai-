from django.contrib.auth import authenticate, get_user_model, login, logout
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from rest_framework import serializers, status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from apps.core.models import audit

User = get_user_model()


def _user(u):
    return {"id": u.id, "username": u.username, "display_name": u.first_name or u.username}


class Credentials(serializers.Serializer):
    username = serializers.CharField(max_length=150)
    password = serializers.CharField(max_length=256, trim_whitespace=False)
    display_name = serializers.CharField(max_length=150, required=False, allow_blank=True)
    setup_code = serializers.CharField(max_length=200, required=False, allow_blank=True, trim_whitespace=True)
    email = serializers.CharField(max_length=254, required=False, allow_blank=True)
    email_code = serializers.CharField(max_length=12, required=False, allow_blank=True)


def setup_verification() -> str:
    """How a fresh server's owner proves who they are: "email" (one-time code by email), "code" (SETUP_CODE from the
    hosting dashboard) or "none" (your own Mac)."""
    from config.env import get_settings

    from . import email_otp
    if email_otp.enabled():
        return "email"
    return "code" if get_settings().setup_code else "none"


@method_decorator(ensure_csrf_cookie, name="dispatch")
class SessionView(APIView):
    """Bootstraps the SPA: sets the CSRF cookie and reports auth / first-run state."""
    permission_classes = [AllowAny]

    def get(self, request):
        u = request.user
        from config.env import get_settings
        return Response({"authenticated": u.is_authenticated, "user": _user(u) if u.is_authenticated else None,
                         "setup_required": not User.objects.exists(), "setup_verification": setup_verification(),
                         "setup_code_required": setup_verification() == "code"})


@method_decorator(csrf_protect, name="dispatch")  # also for anonymous users: no login CSRF
class SetupView(APIView):
    """Creates the single owner account. Only allowed while no user exists."""
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth"

    def post(self, request):
        import hmac

        from config.env import get_settings
        data = Credentials(data=request.data)
        data.is_valid(raise_exception=True)
        from . import email_otp
        mode = setup_verification()
        email = ""
        if mode == "email":
            try:
                email = email_otp.normalize(data.validated_data.get("email") or data.validated_data["username"])
            except email_otp.EmailOTPError as e:
                return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)
            if not email_otp.owner_allowed(email) or not email_otp.check_code(email, data.validated_data.get("email_code", ""), "setup"):
                audit(None, "auth.setup_denied", email)
                return Response({"detail": "That code is wrong or has expired. Request a new one."}, status=status.HTTP_403_FORBIDDEN)
        code = get_settings().setup_code
        if mode == "code" and not hmac.compare_digest(code.encode(), data.validated_data.get("setup_code", "").encode()):
            audit(None, "auth.setup_denied", data.validated_data["username"])
            return Response({"detail": "That setup code isn't right. Find it in your hosting dashboard (SETUP_CODE)."},
                            status=status.HTTP_403_FORBIDDEN)
        with transaction.atomic():
            if User.objects.select_for_update().exists():
                return Response({"detail": "Setup already completed."}, status=status.HTTP_403_FORBIDDEN)
            u = User(username=email or data.validated_data["username"], email=email,
                     first_name=data.validated_data.get("display_name", ""))
            try:
                validate_password(data.validated_data["password"], u)
            except ValidationError as e:
                return Response({"detail": " ".join(e.messages)}, status=status.HTTP_400_BAD_REQUEST)
            u.set_password(data.validated_data["password"])
            u.is_staff = u.is_superuser = True
            u.save()
        login(request, u)
        audit(u, "auth.setup", u.username)
        return Response({"user": _user(u)}, status=status.HTTP_201_CREATED)


@method_decorator(csrf_protect, name="dispatch")  # also for anonymous users: no login CSRF
class LoginView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth"

    def post(self, request):
        data = Credentials(data=request.data)
        data.is_valid(raise_exception=True)
        name = data.validated_data["username"].strip()
        if "@" in name:  # sign in with the email address the account was created with
            name = (User.objects.filter(email__iexact=name).values_list("username", flat=True).first() or name)
        u = authenticate(request, username=name, password=data.validated_data["password"])
        if u is None:
            audit(None, "auth.login_failed", data.validated_data["username"])
            return Response({"detail": "Incorrect username or password."}, status=status.HTTP_400_BAD_REQUEST)
        login(request, u)
        audit(u, "auth.login", u.username)
        return Response({"user": _user(u)})


@method_decorator(csrf_protect, name="dispatch")  # also for anonymous users: no login CSRF
class LogoutView(APIView):
    def post(self, request):
        audit(request.user, "auth.logout", request.user.username)
        logout(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


@method_decorator(csrf_protect, name="dispatch")
class EmailCodeView(APIView):
    """Sends a one-time code by email. purpose "setup": only while the server has no owner yet, and only to an
    address in OWNER_EMAILS (so nobody else can claim a fresh server)."""
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth"

    def post(self, request):
        from . import email_otp
        if request.data.get("purpose", "setup") != "setup":
            return Response({"detail": "Unknown purpose."}, status=status.HTTP_400_BAD_REQUEST)
        if User.objects.exists():
            return Response({"detail": "Setup already completed. Sign in instead."}, status=status.HTTP_403_FORBIDDEN)
        try:
            email = email_otp.normalize(request.data.get("email", ""))
            if not email_otp.owner_allowed(email):
                return Response({"detail": "This email isn't allowed to own this Aura."}, status=status.HTTP_403_FORBIDDEN)
            email_otp.send_code(email, "setup", request.META.get("REMOTE_ADDR"))
        except email_otp.EmailOTPError as e:
            return Response({"detail": str(e)}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"sent": True, "email": email})
