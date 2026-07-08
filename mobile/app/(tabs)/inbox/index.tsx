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
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../hooks/use-auth';
import { useAppTheme } from '../../../hooks/use-theme';
import { useRealtime } from '../../../hooks/use-realtime';
import { loadLifecycleStages } from '../../../lib/contacts/queries';
import { Avatar } from '../../../components/Avatar';
import { radius, scaleFontSizes, spacing, type Palette } from '../../../lib/theme';
import type { Conversation, LifecycleStage } from '../../../lib/types';

const PAGE_SIZE = 30;
const ROW_HEIGHT = 74;
// Same embed shape as the web app's CONVERSATION_SELECT
// (src/lib/inbox/conversations.ts), plus the lifecycle stage join so
// the filter chips below can match on it client-side.
const CONVERSATION_SELECT = '*, contact:contacts(*, lifecycle_stage:lifecycle_stages(*))';

const ConversationRow = memo(function ConversationRow({
  item,
  onPress,
  styles,
}: {
  item: Conversation;
  onPress: (item: Conversation) => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  const isUnread = item.unread_count > 0;
  const label = item.contact?.name || item.contact?.phone || 'Unknown';
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => onPress(item)}
    >
      <Avatar label={label} seed={item.contact?.id} size={48} />
      <View style={styles.rowContent}>
        <View style={styles.rowTop}>
          <Text style={[styles.name, isUnread && styles.unreadText]} numberOfLines={1}>
            {label}
          </Text>
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
          <Text style={[styles.preview, isUnread && styles.unreadPreview]} numberOfLines={1}>
            {item.last_message_text || 'No messages yet'}
          </Text>
          {isUnread && (
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadBadgeText}>{item.unread_count}</Text>
            </View>
          )}
        </View>
        {item.contact?.lifecycle_stage && (
          <View style={styles.stageRow}>
            <View style={[styles.stageDot, { backgroundColor: item.contact.lifecycle_stage.color }]} />
            <Text style={styles.stageText} numberOfLines={1}>
              {item.contact.lifecycle_stage.name}
            </Text>
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
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchConversations = useCallback(async () => {
    const { data, error } = await supabase
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .order('last_message_at', { ascending: false })
      .limit(PAGE_SIZE);

    if (error) {
      console.error('[Inbox] fetch conversations error:', error.message);
      return;
    }
    setConversations((data as unknown as Conversation[]) ?? []);
  }, []);

  // `accountId` dependency so switching workspace (Phase 4) re-fetches
  // under the new account — tab screens stay mounted across
  // navigation, so a route change alone won't re-run this.
  useEffect(() => {
    setLoading(true);
    fetchConversations().finally(() => setLoading(false));
    loadLifecycleStages(supabase).then(setStages).catch(console.error);
  }, [fetchConversations, accountId]);

  // Live updates while the list is open. A burst of several messages
  // arriving together (common right after connecting a number) would
  // otherwise trigger a full re-fetch per event; debounce collapses
  // that into a single re-fetch per ~400ms window.
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(fetchConversations, 400);
  }, [fetchConversations]);

  useEffect(() => {
    return () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    };
  }, []);

  useRealtime({
    channelName: 'mobile-inbox-list',
    onConversationEvent: scheduleRefetch,
    onMessageEvent: scheduleRefetch,
  });

  async function onRefresh() {
    setRefreshing(true);
    await fetchConversations();
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

  // Client-side — the list is already small (PAGE_SIZE=30, realtime-
  // kept-fresh) so a network round-trip per keystroke would only add
  // latency for no benefit.
  const filtered = useMemo(() => {
    let rows = conversations;
    if (selectedStageId) {
      rows = rows.filter((c) => c.contact?.lifecycle_stage_id === selectedStageId);
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
    return rows;
  }, [conversations, selectedStageId, search]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.searchRow}>
        <Ionicons name="search" size={17} color={colors.textFaint} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search chats, contacts, messages…"
          placeholderTextColor={colors.textFaint}
          value={search}
          onChangeText={setSearch}
        />
        {search.length > 0 && (
          <Pressable onPress={() => setSearch('')} hitSlop={8}>
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
                </Pressable>
              );
            }}
          />
        </View>
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
              {search || selectedStageId ? 'No matching conversations' : 'No conversations yet.'}
            </Text>
          </View>
        }
        renderItem={({ item }) => <ConversationRow item={item} onPress={handlePress} styles={styles} />}
        getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        removeClippedSubviews
      />
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
    filterRow: { paddingBottom: spacing.sm },
    filterChip: {
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radius.pill,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.borderStrong,
    },
    filterChipText: { color: colors.textMuted, fontSize: 12 },
    filterChipTextActive: { color: colors.white, fontWeight: '600' },
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
    name: { color: colors.textSecondary, fontSize: 15, fontWeight: '500', flexShrink: 1 },
    unreadText: { color: colors.text, fontWeight: '700' },
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
  });
}
