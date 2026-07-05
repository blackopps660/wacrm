import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../hooks/use-auth';
import { useRealtime } from '../../../hooks/use-realtime';
import type { Conversation } from '../../../lib/types';

const PAGE_SIZE = 30;
// Same embed shape as the web app's CONVERSATION_SELECT
// (src/lib/inbox/conversations.ts), minus the tags join Phase 1
// doesn't need yet.
const CONVERSATION_SELECT = '*, contact:contacts(*)';

export default function InboxListScreen() {
  const router = useRouter();
  const { accountId } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

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
  }, [fetchConversations, accountId]);

  // Live updates while the list is open — new/changed conversations
  // (new inbound message, unread count, status) refresh the whole list.
  // Simple full re-fetch for Phase 1; can optimize to patch-in-place later.
  useRealtime({
    channelName: 'mobile-inbox-list',
    onConversationEvent: () => {
      fetchConversations();
    },
    onMessageEvent: () => {
      fetchConversations();
    },
  });

  async function onRefresh() {
    setRefreshing(true);
    await fetchConversations();
    setRefreshing(false);
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#a78bfa" />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      data={conversations}
      keyExtractor={(item) => item.id}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor="#a78bfa"
        />
      }
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.emptyText}>No conversations yet.</Text>
        </View>
      }
      renderItem={({ item }) => {
        const isUnread = item.unread_count > 0;
        return (
          <Pressable
            style={styles.row}
            onPress={() => router.push(`/inbox/${item.id}`)}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {(item.contact?.name || item.contact?.phone || '?')
                  .charAt(0)
                  .toUpperCase()}
              </Text>
            </View>
            <View style={styles.rowContent}>
              <Text
                style={[styles.name, isUnread && styles.unreadText]}
                numberOfLines={1}
              >
                {item.contact?.name || item.contact?.phone || 'Unknown'}
              </Text>
              <Text
                style={[styles.preview, isUnread && styles.unreadPreview]}
                numberOfLines={1}
              >
                {item.last_message_text || 'No messages yet'}
              </Text>
            </View>
            {isUnread && (
              <View style={styles.unreadBadge}>
                <Text style={styles.unreadBadgeText}>{item.unread_count}</Text>
              </View>
            )}
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#020617' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyText: { color: '#64748b' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
    gap: 12,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(124,58,237,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#a78bfa', fontWeight: '700', fontSize: 16 },
  rowContent: { flex: 1 },
  name: { color: '#e2e8f0', fontSize: 15, fontWeight: '500' },
  unreadText: { color: '#f8fafc', fontWeight: '700' },
  preview: { color: '#64748b', fontSize: 13, marginTop: 2 },
  unreadPreview: { color: '#94a3b8' },
  unreadBadge: {
    backgroundColor: '#7c3aed',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  unreadBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
});
