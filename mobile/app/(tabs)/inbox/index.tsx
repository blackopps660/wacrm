import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Modal,
  Alert,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../hooks/use-auth';
import { useAppTheme } from '../../../hooks/use-theme';
import { useRealtime } from '../../../hooks/use-realtime';
import { loadLifecycleStages, loadTags } from '../../../lib/contacts/queries';
import { Avatar } from '../../../components/Avatar';
import { radius, scaleFontSizes, spacing, type Palette } from '../../../lib/theme';
import type { Conversation, ConversationStatus, LifecycleStage, Tag } from '../../../lib/types';

const PAGE_SIZE = 30;
const ROW_HEIGHT = 74;
const SEARCH_DEBOUNCE_MS = 350;
// Same embed shape as the web app's CONVERSATION_SELECT
// (src/lib/inbox/conversations.ts): lifecycle stage join for the stage
// chips, plus contact_tags(tags(*)) for the tag chips — flattened onto
// contact.tags in fetchConversations below, same as web's
// normalizeConversation.
const CONVERSATION_SELECT =
  '*, contact:contacts(*, lifecycle_stage:lifecycle_stages(*), contact_tags(tags(*)))';

// Shape returned by the get_inbox_counts RPC (supabase/migrations 054/055)
// — the same one the web inbox uses. A real aggregate query rather than
// counting over whatever page of `conversations` happened to be loaded
// client-side; that approach is what made chip counts show a different
// number on every reload (the loaded page is a shifting most-recent-N
// window, not a stable total).
interface InboxCounts {
  all: number;
  active: number;
  unread: number;
  open: number;
  pending: number;
  closed: number;
  archived: number;
  stages: Record<string, number>;
  tags: Record<string, number>;
}

type StatusTabValue = 'all' | 'unread' | ConversationStatus;
const STATUS_TABS: { value: StatusTabValue; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'open', label: 'Open' },
  { value: 'pending', label: 'Pending' },
  { value: 'closed', label: 'Closed' },
];

/** Splits `text` around the (case-insensitive) first match of `term` so the caller can render the middle segment highlighted. Returns null when there's nothing to highlight. */
function splitOnMatch(text: string, term: string): [string, string, string] | null {
  if (!term) return null;
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return null;
  return [text.slice(0, idx), text.slice(idx, idx + term.length), text.slice(idx + term.length)];
}

function HighlightedText({
  text,
  term,
  style,
  highlightStyle,
  numberOfLines,
}: {
  text: string;
  term: string;
  style: StyleProp<TextStyle>;
  highlightStyle: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  const parts = splitOnMatch(text, term);
  if (!parts) {
    return (
      <Text style={style} numberOfLines={numberOfLines}>
        {text}
      </Text>
    );
  }
  const [before, match, after] = parts;
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {before}
      <Text style={highlightStyle}>{match}</Text>
      {after}
    </Text>
  );
}

const ConversationRow = memo(function ConversationRow({
  item,
  onPress,
  onLongPress,
  styles,
  colors,
  searchTerm,
}: {
  item: Conversation;
  onPress: (item: Conversation) => void;
  onLongPress: (item: Conversation) => void;
  styles: ReturnType<typeof makeStyles>;
  colors: Palette;
  searchTerm: string;
}) {
  const isUnread = item.unread_count > 0;
  const label = item.contact?.name || item.contact?.phone || 'Unknown';
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => onPress(item)}
      onLongPress={() => onLongPress(item)}
      delayLongPress={350}
    >
      <Avatar label={label} seed={item.contact?.id} size={48} showChannelBadge />
      <View style={styles.rowContent}>
        <View style={styles.rowTop}>
          <View style={styles.nameRow}>
            {!!item.pinned_at && (
              <Ionicons name="pin" size={12} color={colors.textFaint} style={styles.rowIcon} />
            )}
            {!!item.muted_at && (
              <Ionicons name="volume-mute" size={13} color={colors.textFaint} style={styles.rowIcon} />
            )}
            <HighlightedText
              text={label}
              term={searchTerm}
              style={[styles.name, isUnread && styles.unreadText]}
              highlightStyle={styles.highlight}
              numberOfLines={1}
            />
          </View>
          {item.last_message_at && (
            <Text style={styles.time}>
              {new Date(item.last_message_at).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              })}
            </Text>
          )}
        </View>
        <View style={styles.rowBottom}>
          <HighlightedText
            text={item.last_message_text || 'No messages yet'}
            term={searchTerm}
            style={[styles.preview, isUnread && styles.unreadPreview]}
            highlightStyle={styles.highlight}
            numberOfLines={1}
          />
          {isUnread && (
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadBadgeText}>{item.unread_count}</Text>
            </View>
          )}
        </View>
        {(item.contact?.lifecycle_stage || item.status === 'closed') && (
          <View style={styles.stageRow}>
            {item.contact?.lifecycle_stage && (
              <>
                <View style={[styles.stageDot, { backgroundColor: item.contact.lifecycle_stage.color }]} />
                <Text style={styles.stageText} numberOfLines={1}>
                  {item.contact.lifecycle_stage.name}
                </Text>
              </>
            )}
            {item.status === 'closed' && (
              <View style={styles.closedBadge}>
                <Ionicons name="checkmark-circle" size={11} color={colors.success} />
                <Text style={styles.closedBadgeText}>Closed</Text>
              </View>
            )}
          </View>
        )}
      </View>
    </Pressable>
  );
});

