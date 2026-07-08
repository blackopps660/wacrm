import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../hooks/use-auth';
import { useAppTheme } from '../../../hooks/use-theme';
import { scaleFontSizes, type Palette } from '../../../lib/theme';
import { loadWorkspaces, switchWorkspace, type Workspace } from '../../../lib/workspaces/queries';
import { syncPushTokenWithBackend } from '../../../lib/push-notifications';

export default function WorkspacesScreen() {
  const router = useRouter();
  const { user, accountId, refreshProfile } = useAuth();
  const { colors, fontScale } = useAppTheme();
  const styles = useMemo(() => scaleFontSizes(makeStyles(colors), fontScale), [colors, fontScale]);

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setError(null);
    try {
      const rows = await loadWorkspaces(supabase, user.id, accountId);
      setWorkspaces(rows);
    } catch (err) {
      console.error('[Workspaces] load error:', err);
      setError(err instanceof Error ? err.message : 'Failed to load workspaces');
    }
  }, [user, accountId]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  async function handleSwitch(workspace: Workspace) {
    if (workspace.isCurrent || switchingId) return;
    setSwitchingId(workspace.id);
    setError(null);
    try {
      await switchWorkspace(supabase, workspace.id);
      // Mirrors the web app's full-page reload after a switch: refresh
      // the auth context's profile/account, then remount the tab stack
      // so Dashboard/Inbox/Contacts re-fetch under the new account_id.
      await refreshProfile();
      // Re-point this device's push token at the new account — otherwise
      // it stays registered under the workspace it was on at login time,
      // so pushes for the new workspace's messages never reach it.
      void syncPushTokenWithBackend();
      router.replace('/(tabs)');
    } catch (err) {
      console.error('[Workspaces] switch error:', err);
      setError(err instanceof Error ? err.message : 'Failed to switch workspace');
      setSwitchingId(null);
    }
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
      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}
      <FlatList
        data={workspaces}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        renderItem={({ item }) => (
          <Pressable
            style={[styles.row, item.isCurrent && styles.rowActive]}
            onPress={() => handleSwitch(item)}
            disabled={switchingId !== null}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.role}>{item.role}</Text>
            </View>
            {switchingId === item.id ? (
              <ActivityIndicator color={colors.accent} size="small" />
            ) : item.isCurrent ? (
              <Text style={styles.checkmark}>✓</Text>
            ) : null}
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
    errorBox: { backgroundColor: colors.dangerBg, margin: 16, borderRadius: 8, padding: 10 },
    errorText: { color: colors.dangerMuted, fontSize: 12 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 16,
      borderWidth: 1,
      borderColor: colors.border,
    },
    rowActive: { borderColor: colors.primary },
    name: { color: colors.text, fontSize: 15, fontWeight: '600' },
    role: { color: colors.textFaint, fontSize: 12, marginTop: 2, textTransform: 'capitalize' },
    checkmark: { color: colors.accent, fontSize: 18, fontWeight: '700' },
  });
}
