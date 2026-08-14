import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator, Modal, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../hooks/use-auth';
import { useAppTheme } from '../../../hooks/use-theme';
import { Avatar } from '../../../components/Avatar';
import { radius, scaleFontSizes, spacing, type Palette } from '../../../lib/theme';
import type { Conversation } from '../../../lib/types';

const CONVERSATION_SELECT = '*, contact:contacts(*, lifecycle_stage:lifecycle_stages(*))';

export default function ArchivedScreen() {
  const router = useRouter();
  const { accountId } = useAuth();
  const { colors, fontScale } = useAppTheme();
  const styles = useMemo(() => scaleFontSizes(makeStyles(colors), fontScale), [colors, fontScale]);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionTarget, setActionTarget] = useState<Conversation | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .not('archived_at', 'is', null)
      .is('deleted_at', null)
      .order('archived_at', { ascending: false });
    if (error) {
      console.error('[Archived] fetch error:', error.message);
      return;
    }
    setConversations((data as unknown as Conversation[]) ?? []);
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load, accountId]);

  function handlePress(item: Conversation) {
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
  }

  async function handleUnarchive(item: Conversation) {
    setActionTarget(null);
    setConversations((prev) => prev.filter((c) => c.id !== item.id));
    await supabase.from('conversations').update({ archived_at: null }).eq('id', item.id);
  }

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
            setConversations((prev) => prev.filter((c) => c.id !== item.id));
            await supabase
              .from('conversations')
              .update({ deleted_at: new Date().toISOString() })
              .eq('id', item.id);
          },
        },
      ],
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={conversations}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyText}>No archived chats</Text>
          </View>
        }
        renderItem={({ item }) => {
          const label = item.contact?.name || item.contact?.phone || 'Unknown';
          return (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => handlePress(item)}
              onLongPress={() => setActionTarget(item)}
              delayLongPress={350}
            >
              <Avatar label={label} seed={item.contact?.id} size={48} showChannelBadge />
              <View style={styles.rowContent}>
                <Text style={styles.name} numberOfLines={1}>
                  {label}
                </Text>
                <Text style={styles.preview} numberOfLines={1}>
                  {item.last_message_text || 'No messages yet'}
                </Text>
              </View>
            </Pressable>
          );
        }}
      />

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
                <Pressable style={styles.menuItem} onPress={() => handleUnarchive(actionTarget)}>
                  <Ionicons name="archive-outline" size={20} color={colors.textSecondary} />
                  <Text style={styles.menuItemText}>Unarchive Chat</Text>
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
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
    emptyText: { color: colors.textFaint },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm + 4,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: spacing.md,
    },
    rowPressed: { backgroundColor: colors.surface },
    rowContent: { flex: 1, gap: 4 },
    name: { color: colors.textSecondary, fontSize: 15, fontWeight: '500' },
    preview: { color: colors.textFaint, fontSize: 13 },
    modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    menuCard: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: radius.lg + 8,
      borderTopRightRadius: radius.lg + 8,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.xl,
      gap: 4,
    },
    sheetHandle: {
      alignSelf: 'center',
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.borderStrong,
      marginBottom: spacing.sm,
    },
    menuItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
    menuItemText: { color: colors.textSecondary, fontSize: 15 },
  });
}