export default function InboxListScreen() {
  const router = useRouter();
  const { accountId } = useAuth();
  const { colors, fontScale } = useAppTheme();
  const styles = useMemo(() => scaleFontSizes(makeStyles(colors), fontScale), [colors, fontScale]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [stages, setStages] = useState<LifecycleStage[]>([]);
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusTabValue>('all');
  const [counts, setCounts] = useState<InboxCounts | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionTarget, setActionTarget] = useState<Conversation | null>(null);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pagination — the initial fetch only pulls the most recent PAGE_SIZE
  // conversations (unbounded load time otherwise, same rationale as the
  // web inbox). Older ones load in via onEndReached rather than an
  // explicit button — at real scale (a few hundred conversations) an
  // account with no next-page affordance at all just read as "most of
  // my chats are missing" once someone scrolled past the 30th row.
  const cursorRef = useRef<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Debounced the same way Contacts' search already does — filtering the
  // FlatList's data on every single keystroke while it also has
  // `removeClippedSubviews` (below) is an unstable combination on
  // Android; without this the app could crash on the very first
  // character typed.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Flattens the embedded contact_tags(tags(*)) join onto contact.tags —
  // same shape as web's normalizeConversation (src/lib/inbox/conversations.ts).
  function normalizeRows(data: unknown): Conversation[] {
    type RawRow = Conversation & {
      contact?: (Conversation['contact'] & { contact_tags?: { tags: Tag | null }[] }) | null;
    };
    return ((data as RawRow[]) ?? []).map((row) => {
      if (!row.contact) return row as Conversation;
      const { contact_tags, ...contact } = row.contact;
      return {
        ...row,
        contact: {
          ...contact,
          tags: (contact_tags ?? []).map((ct) => ct.tags).filter((t): t is Tag => t != null),
        },
      } as Conversation;
    });
  }

  // Server-side status/unread scoping so pagination actually reaches the
  // matching rows — filtering only ever happened client-side before,
  // over whatever PAGE_SIZE rows the *unfiltered* most-recent-activity
  // query happened to return. Closed conversations in particular are
  // exactly the ones least likely to be recently active, so the Closed
  // tab would frequently show "no matching conversations" even when
  // closed conversations existed — this is the "All/Open/Pending/Closed
  // doesn't work right" bug.
  const fetchConversations = useCallback(async () => {
    let query = supabase
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .is('archived_at', null)
      .is('deleted_at', null)
      .order('last_message_at', { ascending: false })
      .limit(PAGE_SIZE);
    query =
      statusFilter === 'unread'
        ? query.gt('unread_count', 0)
        : statusFilter !== 'all'
          ? query.eq('status', statusFilter)
          : query;
    const { data, error } = await query;

    if (error) {
      console.error('[Inbox] fetch conversations error:', error.message);
      return;
    }
    const rows = normalizeRows(data);
    cursorRef.current = rows.length > 0 ? (rows[rows.length - 1].last_message_at ?? null) : null;
    setHasMore(rows.length === PAGE_SIZE);
    setConversations(rows);
  }, [statusFilter]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || !cursorRef.current) return;
    setLoadingMore(true);
    try {
      let query = supabase
        .from('conversations')
        .select(CONVERSATION_SELECT)
        .is('archived_at', null)
        .order('last_message_at', { ascending: false })
        .lt('last_message_at', cursorRef.current)
        .limit(PAGE_SIZE);
      query =
        statusFilter === 'unread'
          ? query.gt('unread_count', 0)
          : statusFilter !== 'all'
            ? query.eq('status', statusFilter)
            : query;
      const { data, error } = await query;
      if (error) {
        console.error('[Inbox] load more conversations error:', error.message);
        return;
      }
      const rows = normalizeRows(data);
      cursorRef.current =
        rows.length > 0 ? (rows[rows.length - 1].last_message_at ?? cursorRef.current) : cursorRef.current;
      setHasMore(rows.length === PAGE_SIZE);
      setConversations((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...rows.filter((c) => !seen.has(c.id))];
      });
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, statusFilter]);

  // All tab/chip counts — one real aggregate RPC rather than deriving
  // any of them from `conversations` (the paginated, status-scoped page
  // above). A stale (e.g. archived) conversation routinely falls outside
  // that page after any refetch, and a client-side count over a shifting
  // most-recent-N window isn't a stable total to begin with — it changes
  // every time new messages shift what's in that window.
  const fetchCounts = useCallback(async () => {
    if (!accountId) return;
    const { data, error } = await supabase.rpc('get_inbox_counts', {
      p_account_id: accountId,
    });
    if (error) {
      console.error('[Inbox] fetch counts error:', error.message);
      return;
    }
    setCounts(data as InboxCounts | null);
  }, [accountId]);

  // `accountId` dependency so switching workspace (Phase 4) re-fetches
  // under the new account — tab screens stay mounted across
  // navigation, so a route change alone won't re-run this.
  useEffect(() => {
    setLoading(true);
    fetchConversations().finally(() => setLoading(false));
    fetchCounts();
    loadLifecycleStages(supabase).then(setStages).catch(console.error);
    loadTags(supabase).then(setTags).catch(console.error);
  }, [fetchConversations, fetchCounts, accountId]);

  // Live updates while the list is open. A burst of several messages
  // arriving together (common right after connecting a number) would
  // otherwise trigger a full re-fetch per event; debounce collapses
  // that into a single re-fetch per ~400ms window.
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => {
      fetchConversations();
      fetchCounts();
    }, 400);
  }, [fetchConversations, fetchCounts]);

  useEffect(() => {
    return () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    };
  }, []);

  useRealtime({
    channelName: 'mobile-inbox-list',
    onConversationEvent: scheduleRefetch,
    onMessageEvent: scheduleRefetch,
    // Same fix as the web inbox (src/hooks/use-realtime.ts): without
    // this, the list re-subscribes to every message/conversation
    // change for every tenant on the whole instance, not just this
    // account, and the web app's own version of this exact gap is what
    // caused visible lag once an account had real WhatsApp traffic
    // flowing through 70+ conversations.
    messagesFilter: accountId ? `account_id=eq.${accountId}` : undefined,
    conversationsFilter: accountId ? `account_id=eq.${accountId}` : undefined,
    enabled: !!accountId,
  });

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([fetchConversations(), fetchCounts()]);
    setRefreshing(false);
  }

  const handlePress = useCallback(
    (item: Conversation) => {
      // Carries what we already know onto the thread screen so its
      // header/composer can render on the very first frame instead of
      // waiting on a network round trip — the actual record is still
      // re-fetched there to pick up anything stale (e.g. block status).
      router.push({
        pathname: '/inbox/[id]',
        params: {
          id: item.id,
          name: item.contact?.name ?? '',
          phone: item.contact?.phone ?? '',
          stageName: item.contact?.lifecycle_stage?.name ?? '',
          stageColor: item.contact?.lifecycle_stage?.color ?? '',
        },
      });
    },
    [router],
  );

  async function handleTogglePin(item: Conversation) {
    setActionTarget(null);
    const next = item.pinned_at ? null : new Date().toISOString();
    setConversations((prev) => prev.map((c) => (c.id === item.id ? { ...c, pinned_at: next } : c)));
    await supabase.from('conversations').update({ pinned_at: next }).eq('id', item.id);
  }

  async function handleToggleMute(item: Conversation) {
    setActionTarget(null);
    const next = item.muted_at ? null : new Date().toISOString();
    setConversations((prev) => prev.map((c) => (c.id === item.id ? { ...c, muted_at: next } : c)));
    await supabase.from('conversations').update({ muted_at: next }).eq('id', item.id);
  }

  async function handleToggleArchive(item: Conversation) {
    setActionTarget(null);
    const next = item.archived_at ? null : new Date().toISOString();
    // Archiving removes it from this (already server-scoped to
    // archived_at IS NULL) list outright rather than just flagging it,
    // since it no longer belongs in the current query's result set.
    setConversations((prev) => (next ? prev.filter((c) => c.id !== item.id) : prev));
    await supabase.from('conversations').update({ archived_at: next }).eq('id', item.id);
    fetchCounts();
  }

  // Whole-conversation version of the chat-thread's "Clear Chat" — same
  // deleted_at column (migration 063), same local-only caveat. A new
  // inbound/outbound message un-deletes it automatically (migration
  // trigger), same as archive, so an active conversation can't get
  // permanently lost this way.
  function handleDeleteConversation(item: Conversation) {
    setActionTarget(null);
    Alert.alert(
      'Delete conversation?',
      "This removes the whole conversation from your team's inbox. WhatsApp gives businesses no way to unsend messages, so the contact keeps everything on their own phone.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const deletedAt = new Date().toISOString();
            setConversations((prev) => prev.filter((c) => c.id !== item.id));
            await supabase.from('conversations').update({ deleted_at: deletedAt }).eq('id', item.id);
            fetchCounts();
          },
        },
      ],
    );
  }

  // Client-side — the list is already small (PAGE_SIZE=30, realtime-
  // kept-fresh) so a network round-trip per keystroke would only add
  // latency for no benefit.
  const filtered = useMemo(() => {
    // Server already scopes `conversations` to the active status/unread
    // tab and excludes archived rows — this re-applies the same status
    // check purely so the list updates instantly on tab tap instead of
    // flashing the previous tab's rows for the moment the refetch takes.
    let rows = conversations;
    if (statusFilter === 'unread') {
      rows = rows.filter((c) => c.unread_count > 0);
    } else if (statusFilter !== 'all') {
      rows = rows.filter((c) => c.status === statusFilter);
    }
    if (selectedStageId) {
      rows = rows.filter((c) => c.contact?.lifecycle_stage_id === selectedStageId);
    }
    if (selectedTagId) {
      rows = rows.filter((c) => c.contact?.tags?.some((t) => t.id === selectedTagId));
    }
    const term = search.trim().toLowerCase();
    if (term) {
      rows = rows.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? '';
        const phone = c.contact?.phone?.toLowerCase() ?? '';
        const preview = c.last_message_text?.toLowerCase() ?? '';
        return name.includes(term) || phone.includes(term) || preview.includes(term);
      });
    }
    // Pinned conversations float to the top (most recently pinned
    // first); everything else keeps the server's last_message_at order.
    const pinned = rows.filter((c) => c.pinned_at);
    const rest = rows.filter((c) => !c.pinned_at);
    pinned.sort((a, b) => new Date(b.pinned_at!).getTime() - new Date(a.pinned_at!).getTime());
    return [...pinned, ...rest];
  }, [conversations, statusFilter, selectedStageId, selectedTagId, search]);

  // Only the very first load (nothing on screen yet) blocks with a
  // full-screen spinner. Switching status tabs re-triggers `loading`
  // too (fetchConversations depends on statusFilter), but by then rows
  // are already on screen — client-filtered instantly above while the
  // server-scoped refetch runs in the background — so blocking the
  // whole screen for that would be a regression, not a fix.
  if (loading && conversations.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.statusTabs}>
        {STATUS_TABS.map((tab) => {
          const active = statusFilter === tab.value;
          const count = counts?.[tab.value as keyof InboxCounts] as number | undefined;
          return (
            <Pressable
              key={tab.value}
              onPress={() => setStatusFilter(tab.value)}
              style={[styles.statusTab, active && styles.statusTabActive]}
            >
              <Text style={[styles.statusTabText, active && styles.statusTabTextActive]}>
                {tab.label}
                {!!count && `  ${count}`}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.searchRow}>
        <Ionicons name="search" size={17} color={colors.textFaint} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search chats, contacts, messages…"
          placeholderTextColor={colors.textFaint}
          value={searchInput}
          onChangeText={setSearchInput}
        />
        {searchInput.length > 0 && (
          <Pressable
            onPress={() => {
              setSearchInput('');
              setSearch('');
            }}
            hitSlop={8}
          >
            <Ionicons name="close-circle" size={17} color={colors.textFaint} />
          </Pressable>
        )}
      </View>

      {stages.length > 0 && (
        <View style={styles.filterRow}>
          <FlatList
            horizontal
            showsHorizontalScrollIndicator={false}
            data={stages}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ gap: spacing.sm, paddingHorizontal: spacing.lg }}
            renderItem={({ item }) => {
              const active = selectedStageId === item.id;
              const count = counts?.stages[item.id] ?? 0;
              return (
                <Pressable
                  onPress={() => setSelectedStageId(active ? null : item.id)}
                  style={[
                    styles.filterChip,
                    active && { backgroundColor: item.color, borderColor: item.color },
                  ]}
                >
                  <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                    {item.name}
                  </Text>
                  {count > 0 && (
                    <Text style={[styles.filterChipCount, active && styles.filterChipTextActive]}>
                      {count}
                    </Text>
                  )}
                </Pressable>
              );
            }}
          />
        </View>
      )}

      {tags.length > 0 && (
        <View style={styles.filterRow}>
          <FlatList
            horizontal
            showsHorizontalScrollIndicator={false}
            data={tags}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ gap: spacing.sm, paddingHorizontal: spacing.lg }}
            renderItem={({ item }) => {
              const active = selectedTagId === item.id;
              const count = counts?.tags[item.id] ?? 0;
              return (
                <Pressable
                  onPress={() => setSelectedTagId(active ? null : item.id)}
                  style={[
                    styles.filterChip,
                    active && { backgroundColor: item.color, borderColor: item.color },
                  ]}
                >
                  <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                    {item.name}
                  </Text>
                  {count > 0 && (
                    <Text style={[styles.filterChipCount, active && styles.filterChipTextActive]}>
                      {count}
                    </Text>
                  )}
                </Pressable>
              );
            }}
          />
        </View>
      )}

      {!!counts?.archived && (
        <Pressable style={styles.archivedRow} onPress={() => router.push('/inbox/archived')}>
          <Ionicons name="archive-outline" size={18} color={colors.textFaint} />
          <Text style={styles.archivedRowText}>Archived</Text>
          <View style={styles.archivedBadge}>
            <Text style={styles.archivedBadgeText}>{counts.archived}</Text>
          </View>
        </Pressable>
      )}

      <FlatList
        style={styles.list}
        data={filtered}
        keyExtractor={(item) => item.id}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyText}>
              {search || selectedStageId || selectedTagId || statusFilter !== 'all'
                ? 'No matching conversations'
                : 'No conversations yet.'}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <ConversationRow
            item={item}
            onPress={handlePress}
            onLongPress={setActionTarget}
            styles={styles}
            colors={colors}
            searchTerm={search}
          />
        )}
        getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        removeClippedSubviews
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          loadingMore ? (
            <View style={{ paddingVertical: spacing.lg }}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : null
        }
      />

      {/* Long-press action sheet — pin/mute/archive */}
      <Modal
        visible={!!actionTarget}
        transparent
        animationType="fade"
        onRequestClose={() => setActionTarget(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setActionTarget(null)}>
          <View style={styles.menuCard}>
            <View style={styles.sheetHandle} />
            {actionTarget && (
              <>
                <Pressable style={styles.menuItem} onPress={() => handleTogglePin(actionTarget)}>
                  <Ionicons
                    name={actionTarget.pinned_at ? 'pin' : 'pin-outline'}
                    size={20}
                    color={colors.textSecondary}
                  />
                  <Text style={styles.menuItemText}>
                    {actionTarget.pinned_at ? 'Unpin Chat' : 'Pin Chat'}
                  </Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={() => handleToggleMute(actionTarget)}>
                  <Ionicons
                    name={actionTarget.muted_at ? 'volume-high-outline' : 'volume-mute-outline'}
                    size={20}
                    color={colors.textSecondary}
                  />
                  <Text style={styles.menuItemText}>
                    {actionTarget.muted_at ? 'Unmute Chat' : 'Mute Chat'}
                  </Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={() => handleToggleArchive(actionTarget)}>
                  <Ionicons name="archive-outline" size={20} color={colors.textSecondary} />
                  <Text style={styles.menuItemText}>Archive Chat</Text>
                </Pressable>
                <Pressable
                  style={styles.menuItem}
                  onPress={() => handleDeleteConversation(actionTarget)}
                >
                  <Ionicons name="trash-outline" size={20} color={colors.dangerMuted} />
                  <Text style={[styles.menuItemText, { color: colors.dangerMuted }]}>
                    Delete Conversation
                  </Text>
                </Pressable>
              </>
            )}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    searchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      margin: spacing.lg,
      marginBottom: spacing.sm,
      backgroundColor: colors.surface,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: spacing.md,
    },
    searchIcon: { marginRight: spacing.sm },
    searchInput: {
      flex: 1,
      paddingVertical: spacing.sm + 2,
      color: colors.text,
      fontSize: 15,
    },
    statusTabs: {
      flexDirection: 'row',
      gap: spacing.xs,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
    },
    statusTab: {
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radius.pill,
      backgroundColor: colors.surfaceRaised,
    },
    statusTabActive: { backgroundColor: colors.primary },
    statusTabText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
    statusTabTextActive: { color: colors.white },
    closedBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: spacing.xs },
    closedBadgeText: { color: colors.success, fontSize: 10, fontWeight: '600' },
    filterRow: { paddingBottom: spacing.sm },
    filterChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radius.pill,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.borderStrong,
    },
    filterChipText: { color: colors.textMuted, fontSize: 12 },
    filterChipTextActive: { color: colors.white, fontWeight: '600' },
    filterChipCount: { color: colors.textFaint, fontSize: 11, fontWeight: '600' },
    list: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
    emptyText: { color: colors.textFaint },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      minHeight: ROW_HEIGHT,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: spacing.md,
    },
    rowPressed: { backgroundColor: colors.surface },
    rowContent: { flex: 1, gap: 4 },
    rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    rowBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    nameRow: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, gap: 3 },
    rowIcon: { marginRight: 1 },
    name: { color: colors.textSecondary, fontSize: 15, fontWeight: '500', flexShrink: 1 },
    unreadText: { color: colors.text, fontWeight: '700' },
    highlight: { color: colors.primary, fontWeight: '700', backgroundColor: colors.primaryMuted },
    time: { color: colors.textFaint, fontSize: 11 },
    preview: { color: colors.textFaint, fontSize: 13, flex: 1, marginRight: spacing.sm },
    unreadPreview: { color: colors.textMuted },
    unreadBadge: {
      backgroundColor: colors.primary,
      borderRadius: 10,
      minWidth: 20,
      height: 20,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 5,
    },
    unreadBadgeText: { color: colors.white, fontSize: 11, fontWeight: '700' },
    stageRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 1 },
    stageDot: { width: 6, height: 6, borderRadius: 3 },
    stageText: { color: colors.textFaint, fontSize: 10 },
    archivedRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm + 2,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    archivedRowText: { flex: 1, color: colors.textSecondary, fontSize: 14, fontWeight: '500' },
    archivedBadge: {
      backgroundColor: colors.surfaceRaised,
      borderRadius: radius.pill,
      minWidth: 22,
      height: 22,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 6,
    },
    archivedBadgeText: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
    modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    menuCard: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: radius.lg + 8,
      borderTopRightRadius: radius.lg + 8,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.xl,
      gap: 4,
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
    menuItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    menuItemText: { color: colors.textSecondary, fontSize: 15 },
  });
}
