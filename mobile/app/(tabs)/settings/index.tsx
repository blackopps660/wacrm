import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../../hooks/use-auth';

export default function SettingsScreen() {
  const router = useRouter();
  const { profile, account, accountRole, canManageMembers, signOut } = useAuth();

  return (
    <View style={styles.container}>
      <Pressable style={styles.row} onPress={() => router.push('/settings/profile')}>
        <View>
          <Text style={styles.rowLabel}>Signed in as</Text>
          <Text style={styles.rowValue}>{profile?.full_name || profile?.email || '—'}</Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </Pressable>

      <Pressable style={styles.row} onPress={() => router.push('/settings/workspaces')}>
        <View>
          <Text style={styles.rowLabel}>Workspace</Text>
          <Text style={styles.rowValue}>
            {account?.name ?? '—'} · <Text style={styles.roleInline}>{accountRole ?? '—'}</Text>
          </Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </Pressable>

      {canManageMembers && (
        <Pressable style={styles.row} onPress={() => router.push('/settings/team')}>
          <Text style={styles.rowValue}>Team Members</Text>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      )}

      <Pressable style={styles.row} onPress={() => router.push('/settings/whatsapp')}>
        <Text style={styles.rowValue}>WhatsApp Status</Text>
        <Text style={styles.chevron}>›</Text>
      </Pressable>

      <Pressable style={styles.signOutButton} onPress={signOut}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#020617', padding: 16, gap: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  rowLabel: { color: '#64748b', fontSize: 12 },
  rowValue: { color: '#f8fafc', fontSize: 15, fontWeight: '500', marginTop: 2 },
  roleInline: { color: '#94a3b8', fontSize: 13, textTransform: 'capitalize' },
  chevron: { color: '#64748b', fontSize: 20 },
  signOutButton: {
    marginTop: 8,
    backgroundColor: 'rgba(239,68,68,0.15)',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.3)',
  },
  signOutText: { color: '#fca5a5', fontWeight: '600' },
});
