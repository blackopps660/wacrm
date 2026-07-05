import { useCallback, useEffect, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../hooks/use-auth';
import { loadWorkspaces, switchWorkspace, type Workspace } from '../../../lib/workspaces/queries';

export default function WorkspacesScreen() {
  const router = useRouter();
  const { user, accountId, refreshProfile } = useAuth();

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
        <ActivityIndicator color="#a78bfa" />
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
              <ActivityIndicator color="#a78bfa" size="small" />
            ) : item.isCurrent ? (
              <Text style={styles.checkmark}>✓</Text>
            ) : null}
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#020617' },
  center: { flex: 1, backgroundColor: '#020617', alignItems: 'center', justifyContent: 'center' },
  errorBox: { backgroundColor: 'rgba(239,68,68,0.1)', margin: 16, borderRadius: 8, padding: 10 },
  errorText: { color: '#fca5a5', fontSize: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  rowActive: { borderColor: '#7c3aed' },
  name: { color: '#f8fafc', fontSize: 15, fontWeight: '600' },
  role: { color: '#64748b', fontSize: 12, marginTop: 2, textTransform: 'capitalize' },
  checkmark: { color: '#a78bfa', fontSize: 18, fontWeight: '700' },
});
