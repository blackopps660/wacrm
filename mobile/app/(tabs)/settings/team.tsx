import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { apiFetch } from '../../../lib/supabase';
import { useAuth } from '../../../hooks/use-auth';
import { useAppTheme } from '../../../hooks/use-theme';
import { scaleFontSizes, type Palette } from '../../../lib/theme';
import type { AccountRole } from '../../../lib/roles';

// Uses the existing /api/account/members (+ /[userId]) routes, now
// Bearer-auth capable — same SECURITY DEFINER RPCs
// (set_member_role / remove_account_member) the web Members tab
// uses, so no new backend logic, just a new client of it.

interface AccountMember {
  user_id: string;
  full_name: string;
  email: string | null;
  avatar_url: string | null;
  role: AccountRole;
  joined_at: string;
}

const ROLES: AccountRole[] = ['admin', 'agent', 'viewer'];

export default function TeamScreen() {
  const { user, canManageMembers } = useAuth();
  const { colors, fontScale } = useAppTheme();
  const styles = useMemo(() => scaleFontSizes(makeStyles(colors), fontScale), [colors, fontScale]);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch('/api/account/members', { method: 'GET' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to load members');
      setMembers(body.members ?? []);
    } catch (err) {
      console.error('[Team] load error:', err);
      setError(err instanceof Error ? err.message : 'Failed to load members');
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  async function handleRoleChange(userId: string, role: AccountRole) {
    setBusyUserId(userId);
    setError(null);
    try {
      const res = await apiFetch(`/api/account/members/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to change role');
      setMembers((prev) => prev.map((m) => (m.user_id === userId ? { ...m, role } : m)));
      setEditingUserId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change role');
    } finally {
      setBusyUserId(null);
    }
  }

  async function handleRemove(userId: string) {
    setBusyUserId(userId);
    setError(null);
    try {
      const res = await apiFetch(`/api/account/members/${userId}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to remove member');
      setMembers((prev) => prev.filter((m) => m.user_id !== userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    } finally {
      setBusyUserId(null);
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
        data={members}
        keyExtractor={(item) => item.user_id}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        renderItem={({ item }) => {
          const isSelf = item.user_id === user?.id;
          const isOwner = item.role === 'owner';
          const canEdit = canManageMembers && !isSelf && !isOwner;
          const isBusy = busyUserId === item.user_id;
          const isEditing = editingUserId === item.user_id;

          return (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{item.full_name || item.email || 'Unnamed'}</Text>
                  {item.email && <Text style={styles.email}>{item.email}</Text>}
                </View>
                {isBusy ? (
                  <ActivityIndicator color={colors.accent} size="small" />
                ) : (
                  <Pressable
                    disabled={!canEdit}
                    onPress={() => setEditingUserId(isEditing ? null : item.user_id)}
                    style={styles.roleBadge}
                  >
                    <Text style={styles.roleBadgeText}>{item.role}</Text>
                  </Pressable>
                )}
              </View>

              {isEditing && canEdit && (
                <View style={styles.roleOptions}>
                  {ROLES.map((r) => (
                    <Pressable
                      key={r}
                      onPress={() => handleRoleChange(item.user_id, r)}
                      style={[styles.roleOption, r === item.role && styles.roleOptionActive]}
                    >
                      <Text style={styles.roleOptionText}>{r}</Text>
                    </Pressable>
                  ))}
                  <Pressable onPress={() => handleRemove(item.user_id)} style={styles.removeButton}>
                    <Text style={styles.removeButtonText}>Remove from workspace</Text>
                  </Pressable>
                </View>
              )}
            </View>
          );
        }}
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
    card: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.border,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    name: { color: colors.text, fontSize: 15, fontWeight: '600' },
    email: { color: colors.textFaint, fontSize: 12, marginTop: 2 },
    roleBadge: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 12,
      backgroundColor: colors.surfaceRaised,
    },
    roleBadgeText: { color: colors.accent, fontSize: 12, fontWeight: '600', textTransform: 'capitalize' },
    roleOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
    roleOption: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 14,
      backgroundColor: colors.surfaceRaised,
      borderWidth: 1,
      borderColor: colors.borderStrong,
    },
    roleOptionActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    roleOptionText: { color: colors.textSecondary, fontSize: 12, textTransform: 'capitalize' },
    removeButton: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 14,
      backgroundColor: colors.dangerBg,
      borderWidth: 1,
      borderColor: colors.dangerBorder,
    },
    removeButtonText: { color: colors.dangerMuted, fontSize: 12 },
  });
}
