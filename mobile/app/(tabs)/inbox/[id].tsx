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
  PanResponder,
  Animated,
} from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
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
import { Avatar } from '../../../components/Avatar';
import { setActiveConversationId } from '../../../lib/active-conversation';
import {
  ensureForwardableMediaUrl,
  MEDIA_MAX_BYTES_BY_KIND,
  resolveOpenableUrl,
  uploadDirectMedia,
  uploadImageOrVideo,
  type PickedFile,
} from '../../../lib/media';
import { radius, scaleFontSizes, spacing, type Palette } from '../../../lib/theme';
import type { Message, Contact, Conversation, ConversationOwnerKind, LifecycleStage } from '../../../lib/types';

interface TeamMember {
  user_id: string;
  full_name: string;
  email: string | null;
}

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

function MessageContent({
  item,
  isAgent,
  styles,
  colors,
  onPreviewImage,
}: {
  item: Message;
  isAgent: boolean;
  styles: Styles;
  colors: Palette;
  onPreviewImage: (message: Message) => void;
}) {
  if (item.content_type === 'audio' && item.media_url) {
    return <AudioMessage url={item.media_url} tint={isAgent ? 'agent' : 'customer'} />;
  }
  if (item.content_type === 'image' && item.media_url) {
    return (
      <Pressable onPress={() => onPreviewImage(item)}>
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
  onPreviewImage,
  onSelect,
  isSelected,
}: {
  item: Message;
  colors: Palette;
  styles: Styles;
  onPreviewImage: (message: Message) => void;
  onSelect: (message: Message) => void;
  isSelected: boolean;
}) {
  const isAgent = item.sender_type === 'agent' || item.sender_type === 'bot';
  return (
    <Pressable
      style={[
        styles.bubbleRow,
        isAgent ? styles.bubbleRowAgent : styles.bubbleRowCustomer,
        isSelected && styles.bubbleRowSelected,
      ]}
      onLongPress={() => onSelect(item)}
      delayLongPress={350}
    >
      <View style={[styles.bubble, isAgent ? styles.bubbleAgent : styles.bubbleCustomer]}>
        <MessageContent item={item} isAgent={isAgent} styles={styles} colors={colors} onPreviewImage={onPreviewImage} />
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
    </Pressable>
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

const RECORDING_BAR_COUNT = 34;

/**
 * Live amplitude bars while recording — `metering` (dBFS, roughly
 * -50..0) comes straight from the recorder each poll, so unlike the
 * played-back waveform (a stable pseudo-pattern — see AudioMessage.tsx)
 * this one genuinely reflects how loud you're talking in the moment.
 */
function RecordingWaveform({ metering, colors }: { metering: number | undefined; colors: Palette }) {
  // One persistent Animated.Value per bar *position* (not per sample) —
  // each poll animates every position toward its new target instead of
  // snapping instantly, which is what made this look glitchy on real
  // devices (34 bars re-rendering with hard height jumps every 100ms).
  // Lazily created once via the ref-null-check pattern so we don't
  // allocate 34 Animated.Values on every parent re-render (this
  // component re-renders on every metering poll while recording).
  const barsRef = useRef<Animated.Value[] | null>(null);
  if (!barsRef.current) {
    barsRef.current = Array.from({ length: RECORDING_BAR_COUNT }, () => new Animated.Value(0.05));
  }
  const samplesRef = useRef<number[]>([]);

  useEffect(() => {
    if (metering === undefined) return;
    const level = Math.min(1, Math.max(0.05, (metering + 50) / 50));
    const next = [...samplesRef.current, level];
    samplesRef.current = next.length > RECORDING_BAR_COUNT ? next.slice(next.length - RECORDING_BAR_COUNT) : next;
    const padded = Array<number>(RECORDING_BAR_COUNT - samplesRef.current.length)
      .fill(0.05)
      .concat(samplesRef.current);
    Animated.parallel(
      padded.map((lvl, i) =>
        Animated.timing(barsRef.current![i], { toValue: lvl, duration: 110, useNativeDriver: false })
      )
    ).start();
  }, [metering]);

  return (
    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', height: 28, gap: 2 }}>
      {barsRef.current.map((anim, i) => (
        <Animated.View
          key={i}
          style={{
            flex: 1,
            minWidth: 2,
            height: anim.interpolate({ inputRange: [0, 1], outputRange: ['8%', '100%'] }),
            borderRadius: 1,
            backgroundColor: colors.danger,
          }}
        />
      ))}
    </View>
  );
}

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
  const [previewMessage, setPreviewMessage] = useState<Message | null>(null);
  const [forwardTarget, setForwardTarget] = useState<Message | null>(null);
  const [forwardConversations, setForwardConversations] = useState<Conversation[] | null>(null);
  const [forwardSearch, setForwardSearch] = useState('');
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [deleteSheetOpen, setDeleteSheetOpen] = useState(false);
  const [assignedAgentId, setAssignedAgentId] = useState<string | null>(null);
  const [ownerKind, setOwnerKind] = useState<ConversationOwnerKind>('unassigned');
  const [teamMembers, setTeamMembers] = useState<TeamMember[] | null>(null);
  const [assignPickerOpen, setAssignPickerOpen] = useState(false);
  const listRef = useRef<FlatList<ListItem>>(null);

  // Land at the bottom (most recent message) whenever the thread first
  // becomes ready to show — whether that's an instant cache-hit
  // (messagesReady already true on mount) or after the network fetch
  // resolves. `onContentSizeChange` on the FlatList below already
  // calls scrollToEnd, but it only fires when the list's measured
  // content size changes — with async-loading image/audio bubbles
  // still growing rows after the first paint, that one call can land
  // short of the true bottom (reads as "opens in the middle"). This
  // re-fires scrollToEnd a couple more times shortly after the list
  // mounts to catch those late height changes without needing a full
  // inverted-list rewrite.
  useEffect(() => {
    if (!messagesReady) return;
    const t1 = setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
    const t2 = setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 300);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messagesReady, conversationId]);

  const sendPlayer = useAudioPlayer(sendSound);
  const receivePlayer = useAudioPlayer(receiveSound);
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const recorderState = useAudioRecorderState(recorder, 100);
  const [isLocked, setIsLocked] = useState(false);
  const isLockedRef = useRef(false);
  // Reflects touch-down immediately, before the async permission-check +
  // prepareToRecordAsync() + record() chain resolves (that chain can take
  // 100-300ms on real Android hardware) — without this, the composer
  // waited for the native recorder to actually confirm it was recording
  // before showing anything, which is what made the gesture feel
  // laggy/"weird". Combined with recorderState.isRecording below so the
  // UI shows instantly on touch and only fully clears once the native
  // recorder has actually stopped.
  const [isHolding, setIsHolding] = useState(false);
  const isHoldingRef = useRef(false);
  // Guards finishRecording/cancelRecording against reentrancy — e.g. a
  // fast double-tap on the locked-send button, or the send button and
  // the trash button firing in quick succession. Without this, two
  // concurrent calls could both call recorder.stop()/read recorder.uri,
  // producing a double-send (two outbound messages) or a crash (the
  // second stop() hitting an already-torn-down native recorder in a way
  // the short-recording catch wasn't written for).
  const isFinishingVoiceRef = useRef(false);
  const [isFinishingVoice, setIsFinishingVoice] = useState(false);
  const isRecordingRef = useRef(false);
  useEffect(() => {
    isRecordingRef.current = recorderState.isRecording;
  }, [recorderState.isRecording]);

  // Navigating away (either back button) mid-recording — e.g. holding
  // the mic, then pressing back before releasing — otherwise leaves an
  // active native recording session running under a player whose
  // automatic unmount-release was never designed to interrupt an
  // in-progress recording safely. Stopping it explicitly first, before
  // the screen (and the recorder with it) unmounts, avoids tearing
  // down a live recording out from under itself.
  useEffect(() => {
    return () => {
      if (isRecordingRef.current) {
        recorder.stop().catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchMessages = useCallback(async () => {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .is('deleted_at', null)
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
      .select('unread_count, assigned_agent_id, owner_kind, contact:contacts(*)')
      .eq('id', conversationId)
      .maybeSingle();

    const contactRow = conv?.contact as unknown as Contact | null;
    setContact(contactRow);
    setAssignedAgentId((conv?.assigned_agent_id as string | null) ?? null);
    setOwnerKind((conv?.owner_kind as ConversationOwnerKind) ?? 'unassigned');

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

  // Marks this conversation as "the one on screen" only while it's the
  // focused route — tab screens stay mounted in the background in this
  // app, so mount/unmount alone would leave a stale thread marked
  // active after navigating away within the same tab. The push
  // notification handler (lib/push-notifications.ts) checks this to
  // skip the banner for a message in the chat you're already viewing.
  //
  // That same "tab screens stay mounted" fact is also why the unmount
  // cleanup above (recorder.stop() on unmount) never fired for the
  // common case: start recording, switch tabs (or open a different
  // conversation) without explicitly sending/canceling. This screen
  // never unmounts, so the native recorder just kept running — showing
  // as a "stuck" recording bar (still counting up, waveform still
  // live) whenever any chat was reopened, since it genuinely never
  // stopped. Canceling on blur (losing focus, not just unmounting)
  // closes that gap the same way leaving mid-recording via the back
  // button already worked.
  useFocusEffect(
    useCallback(() => {
      setActiveConversationId(conversationId);
      return () => {
        setActiveConversationId(null);
        if (isRecordingRef.current || isHoldingRef.current) {
          isHoldingRef.current = false;
          setIsHolding(false);
          isLockedRef.current = false;
          setIsLocked(false);
          recorder.stop().catch(() => {});
        }
      };
    }, [conversationId]),
  );

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
      isHoldingRef.current = false;
      setIsHolding(false);
      return;
    }
    setSendError(null);
    isLockedRef.current = false;
    setIsLocked(false);
    await recorder.prepareToRecordAsync();
    recorder.record();
  }

  async function cancelRecording() {
    if (isFinishingVoiceRef.current) return;
    isFinishingVoiceRef.current = true;
    isHoldingRef.current = false;
    setIsHolding(false);
    isLockedRef.current = false;
    setIsLocked(false);
    await recorder.stop().catch(() => {});
    isFinishingVoiceRef.current = false;
  }

  async function finishRecording() {
    // Blocks a second concurrent call — see isFinishingVoiceRef comment
    // above. Must be the very first thing this function does.
    if (isFinishingVoiceRef.current) return;
    isFinishingVoiceRef.current = true;
    setIsFinishingVoice(true);
    isHoldingRef.current = false;
    setIsHolding(false);
    isLockedRef.current = false;
    setIsLocked(false);
    try {
      // recorder.stop() bridges to Android's MediaRecorder.stop(), which
      // throws IllegalStateException on a very short/invalid recording
      // (e.g. a quick tap-and-release). Every other stop() call site in
      // this file (cancelRecording above, the unmount guard) already
      // catches it — this one didn't, so that throw became an unhandled
      // promise rejection in this fire-and-forget async function and took
      // the whole app down instead of just failing this one recording.
      try {
        await recorder.stop();
      } catch (err) {
        console.error('[finishRecording] stop error:', err);
        setSendError('Recording was too short to send. Hold the mic a little longer.');
        return;
      }
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
    } finally {
      isFinishingVoiceRef.current = false;
      setIsFinishingVoice(false);
    }
  }

  // Hold the mic to record, release to send — matches WhatsApp's own
  // gesture. Slide up while holding to "lock" (keeps recording after
  // you lift your finger, showing the same manual send/cancel row a
  // locked recording already had). Slide left before releasing to
  // cancel outright, same as WhatsApp's cancel gesture.
  //
  // A quick, near-stationary tap (release almost immediately, barely
  // any finger movement) is treated as "tap to record hands-free"
  // rather than "hold and release to send" — it locks straight into
  // the recording row instead of attempting to stop+send a near-zero-
  // length clip (which used to hit the "recording too short" error
  // path and is what made a plain tap feel broken). A real hold
  // (finger down for a while, or moved) still sends on release exactly
  // as before.
  //
  // Recreated each render (cheap) rather than memoized so its closures
  // never go stale — PanResponder callbacks otherwise capture whichever
  // `accountId`/`recorder` were current the one time it was created.
  const pressStartRef = useRef(0);
  const micResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      pressStartRef.current = Date.now();
      isHoldingRef.current = true;
      setIsHolding(true);
      void startRecording();
    },
    onPanResponderMove: (_evt, gestureState) => {
      if (!isLockedRef.current && gestureState.dy < -60) {
        isLockedRef.current = true;
        setIsLocked(true);
      }
    },
    onPanResponderRelease: (_evt, gestureState) => {
      if (isLockedRef.current) return; // stays recording — user taps send/trash explicitly
      if (gestureState.dx < -80) {
        void cancelRecording();
        return;
      }
      const heldMs = Date.now() - pressStartRef.current;
      const isTap = heldMs < 300 && Math.abs(gestureState.dx) < 10 && Math.abs(gestureState.dy) < 10;
      if (isTap) {
        isLockedRef.current = true;
        setIsLocked(true);
        return;
      }
      void finishRecording();
    },
    onPanResponderTerminate: () => {
      if (!isLockedRef.current) void cancelRecording();
    },
  });

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

  function handleOpenAssignPicker() {
    setAssignPickerOpen(true);
    if (teamMembers === null) {
      apiFetch('/api/account/members', { method: 'GET' })
        .then((res) => res.json())
        .then((body) => setTeamMembers(body.members ?? []))
        .catch(() => setTeamMembers([]));
    }
  }

  async function handleAssign(agentId: string | null) {
    setAssignPickerOpen(false);
    const nextOwnerKind: ConversationOwnerKind = agentId ? 'human' : 'unassigned';
    setAssignedAgentId(agentId);
    setOwnerKind(nextOwnerKind);
    await supabase
      .from('conversations')
      .update({ owner_kind: nextOwnerKind, assigned_agent_id: agentId })
      .eq('id', conversationId);
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

  function handleForward(message: Message) {
    setForwardTarget(message);
    if (forwardConversations === null) {
      supabase
        .from('conversations')
        .select('*, contact:contacts(*)')
        .order('last_message_at', { ascending: false })
        .limit(50)
        .then(({ data }) => setForwardConversations((data as unknown as Conversation[]) ?? []));
    }
  }

  async function handleForwardTo(target: Conversation) {
    if (!forwardTarget || !accountId) return;
    const message = forwardTarget;
    setForwardTarget(null);
    setForwardSearch('');
    setSelectedMessage(null);

    // Navigate to the destination chat immediately instead of sitting
    // on a spinner until the send round-trip finishes — the target
    // screen's own realtime subscription picks the message up the
    // moment it lands, same as any other incoming message there.
    router.push({
      pathname: '/inbox/[id]',
      params: {
        id: target.id,
        name: target.contact?.name ?? '',
        phone: target.contact?.phone ?? '',
        stageName: target.contact?.lifecycle_stage?.name ?? '',
        stageColor: target.contact?.lifecycle_stage?.color ?? '',
      },
    });

    try {
      if (message.content_type === 'text') {
        await apiFetch('/api/whatsapp/send', {
          method: 'POST',
          body: JSON.stringify({
            conversation_id: target.id,
            message_type: 'text',
            content_text: message.content_text,
          }),
        });
      } else if (message.media_url) {
        const publicUrl = await ensureForwardableMediaUrl(message.media_url, accountId);
        await apiFetch('/api/whatsapp/send', {
          method: 'POST',
          body: JSON.stringify({
            conversation_id: target.id,
            message_type: message.content_type,
            media_url: publicUrl,
            content_text: message.content_type === 'document' ? message.content_text : undefined,
            filename: message.content_type === 'document' ? message.content_text : undefined,
          }),
        });
      }
    } catch (err) {
      console.error('[Forward] failed:', err);
    }
  }

  async function handleDeleteForMe() {
    if (!selectedMessage) return;
    const messageId = selectedMessage.id;
    setDeleteSheetOpen(false);
    setSelectedMessage(null);
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, deleted_at: new Date().toISOString() } : m)));
    await supabase.from('messages').update({ deleted_at: new Date().toISOString() }).eq('id', messageId);
  }

  const filteredForwardConversations = useMemo(() => {
    if (!forwardConversations) return [];
    const term = forwardSearch.trim().toLowerCase();
    if (!term) return forwardConversations;
    return forwardConversations.filter((c) => {
      const name = c.contact?.name?.toLowerCase() ?? '';
      const phone = c.contact?.phone?.toLowerCase() ?? '';
      return name.includes(term) || phone.includes(term);
    });
  }, [forwardConversations, forwardSearch]);

  // Flattens messages + in-flight pending bubbles into one list with
  // WhatsApp-style date separators inserted between day boundaries.
  const listData = useMemo<ListItem[]>(() => {
    // Excludes anything soft-deleted via "Delete for Me" — the realtime
    // UPDATE handler above just replaces the row in `messages` as-is
    // (deleted_at and all), so this is the one place that actually
    // keeps it out of view.
    const undeleted = messages.filter((m) => !m.deleted_at);
    const term = searchQuery.trim().toLowerCase();
    const visibleMessages = term
      ? undeleted.filter((m) => m.content_text?.toLowerCase().includes(term))
      : undeleted;

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

  // Closing search leaves the list wherever the search results had it
  // scrolled — onContentSizeChange's `!isSearching` guard only
  // prevents auto-scrolling *during* search, it doesn't re-anchor to
  // the bottom once search closes. Re-land at the bottom to match
  // WhatsApp's own behavior (closing search returns you to the latest
  // message, not wherever a search result happened to be).
  const wasSearchingRef = useRef(false);
  useEffect(() => {
    if (wasSearchingRef.current && !isSearching) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
    }
    wasSearchingRef.current = isSearching;
  }, [isSearching]);

  // Instant header: the real `contact` record (once fetched) always
  // wins, but until then we render from what the inbox list already
  // knew (passed via route params) instead of a blank/loading state.
  const headerName = contact ? contact.name || contact.phone || 'Conversation' : params.name || params.phone || 'Conversation';
  const headerStageName = contact ? contact.lifecycle_stage?.name ?? null : params.stageName || null;
  const headerStageColor = contact ? contact.lifecycle_stage?.color ?? colors.borderStrong : params.stageColor || colors.borderStrong;
  const assignedMember = teamMembers?.find((m) => m.user_id === assignedAgentId);
  const assignLabel =
    ownerKind === 'ai' ? 'AI Agent' : assignedAgentId ? (assignedMember?.full_name ?? 'Assigned') : 'Unassigned';
  // isHolding flips true synchronously on touch-down; recorderState.isRecording
  // only flips once the native recorder confirms it — combining them means the
  // composer responds to touch instantly instead of visibly lagging behind it.
  const isRecording = isHolding || recorderState.isRecording;
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
        {selectedMessage ? (
          // Tap-and-hold a message to select it — swaps the header for
          // a WhatsApp-style selection bar instead of jumping straight
          // to forwarding on a bare tap.
          <View style={styles.headerTopRow}>
            <Pressable onPress={() => setSelectedMessage(null)} hitSlop={8} style={styles.backButton}>
              <Ionicons name="close" size={24} color={colors.text} />
            </Pressable>
            <Text style={styles.headerName} numberOfLines={1}>
              1 selected
            </Text>
            <View style={styles.headerActions}>
              <Pressable
                style={styles.headerIconButton}
                onPress={() => handleForward(selectedMessage)}
                hitSlop={8}
              >
                <Ionicons name="arrow-redo-outline" size={20} color={colors.textSecondary} />
              </Pressable>
              <Pressable
                style={styles.headerIconButton}
                onPress={() => setDeleteSheetOpen(true)}
                hitSlop={8}
              >
                <Ionicons name="trash-outline" size={20} color={colors.dangerMuted} />
              </Pressable>
            </View>
          </View>
        ) : (
          <>
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
            <View style={styles.pillRow}>
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
              <Pressable style={styles.stagePill} onPress={handleOpenAssignPicker}>
                <Ionicons name="person-circle-outline" size={13} color={colors.textFaint} />
                <Text style={styles.stagePillText} numberOfLines={1}>
                  {assignLabel}
                </Text>
                <Ionicons name="chevron-down" size={12} color={colors.textFaint} />
              </Pressable>
            </View>
          </>
        )}
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
            return (
              <MessageBubble
                item={item.message}
                colors={colors}
                styles={styles}
                onPreviewImage={setPreviewMessage}
                onSelect={setSelectedMessage}
                isSelected={selectedMessage?.id === item.message.id}
              />
            );
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
          {isRecording && isLocked ? (
            // Locked — recording continues hands-free; explicit tap
            // required to send or cancel (same as a locked recording
            // in WhatsApp).
            <View style={styles.recordingRow}>
              <Pressable
                onPress={cancelRecording}
                hitSlop={8}
                style={styles.recordingCancel}
                disabled={isFinishingVoice}
              >
                <Ionicons name="trash-outline" size={20} color={colors.dangerMuted} />
              </Pressable>
              <View style={styles.recordingDot} />
              <Text style={styles.recordingTime}>
                {Math.floor(recordSeconds / 60)}:{(recordSeconds % 60).toString().padStart(2, '0')}
              </Text>
              <RecordingWaveform metering={recorderState.metering} colors={colors} />
              <Pressable
                style={({ pressed }) => [styles.sendButton, (pressed || isFinishingVoice) && styles.sendButtonPressed]}
                onPress={finishRecording}
                disabled={isFinishingVoice}
              >
                {isFinishingVoice ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <Ionicons name="send" size={17} color={colors.white} />
                )}
              </Pressable>
            </View>
          ) : isRecording ? (
            // Actively held — releasing sends, sliding left cancels,
            // sliding up locks (handled by micResponder below). The mic
            // button itself stays in the same place under the finger.
            <View style={styles.recordingHeldWrap}>
              <View style={styles.recordingRow}>
                <View style={styles.recordingDot} />
                <Text style={styles.recordingTime}>
                  {Math.floor(recordSeconds / 60)}:{(recordSeconds % 60).toString().padStart(2, '0')}
                </Text>
                <RecordingWaveform metering={recorderState.metering} colors={colors} />
                <View style={[styles.sendButton, styles.micButtonHeld]} {...micResponder.panHandlers}>
                  <Ionicons name="mic" size={19} color={colors.white} />
                </View>
              </View>
              <Text style={styles.recordingHintText}>◁ slide to cancel · slide up 🔒 to lock</Text>
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
                <View style={styles.sendButton} {...micResponder.panHandlers}>
                  <Ionicons name="mic" size={19} color={colors.white} />
                </View>
              )}
            </>
          )}
        </View>
      )}

      {/* Attachment picker sheet */}
      <Modal visible={attachOpen} transparent animationType="fade" onRequestClose={() => setAttachOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setAttachOpen(false)}>
          <View style={styles.menuCard}>
            <View style={styles.sheetHandle} />
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
            <View style={styles.sheetHandle} />
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
            <View style={styles.sheetHandle} />
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

      {/* Assignee picker */}
      <Modal
        visible={assignPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setAssignPickerOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setAssignPickerOpen(false)}>
          <View style={styles.menuCard}>
            <View style={styles.sheetHandle} />
            <Text style={styles.menuTitle}>Assign To</Text>
            <Pressable style={styles.menuItem} onPress={() => handleAssign(null)}>
              <Ionicons name="person-circle-outline" size={20} color={colors.textFaint} />
              <Text style={styles.menuItemText}>Unassigned</Text>
            </Pressable>
            {teamMembers === null ? (
              <ActivityIndicator color={colors.accent} style={{ marginVertical: spacing.md }} />
            ) : (
              teamMembers.map((member) => (
                <Pressable key={member.user_id} style={styles.menuItem} onPress={() => handleAssign(member.user_id)}>
                  <Avatar label={member.full_name || member.email || '?'} seed={member.user_id} size={24} />
                  <Text style={styles.menuItemText}>{member.full_name || member.email}</Text>
                </Pressable>
              ))
            )}
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
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeaderRow}>
              <Text style={styles.sheetHeaderTitle}>Media, Links and Docs</Text>
              <Pressable style={styles.previewIconButtonDark} onPress={() => setMediaViewerOpen(false)} hitSlop={8}>
                <Ionicons name="close" size={20} color={colors.textSecondary} />
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
                  <Pressable
                    style={styles.mediaGridItem}
                    onPress={() => {
                      if (!item.media_url) return;
                      if (item.content_type === 'image') {
                        setMediaViewerOpen(false);
                        setPreviewMessage(item);
                      } else {
                        openMediaUrl(item.media_url);
                      }
                    }}
                  >
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

      {/* Full-screen image preview */}
      <Modal
        visible={!!previewMessage}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewMessage(null)}
      >
        <View style={styles.previewContainer}>
          <View style={[styles.previewHeader, { paddingTop: insets.top + spacing.sm }]}>
            <Pressable
              style={styles.previewIconButton}
              onPress={() => setPreviewMessage(null)}
              hitSlop={8}
            >
              <Ionicons name="close" size={24} color="#fff" />
            </Pressable>
            <Pressable
              style={styles.previewIconButton}
              onPress={() => {
                const message = previewMessage;
                setPreviewMessage(null);
                if (message) handleForward(message);
              }}
              hitSlop={8}
            >
              <Ionicons name="arrow-redo-outline" size={22} color="#fff" />
            </Pressable>
          </View>
          {previewMessage?.media_url && (
            <AuthedImage url={previewMessage.media_url} style={styles.previewImage} resizeMode="contain" />
          )}
        </View>
      </Modal>

      {/* Forward picker */}
      <Modal
        visible={!!forwardTarget}
        transparent
        animationType="slide"
        onRequestClose={() => setForwardTarget(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setForwardTarget(null)}>
          <Pressable style={styles.forwardCard} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeaderRow}>
              <Text style={styles.sheetHeaderTitle}>Forward to</Text>
              <Pressable style={styles.previewIconButtonDark} onPress={() => setForwardTarget(null)} hitSlop={8}>
                <Ionicons name="close" size={20} color={colors.textSecondary} />
              </Pressable>
            </View>
            <View style={styles.forwardSearchRow}>
              <Ionicons name="search" size={16} color={colors.textFaint} style={{ marginRight: spacing.sm }} />
              <TextInput
                style={styles.forwardSearchInput}
                placeholder="Search chats…"
                placeholderTextColor={colors.textFaint}
                value={forwardSearch}
                onChangeText={setForwardSearch}
              />
            </View>
            {forwardConversations === null ? (
              <ActivityIndicator color={colors.accent} style={{ marginVertical: spacing.xl }} />
            ) : filteredForwardConversations.length === 0 ? (
              <Text style={styles.emptyText}>No matching chats</Text>
            ) : (
              <FlatList
                data={filteredForwardConversations}
                keyExtractor={(item) => item.id}
                style={{ maxHeight: 360 }}
                renderItem={({ item }) => {
                  const label = item.contact?.name || item.contact?.phone || 'Unknown';
                  return (
                    <Pressable style={styles.forwardRow} onPress={() => handleForwardTo(item)}>
                      <Avatar label={label} seed={item.contact?.id} size={40} showChannelBadge />
                      <Text style={styles.forwardRowText} numberOfLines={1}>
                        {label}
                      </Text>
                    </Pressable>
                  );
                }}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Delete confirm — only "Delete for Me" is real. WhatsApp gives
          businesses no API to unsend a message from the customer's
          phone, so there's no working "Delete for Everyone" to offer
          here; showing one that didn't actually do that would be worse
          than not having it. */}
      <Modal
        visible={deleteSheetOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setDeleteSheetOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setDeleteSheetOpen(false)}>
          <View style={styles.menuCard}>
            <View style={styles.sheetHandle} />
            <Pressable style={styles.menuItem} onPress={handleDeleteForMe}>
              <Ionicons name="trash-outline" size={20} color={colors.dangerMuted} />
              <Text style={[styles.menuItemText, { color: colors.dangerMuted }]}>Delete for Me</Text>
            </Pressable>
            <Text style={styles.deleteNote}>
              Only removes this from your own inbox. WhatsApp doesn&apos;t let businesses unsend a message from the customer&apos;s phone.
            </Text>
          </View>
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
    pillRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginLeft: spacing.xl + spacing.sm,
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
      borderWidth: 1,
      borderColor: colors.border,
      maxWidth: '48%',
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
    bubbleRowSelected: { backgroundColor: colors.primaryMuted },
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
    recordingRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    recordingCancel: { padding: 4 },
    recordingDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.danger },
    recordingTime: { color: colors.textSecondary, fontSize: 14, fontVariant: ['tabular-nums'] },
    recordingHeldWrap: { flex: 1, gap: 2 },
    recordingHintText: { color: colors.textFaint, fontSize: 11, textAlign: 'center' },
    micButtonHeld: { transform: [{ scale: 1.08 }] },
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
      borderTopLeftRadius: radius.lg + 8,
      borderTopRightRadius: radius.lg + 8,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.xl,
      gap: 4,
      maxHeight: '70%',
      shadowColor: '#000',
      shadowOpacity: 0.2,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: -2 },
      elevation: 8,
    },
    sheetHandle: {
      alignSelf: 'center',
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.borderStrong,
      marginBottom: spacing.sm,
    },
    sheetHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.md,
    },
    sheetHeaderTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
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
      borderTopLeftRadius: radius.lg + 8,
      borderTopRightRadius: radius.lg + 8,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.xl,
      maxHeight: '75%',
      shadowColor: '#000',
      shadowOpacity: 0.2,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: -2 },
      elevation: 8,
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
    previewContainer: { flex: 1, backgroundColor: '#000' },
    previewHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.md,
    },
    previewIconButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(255,255,255,0.15)',
    },
    previewIconButtonDark: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceRaised,
    },
    previewImage: { flex: 1, width: '100%' },
    forwardCard: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: radius.lg + 8,
      borderTopRightRadius: radius.lg + 8,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.xl,
      maxHeight: '75%',
      shadowColor: '#000',
      shadowOpacity: 0.2,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: -2 },
      elevation: 8,
    },
    forwardSearchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surfaceRaised,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      marginBottom: spacing.sm,
    },
    forwardSearchInput: { flex: 1, color: colors.text, fontSize: 14, paddingVertical: spacing.sm + 2 },
    forwardRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm + 2,
    },
    forwardRowText: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '500' },
    deleteNote: { color: colors.textFaint, fontSize: 12, lineHeight: 17, marginTop: spacing.sm },
  });
}
