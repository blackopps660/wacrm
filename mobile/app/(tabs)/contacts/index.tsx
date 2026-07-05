import { useCallback, useEffect, useRef, useState } from 'react';
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
import { supabase } from '../../../lib/supabase';
import {
  loadTags,
  loadLifecycleStages,
  loadContacts,
  hydrateContactTags,
  PAGE_SIZE,
} from '../../../lib/contacts/queries';
import type { Contact, Tag, LifecycleStage } from '../../../lib/types';

export default function ContactsListScreen() {
  const router = useRouter();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [stages, setStages] = useState<LifecycleStage[]>([]);
  const [search, setSearch] = useState('');
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Drops stale responses when filters change rapidly — same
  // protection the web page uses.
  const fetchSeq = useRef(0);

  useEffect(() => {
    loadTags(supabase).then(setTags).catch(console.error);
    loadLifecycleStages(supabase).then(setStages).catch(console.error);
  }, []);

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

  // Re-fetch page 0 whenever filters change (tags must be loaded first
  // so hydration has a map to work with).
  useEffect(() => {
    if (tags.length === 0 && stages.length === 0) return;
    setLoading(true);
    fetchPage(0, false).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, selectedTagIds, selectedStageId, tags]);

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

  return (
    <View style={styles.container}>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search name, phone, email…"
          placeholderTextColor="#64748b"
          value={search}
          onChangeText={setSearch}
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
            contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
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
          <ActivityIndicator color="#a78bfa" />
        </View>
      ) : (
        <FlatList
          data={contacts}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#a78bfa" />
          }
          onEndReached={onEndReached}
          onEndReachedThreshold={0.4}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyText}>No contacts found</Text>
            </View>
          }
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator color="#a78bfa" style={{ marginVertical: 16 }} />
            ) : null
          }
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => router.push(`/contacts/${item.id}`)}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {(item.name || item.phone).charAt(0).toUpperCase()}
                </Text>
              </View>
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
          )}
        />
      )}

      <Pressable style={styles.fab} onPress={() => router.push('/contacts/new')}>
        <Text style={styles.fabText}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#020617' },
  searchRow: { padding: 16, paddingBottom: 8 },
  searchInput: {
    backgroundColor: '#1e293b',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#f8fafc',
  },
  filterRow: { paddingBottom: 8 },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#334155',
  },
  filterChipText: { color: '#94a3b8', fontSize: 12 },
  filterChipTextActive: { color: '#fff', fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyText: { color: '#64748b' },
  errorBox: { backgroundColor: 'rgba(239,68,68,0.1)', margin: 16, borderRadius: 8, padding: 10 },
  errorText: { color: '#fca5a5', fontSize: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    gap: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(124,58,237,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#a78bfa', fontWeight: '700' },
  rowContent: { flex: 1, gap: 2 },
  name: { color: '#e2e8f0', fontSize: 15, fontWeight: '500' },
  subtext: { color: '#64748b', fontSize: 12 },
  tagRow: { flexDirection: 'row', gap: 4, marginTop: 4, flexWrap: 'wrap' },
  tagPill: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8 },
  tagPillText: { color: '#fff', fontSize: 9, fontWeight: '600' },
  stageDot: { width: 10, height: 10, borderRadius: 5 },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#7c3aed',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  fabText: { color: '#fff', fontSize: 26, fontWeight: '400', marginTop: -2 },
});
