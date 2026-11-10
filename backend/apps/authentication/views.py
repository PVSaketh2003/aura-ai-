from django.contrib.auth import authenticate, get_user_model, login, logout
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import ensure_csrf_cookie
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


@method_decorator(ensure_csrf_cookie, name="dispatch")
class SessionView(APIView):
    """Bootstraps the SPA: sets the CSRF cookie and reports auth / first-run state."""
    permission_classes = [AllowAny]

    def get(self, request):
        u = request.user
        return Response({"authenticated": u.is_authenticated, "user": _user(u) if u.is_authenticated else None,
                         "setup_required": not User.objects.exists()})


class SetupView(APIView):
    """Creates the single owner account. Only allowed while no user exists."""
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth"

    def post(self, request):
        data = Credentials(data=request.data)
        data.is_valid(raise_exception=True)
        with transaction.atomic():
            if User.objects.select_for_update().exists():
                return Response({"detail": "Setup already completed."}, status=status.HTTP_403_FORBIDDEN)
            u = User(username=data.validated_data["username"], first_name=data.validated_data.get("display_name", ""))
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


class LoginView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "auth"

    def post(self, request):
        data = Credentials(data=request.data)
        data.is_valid(raise_exception=True)
        u = authenticate(request, username=data.validated_data["username"], password=data.validated_data["password"])
        if u is None:
            audit(None, "auth.login_failed", data.validated_data["username"])
            return Response({"detail": "Incorrect username or password."}, status=status.HTTP_400_BAD_REQUEST)
        login(request, u)
        audit(u, "auth.login", u.username)
        return Response({"user": _user(u)})


class LogoutView(APIView):
    def post(self, request):
        audit(request.user, "auth.logout", request.user.username)
        logout(request)
        return Response(status=status.HTTP_204_NO_CONTENT)
