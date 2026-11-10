from django.contrib import admin
from django.urls import include, path

from apps.documents.galaxy import GalaxyView
from apps.messenger import views as messenger
from apps.speech.free_talk import FreeTalkSegmentView, FreeTalkSessionsView, FreeTalkSessionView
from apps.speech.profile import VoiceProfileView, VoiceSampleView

from apps.agent.views import ChatView, VoiceRetryView, VoiceView
from apps.authentication import views as auth
from apps.conversations.views import ConversationDetailView, ConversationListView, FeedbackView
from apps.documents import views as docs
from apps.execution_traces.views import ActiveRunsView, ExecutionDetailView
from apps.local_connector import views as la
from apps.memory import views as mem
from apps.preferences.views import PreferencesView
from apps.speech.views import AudioView, TranscribeView, WarmView
from apps.system.views import HealthView

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/health/", HealthView.as_view()),
    path("api/messenger/", include("apps.messenger.urls")),
    path("api/auth/phone/start/", messenger.PhoneStartView.as_view()),
    path("api/auth/phone/register/", messenger.PhoneRegisterView.as_view()),
    path("api/auth/phone/login/", messenger.PhoneLoginView.as_view()),
    path("api/auth/session/", auth.SessionView.as_view()),
    path("api/auth/setup/", auth.SetupView.as_view()),
    path("api/auth/email-code/", auth.EmailCodeView.as_view()),
    path("api/auth/login/", auth.LoginView.as_view()),
    path("api/auth/logout/", auth.LogoutView.as_view()),
    path("api/speech/transcribe/", TranscribeView.as_view()),
    path("api/speech/warm/", WarmView.as_view()),
    path("api/voice-profile/", VoiceProfileView.as_view()),
    path("api/voice-profile/samples/", VoiceSampleView.as_view()),
    path("api/voice-profile/samples/<uuid:sample_id>/", VoiceSampleView.as_view()),
    path("api/voice-profile/free/", FreeTalkSessionsView.as_view()),
    path("api/voice-profile/free/<uuid:session_id>/", FreeTalkSessionView.as_view()),
    path("api/voice-profile/free/segments/<uuid:segment_id>/", FreeTalkSegmentView.as_view()),
    path("api/speech/audio/<uuid:message_id>/", AudioView.as_view()),
    path("api/speech/audio/<uuid:message_id>/<int:segment>/", AudioView.as_view()),
    path("api/agent/chat/", ChatView.as_view()),
    path("api/agent/voice/", VoiceView.as_view()),
    path("api/agent/voice/retry/", VoiceRetryView.as_view()),
    path("api/agent/execution/<uuid:execution_id>/", ExecutionDetailView.as_view()),
    path("api/agent/runs/active/", ActiveRunsView.as_view()),
    path("api/conversations/", ConversationListView.as_view()),
    path("api/conversations/<uuid:conversation_id>/", ConversationDetailView.as_view()),
    path("api/messages/<uuid:message_id>/feedback/", FeedbackView.as_view()),
    path("api/documents/", docs.DocumentListView.as_view()),
    path("api/documents/ingest/", docs.IngestView.as_view()),
    path("api/documents/galaxy/", GalaxyView.as_view()),
    path("api/documents/<uuid:document_id>/", docs.DocumentDetailView.as_view()),
    path("api/documents/<uuid:document_id>/reindex/", docs.ReindexView.as_view()),
    path("api/memory/", mem.MemoryListView.as_view()),
    path("api/memory/save/", mem.MemorySaveView.as_view()),
    path("api/memory/search/", mem.MemorySearchView.as_view()),
    path("api/memory/rebuild/", mem.MemoryRebuildView.as_view()),
    path("api/memory/<uuid:memory_id>/", mem.MemoryDetailView.as_view()),
    path("api/settings/", PreferencesView.as_view()),
    path("api/local-agent/", la.LocalAgentStatusView.as_view()),
    path("api/local-agent/roots/", la.LocalAgentRootsView.as_view()),
    path("api/local-agent/upload/<str:request_id>/", la.upload),
]
