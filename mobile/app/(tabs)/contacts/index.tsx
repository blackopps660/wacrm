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
import { Avatar } from '../../../components/Avatar';
import { radius, scaleFontSizes, spacing, type Palette } from '../../../lib/theme';
import {
  loadTags,
  loadLifecycleStages,
  loadContacts,
  hydrateContactTags,
} from '../../../lib/contacts/queries';
import type { Contact, Tag, LifecycleStage } from '../../../lib/types';

const ROW_HEIGHT = 68;
const SEARCH_DEBOUNCE_MS = 350;

const ContactRow = memo(function ContactRow({
  item,
  onPress,
  styles,
}: {
  item: Contact;
  onPress: (id: string) => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => onPress(item.id)}
    >
      <Avatar label={item.name || item.phone} size={44} />
      <View style={styles.rowContent}>
        <Text style={styles.name} numberOfLines={1}>
          {item.name || item.phone}
        </Text>
        <Text style={styles.subtext} numberOfLines={1}>
          {item.name ? item.phone : item.email || item.company || ''}
        </Text>
        {item.tags && item.tags.length > 0 && (
          <View style={styles.tagRow}>
            {item.tags.slice(0, 3).map((t) => (
              <View key={t.id} style={[styles.tagPill, { backgroundColor: t.color }]}>
                <Text style={styles.tagPillText}>{t.name}</Text>
              </View>
            ))}
          </View>
        )}
      </View>
      {item.lifecycle_stage && (
        <View style={[styles.stageDot, { backgroundColor: item.lifecycle_stage.color }]} />
      )}
    </Pressable>
  );
});

