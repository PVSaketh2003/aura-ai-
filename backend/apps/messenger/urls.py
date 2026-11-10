from django.urls import path

from . import views as v

urlpatterns = [
    path("me/", v.MeView.as_view()),
    path("me/phone/", v.LinkPhoneView.as_view()),
    path("contacts/", v.ContactsView.as_view()),
    path("contacts/<uuid:cid>/", v.ContactView.as_view()),
    path("lookup/", v.LookupView.as_view()),
    path("chats/", v.ChatsView.as_view()),
    path("chats/direct/", v.DirectChatView.as_view()),
    path("chats/group/", v.GroupCreateView.as_view()),
    path("chats/<uuid:chat_id>/", v.ChatView.as_view()),
    path("chats/<uuid:chat_id>/request/<str:action>/", v.RequestView.as_view()),
    path("chats/<uuid:chat_id>/members/", v.MembersView.as_view()),
    path("chats/<uuid:chat_id>/members/<int:user_id>/", v.MemberView.as_view()),
    path("chats/<uuid:chat_id>/messages/", v.MessagesView.as_view()),
    path("chats/<uuid:chat_id>/read/", v.ReadView.as_view()),
    path("chats/<uuid:chat_id>/ai/", v.ChatAIView.as_view()),
    path("messages/<uuid:message_id>/", v.MessageView.as_view()),
    path("messages/<uuid:message_id>/react/", v.ReactView.as_view()),
    path("messages/<uuid:message_id>/forward/", v.ForwardView.as_view()),
    path("uploads/", v.UploadView.as_view()),
    path("attachments/<uuid:attachment_id>/", v.AttachmentView.as_view()),
    path("media/", v.MediaView.as_view()),
    path("search/", v.SearchView.as_view()),
    path("blocks/", v.BlocksView.as_view()),
    path("blocks/<int:user_id>/", v.BlockView.as_view()),
    path("reports/", v.ReportView.as_view()),
    path("calls/", v.CallsView.as_view()),
    path("calls/<uuid:call_id>/<str:action>/", v.CallActionView.as_view()),
]
