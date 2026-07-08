import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Modal,
  Linking,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioRecorder, useAudioRecorderState, RecordingPresets, requestRecordingPermissionsAsync } from 'expo-audio';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase, apiFetch } from '../../../lib/supabase';
import { useAuth } from '../../../hooks/use-auth';
import { useRealtime } from '../../../hooks/use-realtime';
import { useAppTheme } from '../../../hooks/use-theme';
import { loadLifecycleStages } from '../../../lib/contacts/queries';
import { AudioMessage } from '../../../components/AudioMessage';
import { AuthedImage } from '../../../components/AuthedImage';
import {
  MEDIA_MAX_BYTES_BY_KIND,
  resolveOpenableUrl,
  uploadDirectMedia,
  uploadImageOrVideo,
  type PickedFile,
} from '../../../lib/media';
import { radius, scaleFontSizes, spacing, type Palette } from '../../../lib/theme';
import type { Message, Contact, LifecycleStage } from '../../../lib/types';

const sendSound = require('../../../assets/sounds/send.wav');
const receiveSound = require('../../../assets/sounds/receive.wav');

// Keeps each conversation's last-known messages in memory for the
// lifetime of the JS session (cleared on app restart, same as
// everything else client-side) — re-opening a chat you already looked
// at renders instantly from cache instead of waiting on a network
// round trip, matching WhatsApp's instant-open feel. Refreshed
// silently in the background every time the screen mounts.
const messageCache = new Map<string, Message[]>();

// A message still in flight — rendered immediately on send so the UI
// never waits on the Meta round-trip before showing feedback (matches
// WhatsApp's own "sent locally, then confirmed" feel). Reconciled away
// once the real row lands via realtime (see the INSERT handler below).
interface PendingMessage {
  tempId: string;
  content: string;
  createdAt: string;
  failed: boolean;
}

type ListItem =
  | { kind: 'date'; id: string; label: string }
  | { kind: 'message'; id: string; message: Message }
  | { kind: 'pending'; id: string; pending: PendingMessage };

type Styles = ReturnType<typeof makeStyles>;

function dateLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

async function openMediaUrl(url: string) {
  const opened = await resolveOpenableUrl(url);
  if (opened) Linking.openURL(opened).catch(() => {});
}

function MessageContent({ item, isAgent, styles, colors }: { item: Message; isAgent: boolean; styles: Styles; colors: Palette }) {
  if (item.content_type === 'audio' && item.media_url) {
    return <AudioMessage url={item.media_url} tint={isAgent ? 'agent' : 'customer'} />;
  }
  if (item.content_type === 'image' && item.media_url) {
    return (
      <Pressable onPress={() => openMediaUrl(item.media_url!)}>
        <AuthedImage url={item.media_url} style={styles.mediaImage} />
      </Pressable>
    );
  }
  if (item.content_type === 'video' && item.media_url) {
    return (
      <Pressable style={styles.videoCard} onPress={() => openMediaUrl(item.media_url!)}>
        <Ionicons name="videocam" size={22} color={isAgent ? colors.bubbleAgentText : colors.textSecondary} />
        <Text style={isAgent ? styles.bubbleTextAgent : styles.bubbleTextCustomer}>Video — tap to open</Text>
      </Pressable>
    );
  }
  if (item.content_type === 'document' && item.media_url) {
    return (
      <Pressable style={styles.documentCard} onPress={() => openMediaUrl(item.media_url!)}>
        <Ionicons name="document-text" size={22} color={isAgent ? colors.bubbleAgentText : colors.textSecondary} />
        <Text
          style={isAgent ? styles.bubbleTextAgent : styles.bubbleTextCustomer}
          numberOfLines={1}
        >
          {item.content_text || 'Document'}
        </Text>
      </Pressable>
    );
  }
  return (
    <Text style={isAgent ? styles.bubbleTextAgent : styles.bubbleTextCustomer}>
      {item.content_text || `[${item.content_type}]`}
    </Text>
  );
}