export default function ContactsListScreen() {
  const router = useRouter();
  const { accountId } = useAuth();
  const { colors, fontScale } = useAppTheme();
  const styles = useMemo(() => scaleFontSizes(makeStyles(colors), fontScale), [colors, fontScale]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [stages, setStages] = useState<LifecycleStage[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Explicit "both filter lists have resolved" flag — replaces a
  // fragile `tags.length === 0 && stages.length === 0` guess that
  // permanently hung the contacts fetch for any account with zero
  // tags (a real, legitimate state): tags resolving to `[]` first
  // satisfied that guard's "still empty" half before stages had a
  // chance to load, and the fetch-trigger effect below never listed
  // `stages` as a dependency, so it never re-checked once stages did
  // arrive.
  const [filtersLoaded, setFiltersLoaded] = useState(false);

  // Drops stale responses when filters change rapidly — same
  // protection the web page uses.
  const fetchSeq = useRef(0);

  // Debounce the search box — without this every keystroke fired a
  // full network round-trip (visible lag while typing on real devices).
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Re-fetch on accountId change too (Phase 4 workspace switch) — tags
  // and lifecycle stages are account-scoped, same as contacts below.
  useEffect(() => {
    setFiltersLoaded(false);
    Promise.all([loadTags(supabase), loadLifecycleStages(supabase)])
      .then(([t, s]) => {
        setTags(t);
        setStages(s);
        setFiltersLoaded(true);
      })
      .catch((err) => {
        console.error(err);
        // Don't leave the contacts list hung if tags/stages fail —
        // still let the (unfiltered) fetch below proceed.
        setFiltersLoaded(true);
      });
  }, [accountId]);

  const fetchPage = useCallback(
    async (targetPage: number, append: boolean) => {
      const seq = ++fetchSeq.current;
      setError(null);
      try {
        const tagsMap = Object.fromEntries(tags.map((t) => [t.id, t]));
        const { contacts: rows, totalCount: count } = await loadContacts(supabase, {
          page: targetPage,
          search,
          selectedTagIds,
          selectedStageId,
        });
        const hydrated = await hydrateContactTags(supabase, rows, tagsMap);
        if (seq !== fetchSeq.current) return;
        setContacts((prev) => (append ? [...prev, ...hydrated] : hydrated));
        setTotalCount(count);
        setPage(targetPage);
      } catch (err) {
        if (seq !== fetchSeq.current) return;
        console.error('[Contacts] fetch error:', err);
        setError(err instanceof Error ? err.message : 'Failed to load contacts');
      }
    },
    [search, selectedTagIds, selectedStageId, tags],
  );

  // Re-fetch page 0 whenever filters (or the active workspace) change —
  // gated on `filtersLoaded` rather than tags/stages content so it
  // reliably fires exactly once both have resolved, regardless of
  // whether either list happens to be empty.
  useEffect(() => {
    if (!filtersLoaded) return;
    setLoading(true);
    fetchPage(0, false).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, selectedTagIds, selectedStageId, filtersLoaded, accountId]);

  async function onRefresh() {
    setRefreshing(true);
    await fetchPage(0, false);
    setRefreshing(false);
  }

  async function onEndReached() {
    if (loadingMore || contacts.length >= totalCount) return;
    setLoadingMore(true);
    await fetchPage(page + 1, true);
    setLoadingMore(false);
  }

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
    );
  }

  function toggleStage(stageId: string) {
    setSelectedStageId((prev) => (prev === stageId ? null : stageId));
  }

  const handlePress = useCallback((id: string) => router.push(`/contacts/${id}`), [router]);

  return (
    <View style={styles.container}>
      <View style={styles.searchRow}>
        <Ionicons name="search" size={17} color={colors.textFaint} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search name, phone, email…"
          placeholderTextColor={colors.textFaint}
          value={searchInput}
          onChangeText={setSearchInput}
        />
      </View>

      {(tags.length > 0 || stages.length > 0) && (
        <View style={styles.filterRow}>
          <FlatList
            horizontal
            showsHorizontalScrollIndicator={false}
            data={[
              ...stages.map((s) => ({ kind: 'stage' as const, id: s.id, label: s.name, color: s.color })),
              ...tags.map((t) => ({ kind: 'tag' as const, id: t.id, label: t.name, color: t.color })),
            ]}
            keyExtractor={(item) => `${item.kind}-${item.id}`}
            contentContainerStyle={{ gap: spacing.sm, paddingHorizontal: spacing.lg }}
            renderItem={({ item }) => {
              const active =
                item.kind === 'stage' ? selectedStageId === item.id : selectedTagIds.includes(item.id);
              return (
                <Pressable
                  onPress={() => (item.kind === 'stage' ? toggleStage(item.id) : toggleTag(item.id))}
                  style={[
                    styles.filterChip,
                    active && { backgroundColor: item.color, borderColor: item.color },
                  ]}
                >
                  <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                    {item.label}
                  </Text>
                </Pressable>
              );
            }}
          />
        </View>
      )}

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <FlatList
          data={contacts}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
          }
          onEndReached={onEndReached}
          onEndReachedThreshold={0.4}
          getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
          initialNumToRender={14}
          maxToRenderPerBatch={14}
          windowSize={7}
          removeClippedSubviews
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyText}>No contacts found</Text>
            </View>
          }
          ListFooterComponent={
            loadingMore ? <ActivityIndicator color={colors.accent} style={{ marginVertical: 16 }} /> : null
          }
          renderItem={({ item }) => <ContactRow item={item} onPress={handlePress} styles={styles} />}
        />
      )}

      <Pressable
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
        onPress={() => router.push('/contacts/new')}
      >
        <Ionicons name="add" size={28} color={colors.white} />
      </Pressable>
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
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
    emptyText: { color: colors.textFaint },
    errorBox: { backgroundColor: colors.dangerBg, marginHorizontal: spacing.lg, borderRadius: radius.sm, padding: spacing.sm + 2 },
    errorText: { color: colors.dangerMuted, fontSize: 12 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      height: ROW_HEIGHT,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: spacing.md,
    },
    rowPressed: { backgroundColor: colors.surface },
    rowContent: { flex: 1, gap: 2 },
    name: { color: colors.textSecondary, fontSize: 15, fontWeight: '500' },
    subtext: { color: colors.textFaint, fontSize: 12 },
    tagRow: { flexDirection: 'row', gap: 4, marginTop: 3, flexWrap: 'wrap' },
    tagPill: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8 },
    tagPillText: { color: colors.white, fontSize: 9, fontWeight: '600' },
    stageDot: { width: 10, height: 10, borderRadius: 5 },
    fab: {
      position: 'absolute',
      right: spacing.lg + 4,
      bottom: spacing.xl,
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOpacity: 0.3,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 4 },
      elevation: 4,
    },
    fabPressed: { opacity: 0.9 },
  });
}
