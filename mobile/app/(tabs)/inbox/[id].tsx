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
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer } from 'expo-audio';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase, apiFetch } from '../../../lib/supabase';
import { useRealtime } from '../../../hooks/use-realtime';
import { useAppTheme } from '../../../hooks/use-theme';
import { loadLifecycleStages } from '../../../lib/contacts/queries';
import { AudioMessage } from '../../../components/AudioMessage';
import { radius, scaleFontSizes, spacing, type Palette } from '../../../lib/theme';
import type { Message, Contact, LifecycleStage } from '../../../lib/types';

const sendSound = require('../../../assets/sounds/send.wav');
const receiveSound = require('../../../assets/sounds/receive.wav');

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

function MessageContent({ item, isAgent, styles }: { item: Message; isAgent: boolean; styles: Styles }) {
  if (item.content_type === 'audio' && item.media_url) {
    return <AudioMessage url={item.media_url} tint={isAgent ? 'agent' : 'customer'} />;
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
        <MessageContent item={item} isAgent={isAgent} styles={styles} />
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
                    : 'rgba(255,255,255,0.7)'
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
            <Ionicons name="time-outline" size={12} color="rgba(255,255,255,0.6)" />
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
  const { id: conversationId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, fontScale } = useAppTheme();
  const styles = useMemo(() => scaleFontSizes(makeStyles(colors), fontScale), [colors, fontScale]);

  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [contact, setContact] = useState<Contact | null>(null);
  const [stages, setStages] = useState<LifecycleStage[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [stagePickerOpen, setStagePickerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const listRef = useRef<FlatList<ListItem>>(null);

  const sendPlayer = useAudioPlayer(sendSound);
  const receivePlayer = useAudioPlayer(receiveSound);

  const fetchMessages = useCallback(async () => {
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(100);

    if (error) {
      console.error('[Thread] fetch messages error:', error.message);
      return;
    }
    setMessages((data as Message[]) ?? []);
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

  // Load thread + contact, mark read on open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await fetchMessages();
      if (cancelled) return;
      setLoading(false);
      await fetchContact();
    })();
    loadLifecycleStages(supabase).then(setStages).catch(console.error);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useRealtime({
    channelName: `mobile-thread-${conversationId}`,
    onMessageEvent: (event) => {
      const row = event.new as Message;
      if (row.conversation_id !== conversationId) return;
      if (event.eventType === 'INSERT') {
        setMessages((prev) =>
          prev.some((m) => m.id === row.id) ? prev : [...prev, row],
        );
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
        setMessages((prev) => prev.map((m) => (m.id === row.id ? row : m)));
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

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

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
            {contact?.name || contact?.phone || 'Conversation'}
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
          <View
            style={[
              styles.stageDot,
              { backgroundColor: contact?.lifecycle_stage?.color ?? colors.borderStrong },
            ]}
          />
          <Text style={styles.stagePillText} numberOfLines={1}>
            {contact?.lifecycle_stage?.name ?? 'Set stage'}
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

      <FlatList
        ref={listRef}
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

      {sendError && (
        <View style={styles.errorBar}>
          <Text style={styles.errorBarText}>{sendError}</Text>
        </View>
      )}

      {!contact?.blocked_at && (
        <View style={styles.composer}>
          <TextInput
            style={styles.composerInput}
            placeholder="Type a message…"
            placeholderTextColor={colors.textFaint}
            value={text}
            onChangeText={setText}
            multiline
          />
          <Pressable
            style={({ pressed }) => [
              styles.sendButton,
              !text.trim() && styles.sendButtonDisabled,
              pressed && styles.sendButtonPressed,
            ]}
            onPress={handleSend}
            disabled={!text.trim()}
          >
            <Ionicons name="send" size={17} color={colors.white} />
          </Pressable>
        </View>
      )}

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
      backgroundColor: colors.primary,
      borderBottomRightRadius: 4,
    },
    bubbleFailed: { opacity: 0.6 },
    bubbleCustomer: {
      backgroundColor: colors.surface,
      borderBottomLeftRadius: 4,
    },
    bubbleTextAgent: { color: colors.white, fontSize: 15 },
    bubbleTextCustomer: { color: colors.textSecondary, fontSize: 15 },
    bubbleFooter: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginTop: 3 },
    bubbleTimeAgent: { color: 'rgba(255,255,255,0.7)', fontSize: 10 },
    bubbleTimeCustomer: { color: colors.textFaint, fontSize: 10 },
    failedText: { color: colors.dangerMuted, fontSize: 11, marginTop: 4 },
    emptyText: { color: colors.textFaint, fontSize: 13 },
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
  });
}