const MessageBubble = memo(function MessageBubble({
  item,
  colors,
  styles,
}: {
  item: Message;
  colors: Palette;
  styles: Styles;
}) {
  const isAgent = item.sender_type === 'agent' || item.sender_type === 'bot';
  return (
    <View style={[styles.bubbleRow, isAgent ? styles.bubbleRowAgent : styles.bubbleRowCustomer]}>
      <View style={[styles.bubble, isAgent ? styles.bubbleAgent : styles.bubbleCustomer]}>
        <MessageContent item={item} isAgent={isAgent} styles={styles} colors={colors} />
        <View style={styles.bubbleFooter}>
          <Text style={isAgent ? styles.bubbleTimeAgent : styles.bubbleTimeCustomer}>
            {new Date(item.created_at).toLocaleTimeString(undefined, {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
          {isAgent && item.status && (
            <Ionicons
              name={
                item.status === 'failed'
                  ? 'alert-circle'
                  : item.status === 'read'
                    ? 'checkmark-done'
                    : item.status === 'delivered'
                      ? 'checkmark-done'
                      : 'checkmark'
              }
              size={13}
              color={
                item.status === 'failed'
                  ? colors.dangerMuted
                  : item.status === 'read'
                    ? colors.info
                    : colors.bubbleAgentMeta
              }
              style={{ marginLeft: 4 }}
            />
          )}
        </View>
        {item.status === 'failed' && (
          <Text style={styles.failedText}>Failed{item.error_message ? `: ${item.error_message}` : ''}</Text>
        )}
      </View>
    </View>
  );
});

const PendingBubble = memo(function PendingBubble({
  pending,
  colors,
  styles,
}: {
  pending: PendingMessage;
  colors: Palette;
  styles: Styles;
}) {
  return (
    <View style={[styles.bubbleRow, styles.bubbleRowAgent]}>
      <View style={[styles.bubble, styles.bubbleAgent, pending.failed && styles.bubbleFailed]}>
        <Text style={styles.bubbleTextAgent}>{pending.content}</Text>
        <View style={styles.bubbleFooter}>
          {pending.failed ? (
            <Ionicons name="alert-circle" size={13} color={colors.dangerMuted} />
          ) : (
            <Ionicons name="time-outline" size={12} color={colors.bubbleAgentMeta} />
          )}
        </View>
        {pending.failed && <Text style={styles.failedText}>Failed to send — tap to retry</Text>}
      </View>
    </View>
  );
});

const DateSeparator = memo(function DateSeparator({ label, styles }: { label: string; styles: Styles }) {
  return (
    <View style={styles.dateSeparator}>
      <Text style={styles.dateSeparatorText}>{label}</Text>
    </View>
  );
});

export default function MessageThreadScreen() {
  const params = useLocalSearchParams<{
    id: string;
    name?: string;
    phone?: string;
    stageName?: string;
    stageColor?: string;
  }>();
  const conversationId = params.id;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { accountId } = useAuth();
  const { colors, fontScale } = useAppTheme();
  const styles = useMemo(() => scaleFontSizes(makeStyles(colors), fontScale), [colors, fontScale]);

  const [messages, setMessages] = useState<Message[]>(() => messageCache.get(conversationId) ?? []);
  const [messagesReady, setMessagesReady] = useState(() => messageCache.has(conversationId));
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [contact, setContact] = useState<Contact | null>(null);
  const [stages, setStages] = useState<LifecycleStage[]>([]);
  const [text, setText] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [stagePickerOpen, setStagePickerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [attachOpen, setAttachOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [mediaViewerOpen, setMediaViewerOpen] = useState(false);
  const [sharedMedia, setSharedMedia] = useState<Message[] | null>(null);
  const listRef = useRef<FlatList<ListItem>>(null);

  const sendPlayer = useAudioPlayer(sendSound);
  const receivePlayer = useAudioPlayer(receiveSound);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 200);

  const fetchMessages = useCallback(async () => {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(100);

    if (error) {
      console.error('[Thread] fetch messages error:', error.message);
      setMessagesReady(true);
      return;
    }
    const rows = (data as Message[]) ?? [];
    messageCache.set(conversationId, rows);
    setMessages(rows);
    setMessagesReady(true);
  }, [conversationId]);

  const fetchContact = useCallback(async () => {
    const { data: conv } = await supabase
      .from('conversations')
      .select('unread_count, contact:contacts(*)')
      .eq('id', conversationId)
      .maybeSingle();

    const contactRow = conv?.contact as unknown as Contact | null;
    setContact(contactRow);

    if (conv && conv.unread_count > 0) {
      await supabase.from('conversations').update({ unread_count: 0 }).eq('id', conversationId);
    }
  }, [conversationId]);

  // Fires in parallel, never blocking the initial paint — the header
  // and composer render instantly (from route params + cache), these
  // just refresh them in the background.
  useEffect(() => {
    void fetchMessages();
    void fetchContact();
    loadLifecycleStages(supabase).then(setStages).catch(console.error);
  }, [fetchMessages, fetchContact]);

  useRealtime({
    channelName: `mobile-thread-${conversationId}`,
    messagesFilter: `conversation_id=eq.${conversationId}`,
    onMessageEvent: (event) => {
      const row = event.new as Message;
      if (row.conversation_id !== conversationId) return;
      if (event.eventType === 'INSERT') {
        setMessages((prev) => {
          if (prev.some((m) => m.id === row.id)) return prev;
          const next = [...prev, row];
          messageCache.set(conversationId, next);
          return next;
        });
        if (row.sender_type === 'customer') {
          receivePlayer.seekTo(0);
          receivePlayer.play();
        } else if (row.sender_type === 'agent' || row.sender_type === 'bot') {
          // The real row arrived — drop the oldest matching pending
          // bubble so we don't show the same text twice.
          setPending((prev) => {
            const idx = prev.findIndex((p) => p.content === row.content_text);
            if (idx === -1) return prev;
            return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
          });
        }
        setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
      } else if (event.eventType === 'UPDATE') {
        setMessages((prev) => {
          const next = prev.map((m) => (m.id === row.id ? row : m));
          messageCache.set(conversationId, next);
          return next;
        });
      }
    },
  });

  async function sendText(content: string, replacePendingId?: string) {
    setSendError(null);
    try {
      const res = await apiFetch('/api/whatsapp/send', {
        method: 'POST',
        body: JSON.stringify({
          conversation_id: conversationId,
          message_type: 'text',
          content_text: content,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setSendError(body.error || 'Failed to send message');
        setPending((prev) =>
          prev.map((p) =>
            p.tempId === replacePendingId || (!replacePendingId && p.content === content)
              ? { ...p, failed: true }
              : p,
          ),
        );
        return;
      }
      // Success: the real row lands via realtime and reconciles the
      // pending bubble away. Nothing to do here.
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send message');
      setPending((prev) =>
        prev.map((p) => (p.tempId === replacePendingId ? { ...p, failed: true } : p)),
      );
    }
  }

  async function sendMedia(
    kind: 'image' | 'video' | 'document' | 'audio',
    mediaUrl: string,
    contentText?: string,
  ) {
    setSendError(null);
    try {
      const res = await apiFetch('/api/whatsapp/send', {
        method: 'POST',
        body: JSON.stringify({
          conversation_id: conversationId,
          message_type: kind,
          media_url: mediaUrl,
          content_text: contentText,
          filename: kind === 'document' ? contentText : undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setSendError(body.error || 'Failed to send message');
        return;
      }
      sendPlayer.seekTo(0);
      sendPlayer.play();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send message');
    }
  }

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || contact?.blocked_at) return;
    setText('');
    sendPlayer.seekTo(0);
    sendPlayer.play();
    const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setPending((prev) => [
      ...prev,
      { tempId, content: trimmed, createdAt: new Date().toISOString(), failed: false },
    ]);
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    void sendText(trimmed, tempId);
  }

  function retryPending(item: PendingMessage) {
    setPending((prev) => prev.map((p) => (p.tempId === item.tempId ? { ...p, failed: false } : p)));
    void sendText(item.content, item.tempId);
  }

  async function handlePickImageOrVideo() {
    setAttachOpen(false);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setSendError('Photo library access is required to send media.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.8,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const kind: 'image' | 'video' = asset.type === 'video' ? 'video' : 'image';
    const max = MEDIA_MAX_BYTES_BY_KIND[kind];
    if (asset.fileSize && asset.fileSize > max) {
      setSendError(`File is too large — ${kind} limit is ${Math.round(max / 1024 / 1024)} MB.`);
      return;
    }
    const file: PickedFile = {
      uri: asset.uri,
      name: asset.fileName || `${kind}-${Date.now()}.${kind === 'image' ? 'jpg' : 'mp4'}`,
      mimeType: asset.mimeType || (kind === 'image' ? 'image/jpeg' : 'video/mp4'),
      size: asset.fileSize ?? undefined,
    };
    setUploading(true);
    try {
      const { publicUrl } = await uploadImageOrVideo(file, kind);
      await sendMedia(kind, publicUrl);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function handlePickDocument() {
    setAttachOpen(false);
    if (!accountId) return;
    const result = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const max = MEDIA_MAX_BYTES_BY_KIND.document;
    if (asset.size && asset.size > max) {
      setSendError(`File is too large — document limit is ${Math.round(max / 1024 / 1024)} MB.`);
      return;
    }
    setUploading(true);
    try {
      const { publicUrl } = await uploadDirectMedia(
        { uri: asset.uri, name: asset.name, mimeType: asset.mimeType || 'application/octet-stream', size: asset.size },
        accountId,
      );
      await sendMedia('document', publicUrl, asset.name);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function startRecording() {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      setSendError('Microphone access is required to record a voice message.');
      return;
    }
    setSendError(null);
    await recorder.prepareToRecordAsync();
    recorder.record();
  }

  async function cancelRecording() {
    await recorder.stop().catch(() => {});
  }

  async function finishRecording() {
    await recorder.stop();
    const uri = recorder.uri;
    if (!uri || !accountId) return;
    setUploading(true);
    try {
      const { publicUrl } = await uploadDirectMedia(
        { uri, name: `voice-${Date.now()}.m4a`, mimeType: 'audio/mp4' },
        accountId,
      );
      await sendMedia('audio', publicUrl);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function handleChangeStage(stage: LifecycleStage | null) {
    if (!contact) return;
    setStagePickerOpen(false);
    const { error } = await supabase
      .from('contacts')
      .update({ lifecycle_stage_id: stage?.id ?? null })
      .eq('id', contact.id);
    if (!error) {
      setContact({ ...contact, lifecycle_stage_id: stage?.id ?? null, lifecycle_stage: stage });
    }
  }

  async function handleToggleBlock() {
    if (!contact) return;
    setMenuOpen(false);
    const blocking = !contact.blocked_at;
    const { error } = await supabase
      .from('contacts')
      .update({ blocked_at: blocking ? new Date().toISOString() : null })
      .eq('id', contact.id);
    if (!error) {
      setContact({ ...contact, blocked_at: blocking ? new Date().toISOString() : null });
    }
  }

  async function handleOpenSharedMedia() {
    setMenuOpen(false);
    setMediaViewerOpen(true);
    if (sharedMedia !== null) return; // already loaded once this session
    const { data } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .in('content_type', ['image', 'video', 'document'])
      .order('created_at', { ascending: false })
      .limit(60);
    setSharedMedia((data as Message[]) ?? []);
  }

  // Flattens messages + in-flight pending bubbles into one list with
  // WhatsApp-style date separators inserted between day boundaries.
  const listData = useMemo<ListItem[]>(() => {
    const term = searchQuery.trim().toLowerCase();
    const visibleMessages = term
      ? messages.filter((m) => m.content_text?.toLowerCase().includes(term))
      : messages;

    const items: ListItem[] = [];
    let lastDay: string | null = null;
    for (const m of visibleMessages) {
      const day = dateLabel(m.created_at);
      if (day !== lastDay) {
        items.push({ kind: 'date', id: `date-${day}-${m.id}`, label: day });
        lastDay = day;
      }
      items.push({ kind: 'message', id: m.id, message: m });
    }
    if (!term) {
      for (const p of pending) {
        items.push({ kind: 'pending', id: p.tempId, pending: p });
      }
    }
    return items;
  }, [messages, pending, searchQuery]);

  const isSearching = searchQuery.trim().length > 0;

  // Instant header: the real `contact` record (once fetched) always
  // wins, but until then we render from what the inbox list already
  // knew (passed via route params) instead of a blank/loading state.
  const headerName = contact ? contact.name || contact.phone || 'Conversation' : params.name || params.phone || 'Conversation';
  const headerStageName = contact ? contact.lifecycle_stage?.name ?? null : params.stageName || null;
  const headerStageColor = contact ? contact.lifecycle_stage?.color ?? colors.borderStrong : params.stageColor || colors.borderStrong;
  const isRecording = recorderState.isRecording;
  const recordSeconds = Math.floor((recorderState.durationMillis ?? 0) / 1000);

  return (
    // On Android this screen relies purely on the native
    // `windowSoftInputMode="adjustPan"` (set in app.json) to keep the
    // composer above the keyboard. Also running KeyboardAvoidingView's
    // own JS-side compensation here — on top of the OS already panning
    // the whole window — double-shifted the layout and hid the
    // composer behind the keyboard entirely. iOS has no native
    // equivalent, so it still needs the JS-side "padding" behavior.
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <View style={[styles.customHeader, { paddingTop: insets.top + spacing.sm }]}>
        <View style={styles.headerTopRow}>
          <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backButton}>
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </Pressable>
          <Text style={styles.headerName} numberOfLines={1}>
            {headerName}
          </Text>
          <View style={styles.headerActions}>
            <Pressable
              style={styles.headerIconButton}
              onPress={() => setSearchOpen((v) => !v)}
              hitSlop={8}
            >
              <Ionicons name={searchOpen ? 'close' : 'search'} size={20} color={colors.textSecondary} />
            </Pressable>
            <Pressable style={styles.headerIconButton} onPress={() => setMenuOpen(true)} hitSlop={8}>
              <Ionicons name="ellipsis-vertical" size={20} color={colors.textSecondary} />
            </Pressable>
          </View>
        </View>
        <Pressable
          style={styles.stagePill}
          onPress={() => setStagePickerOpen(true)}
        >
          <View style={[styles.stageDot, { backgroundColor: headerStageColor }]} />
          <Text style={styles.stagePillText} numberOfLines={1}>
            {headerStageName ?? 'Set stage'}
          </Text>
          <Ionicons name="chevron-down" size={12} color={colors.textFaint} />
        </Pressable>
      </View>

      {searchOpen && (
        <View style={styles.searchRow}>
          <Ionicons name="search" size={16} color={colors.textFaint} style={{ marginRight: spacing.sm }} />
          <TextInput
            autoFocus
            style={styles.searchInput}
            placeholder="Search in this chat…"
            placeholderTextColor={colors.textFaint}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
          {isSearching && (
            <Text style={styles.searchCount}>
              {listData.filter((i) => i.kind === 'message').length}
            </Text>
          )}
        </View>
      )}

      {contact?.blocked_at && (
        <View style={styles.blockedBanner}>
          <Ionicons name="ban" size={14} color={colors.dangerMuted} />
          <Text style={styles.blockedBannerText}>You've blocked this contact — sending is disabled.</Text>
        </View>
      )}

      {!messagesReady ? (
        <View style={[styles.center, styles.messageList]}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          style={styles.messageList}
          data={listData}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          onContentSizeChange={() => !isSearching && listRef.current?.scrollToEnd({ animated: false })}
          renderItem={({ item }) => {
            if (item.kind === 'date') return <DateSeparator label={item.label} styles={styles} />;
            if (item.kind === 'pending') {
              return (
                <Pressable
                  onPress={() => item.pending.failed && retryPending(item.pending)}
                  disabled={!item.pending.failed}
                >
                  <PendingBubble pending={item.pending} colors={colors} styles={styles} />
                </Pressable>
              );
            }
            return <MessageBubble item={item.message} colors={colors} styles={styles} />;
          }}
          ListEmptyComponent={
            isSearching ? (
              <View style={styles.center}>
                <Text style={styles.emptyText}>No messages match &quot;{searchQuery}&quot;</Text>
              </View>
            ) : null
          }
          initialNumToRender={20}
          maxToRenderPerBatch={20}
          windowSize={10}
        />
      )}

      {sendError && (
        <View style={styles.errorBar}>
          <Text style={styles.errorBarText}>{sendError}</Text>
        </View>
      )}

      {!contact?.blocked_at && (
        <View style={styles.composer}>
          {isRecording ? (
            <View style={styles.recordingRow}>
              <Pressable onPress={cancelRecording} hitSlop={8} style={styles.recordingCancel}>
                <Ionicons name="trash-outline" size={20} color={colors.dangerMuted} />
              </Pressable>
              <View style={styles.recordingIndicator}>
                <View style={styles.recordingDot} />
                <Text style={styles.recordingTime}>
                  {Math.floor(recordSeconds / 60)}:{(recordSeconds % 60).toString().padStart(2, '0')}
                </Text>
              </View>
              <Pressable
                style={({ pressed }) => [styles.sendButton, pressed && styles.sendButtonPressed]}
                onPress={finishRecording}
              >
                <Ionicons name="send" size={17} color={colors.white} />
              </Pressable>
            </View>
          ) : (
            <>
              <Pressable style={styles.attachButton} onPress={() => setAttachOpen(true)} hitSlop={8} disabled={uploading}>
                {uploading ? (
                  <ActivityIndicator size="small" color={colors.textFaint} />
                ) : (
                  <Ionicons name="add-circle-outline" size={26} color={colors.textFaint} />
                )}
              </Pressable>
              <TextInput
                style={styles.composerInput}
                placeholder="Type a message…"
                placeholderTextColor={colors.textFaint}
                value={text}
                onChangeText={setText}
                multiline
              />
              {text.trim() ? (
                <Pressable
                  style={({ pressed }) => [styles.sendButton, pressed && styles.sendButtonPressed]}
                  onPress={handleSend}
                >
                  <Ionicons name="send" size={17} color={colors.white} />
                </Pressable>
              ) : (
                <Pressable
                  style={({ pressed }) => [styles.sendButton, pressed && styles.sendButtonPressed]}
                  onPress={startRecording}
                >
                  <Ionicons name="mic" size={19} color={colors.white} />
                </Pressable>
              )}
            </>
          )}
        </View>
      )}

      {/* Attachment picker sheet */}
      <Modal visible={attachOpen} transparent animationType="fade" onRequestClose={() => setAttachOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setAttachOpen(false)}>
          <View style={styles.menuCard}>
            <Pressable style={styles.menuItem} onPress={handlePickImageOrVideo}>
              <Ionicons name="image-outline" size={20} color={colors.textSecondary} />
              <Text style={styles.menuItemText}>Photo or Video</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={handlePickDocument}>
              <Ionicons name="document-outline" size={20} color={colors.textSecondary} />
              <Text style={styles.menuItemText}>Document</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* 3-dot action menu */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setMenuOpen(false)}>
          <View style={styles.menuCard}>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenuOpen(false);
                if (contact) router.push(`/contacts/${contact.id}`);
              }}
            >
              <Ionicons name="person-circle-outline" size={20} color={colors.textSecondary} />
              <Text style={styles.menuItemText}>View Contact Profile</Text>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                setMenuOpen(false);
                setStagePickerOpen(true);
              }}
            >
              <Ionicons name="pricetag-outline" size={20} color={colors.textSecondary} />
              <Text style={styles.menuItemText}>Change Lifecycle Stage</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={handleOpenSharedMedia}>
              <Ionicons name="images-outline" size={20} color={colors.textSecondary} />
              <Text style={styles.menuItemText}>Media, Links and Docs</Text>
            </Pressable>
            <Pressable style={styles.menuItem} onPress={handleToggleBlock}>
              <Ionicons
                name={contact?.blocked_at ? 'checkmark-circle-outline' : 'ban-outline'}
                size={20}
                color={contact?.blocked_at ? colors.success : colors.dangerMuted}
              />
              <Text
                style={[styles.menuItemText, { color: contact?.blocked_at ? colors.success : colors.dangerMuted }]}
              >
                {contact?.blocked_at ? 'Unblock Contact' : 'Block Contact'}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Lifecycle stage picker */}
      <Modal
        visible={stagePickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setStagePickerOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setStagePickerOpen(false)}>
          <View style={styles.menuCard}>
            <Text style={styles.menuTitle}>Lifecycle Stage</Text>
            <Pressable style={styles.menuItem} onPress={() => handleChangeStage(null)}>
              <View style={[styles.stageDot, { backgroundColor: colors.borderStrong }]} />
              <Text style={styles.menuItemText}>Unassigned</Text>
            </Pressable>
            {stages.map((s) => (
              <Pressable key={s.id} style={styles.menuItem} onPress={() => handleChangeStage(s)}>
                <View style={[styles.stageDot, { backgroundColor: s.color }]} />
                <Text style={styles.menuItemText}>{s.name}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>

      {/* Shared media viewer */}
      <Modal
        visible={mediaViewerOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setMediaViewerOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setMediaViewerOpen(false)}>
          <Pressable style={styles.mediaViewerCard} onPress={(e) => e.stopPropagation()}>
            <View style={styles.mediaViewerHeader}>
              <Text style={styles.menuTitle}>Media, Links and Docs</Text>
              <Pressable onPress={() => setMediaViewerOpen(false)} hitSlop={8}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </Pressable>
            </View>
            {sharedMedia === null ? (
              <ActivityIndicator color={colors.accent} style={{ marginVertical: spacing.xl }} />
            ) : sharedMedia.length === 0 ? (
              <Text style={styles.emptyText}>No shared media yet</Text>
            ) : (
              <FlatList
                data={sharedMedia}
                keyExtractor={(item) => item.id}
                numColumns={3}
                columnWrapperStyle={{ gap: spacing.xs }}
                contentContainerStyle={{ gap: spacing.xs, paddingBottom: spacing.xl }}
                renderItem={({ item }) => (
                  <Pressable style={styles.mediaGridItem} onPress={() => item.media_url && openMediaUrl(item.media_url)}>
                    {item.content_type === 'image' && item.media_url ? (
                      <AuthedImage url={item.media_url} style={styles.mediaGridImage} />
                    ) : (
                      <View style={styles.mediaGridPlaceholder}>
                        <Ionicons
                          name={item.content_type === 'video' ? 'videocam' : 'document-text'}
                          size={26}
                          color={colors.textFaint}
                        />
                        {item.content_type === 'document' && (
                          <Text style={styles.mediaGridLabel} numberOfLines={2}>
                            {item.content_text || 'Document'}
                          </Text>
                        )}
                      </View>
                    )}
                  </Pressable>
                )}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    customHeader: {
      paddingHorizontal: spacing.sm + 2,
      paddingBottom: spacing.sm,
      backgroundColor: colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: spacing.sm,
    },
    headerTopRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    backButton: { padding: 4 },
    headerName: {
      flex: 1,
      color: colors.text,
      fontSize: 17,
      fontWeight: '700',
    },
    stagePill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      backgroundColor: colors.bg,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.sm + 2,
      paddingVertical: 5,
      marginLeft: spacing.xl + spacing.sm,
      borderWidth: 1,
      borderColor: colors.border,
      maxWidth: '70%',
    },
    stagePillText: { color: colors.textSecondary, fontSize: 12, fontWeight: '500', flexShrink: 1 },
    headerActions: { flexDirection: 'row', gap: spacing.sm },
    headerIconButton: { padding: 4 },
    searchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    searchInput: { flex: 1, color: colors.text, fontSize: 14, paddingVertical: 4 },
    searchCount: { color: colors.textFaint, fontSize: 12, marginLeft: spacing.sm },
    blockedBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: colors.dangerBg,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    blockedBannerText: { color: colors.dangerMuted, fontSize: 12, flex: 1 },
    messageList: { flex: 1, backgroundColor: colors.chatBg },
    listContent: { padding: spacing.md, gap: 6 },
    dateSeparator: { alignItems: 'center', marginVertical: spacing.sm },
    dateSeparatorText: {
      color: colors.textFaint,
      fontSize: 11,
      fontWeight: '600',
      backgroundColor: colors.surface,
      paddingHorizontal: spacing.md,
      paddingVertical: 4,
      borderRadius: radius.pill,
      overflow: 'hidden',
    },
    bubbleRow: { flexDirection: 'row' },
    bubbleRowAgent: { justifyContent: 'flex-end' },
    bubbleRowCustomer: { justifyContent: 'flex-start' },
    bubble: {
      maxWidth: '80%',
      borderRadius: radius.md + 2,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      shadowColor: '#000',
      shadowOpacity: 0.15,
      shadowRadius: 3,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
    },
    bubbleAgent: {
      backgroundColor: colors.bubbleAgentBg,
      borderBottomRightRadius: 4,
    },
    bubbleFailed: { opacity: 0.6 },
    bubbleCustomer: {
      backgroundColor: colors.bubbleCustomerBg,
      borderBottomLeftRadius: 4,
    },
    bubbleTextAgent: { color: colors.bubbleAgentText, fontSize: 15 },
    bubbleTextCustomer: { color: colors.textSecondary, fontSize: 15 },
    bubbleFooter: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginTop: 3 },
    bubbleTimeAgent: { color: colors.bubbleAgentMeta, fontSize: 10 },
    bubbleTimeCustomer: { color: colors.textFaint, fontSize: 10 },
    failedText: { color: colors.dangerMuted, fontSize: 11, marginTop: 4 },
    emptyText: { color: colors.textFaint, fontSize: 13, textAlign: 'center', marginVertical: spacing.lg },
    errorBar: {
      backgroundColor: colors.dangerBg,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
    },
    errorBarText: { color: colors.dangerMuted, fontSize: 12 },
    composer: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      padding: spacing.sm + 2,
      gap: spacing.sm,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.surface,
    },
    attachButton: { padding: 4, marginBottom: 4 },
    composerInput: {
      flex: 1,
      backgroundColor: colors.bg,
      borderRadius: 20,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm + 2,
      color: colors.text,
      fontSize: 15,
      maxHeight: 100,
      borderWidth: 1,
      borderColor: colors.border,
    },
    sendButton: {
      backgroundColor: colors.primary,
      borderRadius: 20,
      width: 42,
      height: 42,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendButtonPressed: { opacity: 0.85 },
    sendButtonDisabled: { opacity: 0.5 },
    recordingRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    recordingCancel: { padding: 4 },
    recordingIndicator: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    recordingDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.danger },
    recordingTime: { color: colors.textSecondary, fontSize: 14, fontVariant: ['tabular-nums'] },
    mediaImage: { width: 220, height: 220, borderRadius: radius.sm },
    videoCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minWidth: 160,
    },
    documentCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minWidth: 160,
      maxWidth: 220,
    },
    modalBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
    },
    menuCard: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.xl,
      gap: 4,
      maxHeight: '70%',
    },
    menuTitle: {
      color: colors.textFaint,
      fontSize: 12,
      fontWeight: '600',
      textTransform: 'uppercase',
      marginBottom: spacing.sm,
      marginTop: spacing.xs,
    },
    menuItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    menuItemText: { color: colors.textSecondary, fontSize: 15 },
    stageDot: { width: 8, height: 8, borderRadius: 4 },
    mediaViewerCard: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.xl,
      maxHeight: '75%',
    },
    mediaViewerHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.sm,
    },
    mediaGridItem: {
      flex: 1 / 3,
      aspectRatio: 1,
      borderRadius: radius.sm,
      overflow: 'hidden',
    },
    mediaGridImage: { width: '100%', height: '100%' },
    mediaGridPlaceholder: {
      flex: 1,
      backgroundColor: colors.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.xs,
      gap: 4,
    },
    mediaGridLabel: { color: colors.textFaint, fontSize: 10, textAlign: 'center' },
  });
}
