import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { apiFetch } from '../../../lib/supabase';
import { useAuth } from '../../../hooks/use-auth';
import { useAppTheme } from '../../../hooks/use-theme';
import { scaleFontSizes, spacing, radius, type Palette } from '../../../lib/theme';

// Ported from src/app/(dashboard)/agents/page.tsx (web) — same
// GET /api/ai/agents list. Editing/creating (agent-edit.tsx) covers
// the core fields (name, provider, model, key, system prompt,
// auto-reply, routing). Deliberately does NOT port the knowledge-base
// (document upload + semantic search config) — pasting/uploading FAQ
// documents is a much better fit for a full keyboard and stays
// web-only for now; this screen's "Manage on web" note says so.

interface AgentSummary {
  id: string;
  name: string;
  provider: 'openai' | 'anthropic';
  model: string;
  isActive: boolean;
  autoReplyEnabled: boolean;
  isDefault: boolean;
}

export default function AgentsScreen() {
  const router = useRouter();
  const { canEditSettings } = useAuth();
  const { colors, fontScale } = useAppTheme();
  const styles = useMemo(() => scaleFontSizes(makeStyles(colors), fontScale), [colors, fontScale]);

  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch('/api/ai/agents', { method: 'GET' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to load agents');
      setAgents(body.agents ?? []);
    } catch (err) {
      console.error('[Agents] load error:', err);
      setError(err instanceof Error ? err.message : 'Failed to load agents');
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
      <FlatList
        data={agents}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm + 2 }}
        ListHeaderComponent={
          <View style={{ gap: spacing.sm + 2, marginBottom: 4 }}>
            {canEditSettings && (
              <Pressable
                style={styles.newButton}
                onPress={() => router.push({ pathname: '/settings/agent-edit', params: { id: 'new' } })}
              >
                <Ionicons name="add-circle-outline" size={16} color={colors.white} />
                <Text style={styles.newButtonText}>New agent</Text>
              </Pressable>
            )}
            <Text style={styles.note}>
              Knowledge base (documents/FAQ) and semantic search are managed on the web app — this
              covers persona, provider, and auto-reply settings.
            </Text>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyText}>No AI agents yet.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.card}
            onPress={() => router.push({ pathname: '/settings/agent-edit', params: { id: item.id } })}
          >
            <View style={{ flex: 1 }}>
              <View style={styles.cardTitleRow}>
                <Text style={styles.cardTitle}>{item.name}</Text>
                {item.isDefault && (
                  <View style={styles.defaultBadge}>
                    <Text style={styles.defaultBadgeText}>Default</Text>
                  </View>
                )}
              </View>
              <Text style={styles.cardSubtitle}>
                {item.provider === 'openai' ? 'OpenAI' : 'Anthropic'} · {item.model}
              </Text>
              <View style={styles.statusRow}>
                <View style={[styles.statusDot, { backgroundColor: item.isActive ? colors.success : colors.textFaint }]} />
                <Text style={styles.statusText}>{item.isActive ? 'Active' : 'Inactive'}</Text>
                {item.autoReplyEnabled && (
                  <>
                    <Text style={styles.statusSep}>·</Text>
                    <Text style={styles.statusText}>Auto-reply on</Text>
                  </>
                )}
              </View>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
          </Pressable>
        )}
      />
    </View>
  );
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    errorBox: { backgroundColor: colors.dangerBg, margin: spacing.lg, borderRadius: radius.sm, padding: spacing.sm + 2 },
    errorText: { color: colors.dangerMuted, fontSize: 12 },
    emptyText: { color: colors.textFaint, fontSize: 13 },
    note: { color: colors.textFaint, fontSize: 11, lineHeight: 16 },
    newButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.primary,
      borderRadius: radius.sm,
      paddingVertical: spacing.md,
    },
    newButtonText: { color: colors.white, fontWeight: '600', fontSize: 14 },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      padding: spacing.lg,
      borderWidth: 1,
      borderColor: colors.border,
      gap: spacing.sm,
    },
    cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    cardTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
    cardSubtitle: { color: colors.textFaint, fontSize: 12, marginTop: 2 },
    defaultBadge: {
      backgroundColor: colors.primaryMuted,
      borderRadius: 10,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    defaultBadgeText: { color: colors.accent, fontSize: 10, fontWeight: '700' },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    statusText: { color: colors.textMuted, fontSize: 11 },
    statusSep: { color: colors.textFaint, fontSize: 11 },
  });
}
