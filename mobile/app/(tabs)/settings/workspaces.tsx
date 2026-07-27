import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, FlatList, Pressable, StyleSheet, ActivityIndicator, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { supabase, apiFetch } from '../../../lib/supabase';
import { useAuth } from '../../../hooks/use-auth';
import { useAppTheme } from '../../../hooks/use-theme';
import { scaleFontSizes, type Palette } from '../../../lib/theme';
import { loadWorkspaces, switchWorkspace, type Workspace } from '../../../lib/workspaces/queries';
import { syncPushTokenWithBackend } from '../../../lib/push-notifications';

/**
 * Rename + lock for the CURRENT workspace — ported from
 * src/components/settings/workspace-general-settings.tsx (web). Goes
 * through the same PATCH /api/account route (admin+, and rejects a
 * rename with 423 while locked), so this can't drift from web's rules.
 */
function WorkspaceGeneralCard({
  colors,
  styles,
  canEditSettings,
  refreshProfile,
}: {
  colors: Palette;
  styles: ReturnType<typeof makeStyles>;
  canEditSettings: boolean;
  refreshProfile: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [isLocked, setIsLocked] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [togglingLock, setTogglingLock] = useState(false);
  const [originalName, setOriginalName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/account');
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          account: { name: string; is_locked: boolean };
        };
        if (!cancelled) {
          setName(data.account.name);
          setOriginalName(data.account.name);
          setIsLocked(data.account.is_locked);
          setLoaded(true);
        }
      } catch (err) {
        console.error('[WorkspaceGeneralCard] load error:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = loaded && name.trim() !== originalName;

  async function handleSaveName() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSavingName(true);
    setError(null);
    try {
      const res = await apiFetch('/api/account', {
        method: 'PATCH',
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Failed to rename workspace');
        return;
      }
      setOriginalName(trimmed);
      await refreshProfile();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the server');
    } finally {
      setSavingName(false);
    }
  }

  async function handleToggleLock() {
    const next = !isLocked;
    setTogglingLock(true);
    setError(null);
    try {
      const res = await apiFetch('/api/account', {
        method: 'PATCH',
        body: JSON.stringify({ is_locked: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Failed to update lock');
        return;
      }
      setIsLocked(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the server');
    } finally {
      setTogglingLock(false);
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Workspace name</Text>
      {error && <Text style={styles.errorTextInline}>{error}</Text>}
      <TextInput
        style={[styles.input, (isLocked || !canEditSettings) && { opacity: 0.6 }]}
        value={name}
        onChangeText={setName}
        editable={!isLocked && canEditSettings && loaded}
        placeholder="Workspace name"
        placeholderTextColor={colors.textFaint}
      />
      {isLocked ? (
        <Text style={styles.lockHint}>Locked — unlock below before renaming.</Text>
      ) : !canEditSettings ? (
        <Text style={styles.lockHint}>Only account admins can rename the workspace.</Text>
      ) : null}

      {canEditSettings && (
        <Pressable
          style={[styles.smallButton, (!dirty || isLocked || savingName) && { opacity: 0.5 }]}
          onPress={handleSaveName}
          disabled={!dirty || isLocked || savingName}
        >
          {savingName ? (
            <ActivityIndicator color={colors.white} size="small" />
          ) : (
            <Text style={styles.smallButtonText}>Save name</Text>
          )}
        </Pressable>
      )}

      <View style={styles.lockRow}>
        <Ionicons
          name={isLocked ? 'lock-closed' : 'lock-open'}
          size={16}
          color={isLocked ? colors.dangerMuted : colors.accent}
        />
        <Text style={styles.lockRowText}>
          {isLocked ? 'Locked' : 'Unlocked'} — protects only the name above; messaging keeps working either way.
        </Text>
      </View>
      {canEditSettings && (
        <Pressable
          style={[styles.outlineButton, togglingLock && { opacity: 0.6 }]}
          onPress={handleToggleLock}
          disabled={togglingLock || !loaded}
        >
          {togglingLock ? (
            <ActivityIndicator color={colors.accent} size="small" />
          ) : (
            <Text style={styles.outlineButtonText}>
              {isLocked ? 'Unlock workspace' : 'Lock workspace'}
            </Text>
          )}
        </Pressable>
      )}
    </View>
  );
}

/**
 * Owner-only delete for the CURRENT workspace — ported from web's danger
 * zone in workspace-general-settings.tsx. Same DELETE
 * /api/account/workspaces/[id] route, so the owner check, "not your only
 * workspace" guard, and cascade all live server-side either way; this is
 * just the type-to-confirm gate on the client.
 */
function DangerZoneCard({
  colors,
  styles,
  accountId,
  accountName,
  onDeleted,
}: {
  colors: Palette;
  styles: ReturnType<typeof makeStyles>;
  accountId: string;
  accountName: string;
  onDeleted: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = confirmName.trim() === accountName.trim();

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/account/workspaces/${accountId}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Failed to delete workspace');
        setDeleting(false);
        return;
      }
      setConfirmOpen(false);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the server');
      setDeleting(false);
    }
  }

  return (
    <View style={[styles.card, styles.dangerCard]}>
      <View style={styles.dangerTitleRow}>
        <Ionicons name="warning-outline" size={16} color={colors.dangerMuted} />
        <Text style={[styles.cardTitle, { color: colors.dangerMuted }]}>Delete workspace</Text>
      </View>
      <Text style={styles.lockRowText}>
        Permanently deletes this workspace and everything in it — contacts, conversations,
        messages, templates and settings. This cannot be undone.
      </Text>
      <Pressable
        style={styles.dangerButton}
        onPress={() => {
          setConfirmName('');
          setError(null);
          setConfirmOpen(true);
        }}
      >
        <Ionicons name="trash-outline" size={16} color={colors.dangerMuted} />
        <Text style={styles.dangerButtonText}>Delete this workspace</Text>
      </Pressable>

      <Modal
        visible={confirmOpen}
        transparent
        animationType="fade"
        onRequestClose={() => (deleting ? null : setConfirmOpen(false))}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={[styles.cardTitle, { color: colors.dangerMuted }]}>
              Delete “{accountName}”?
            </Text>
            <Text style={styles.lockRowText}>
              This wipes all of this workspace&apos;s data permanently. Type the workspace name
              to confirm.
            </Text>
            {error && <Text style={styles.errorTextInline}>{error}</Text>}
            <TextInput
              style={styles.input}
              value={confirmName}
              onChangeText={setConfirmName}
              placeholder={accountName}
              placeholderTextColor={colors.textFaint}
              autoFocus
              editable={!deleting}
            />
            <View style={styles.modalActions}>
              <Pressable
                style={[styles.outlineButton, { flex: 1 }]}
                onPress={() => setConfirmOpen(false)}
                disabled={deleting}
              >
                <Text style={styles.outlineButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.dangerButton,
                  styles.dangerButtonFilled,
                  { flex: 1 },
                  (!matches || deleting) && { opacity: 0.5 },
                ]}
                onPress={handleDelete}
                disabled={!matches || deleting}
              >
                {deleting ? (
                  <ActivityIndicator color={colors.white} size="small" />
                ) : (
                  <>
                    <Ionicons name="trash-outline" size={16} color={colors.white} />
                    <Text style={[styles.dangerButtonText, { color: colors.white }]}>Delete</Text>
                  </>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

export default function WorkspacesScreen() {
  const router = useRouter();
  const { user, account, accountId, isOwner, canEditSettings, refreshProfile } = useAuth();
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

  async function handleDeleted() {
    // The DELETE route's RPC already relocated our profile.account_id
    // server-side — same post-action shape as handleSwitch above:
    // refresh the auth context, re-point push, remount the tab stack.
    await refreshProfile();
    void syncPushTokenWithBackend();
    router.replace('/(tabs)');
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
        ListHeaderComponent={
          <View style={{ gap: 10, marginBottom: 4 }}>
            <WorkspaceGeneralCard
              colors={colors}
              styles={styles}
              canEditSettings={canEditSettings}
              refreshProfile={refreshProfile}
            />
            {isOwner && accountId && (
              <DangerZoneCard
                colors={colors}
                styles={styles}
                accountId={accountId}
                accountName={account?.name ?? ''}
                onDeleted={handleDeleted}
              />
            )}
            {workspaces.length > 1 && <Text style={styles.sectionLabel}>Switch workspace</Text>}
          </View>
        }
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
    sectionLabel: {
      color: colors.textFaint,
      fontSize: 12,
      fontWeight: '600',
      textTransform: 'uppercase',
      letterSpacing: 0.4,
      marginTop: 4,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 16,
      borderWidth: 1,
      borderColor: colors.border,
      gap: 8,
    },
    cardTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
    errorTextInline: { color: colors.dangerMuted, fontSize: 12 },
    input: {
      backgroundColor: colors.surfaceRaised,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: colors.text,
    },
    lockHint: { color: colors.textFaint, fontSize: 11 },
    smallButton: {
      backgroundColor: colors.primary,
      borderRadius: 8,
      paddingVertical: 10,
      alignItems: 'center',
      alignSelf: 'flex-start',
      paddingHorizontal: 16,
    },
    smallButtonText: { color: colors.white, fontWeight: '600', fontSize: 13 },
    lockRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 8,
    },
    lockRowText: { color: colors.textFaint, fontSize: 11, flex: 1 },
    outlineButton: {
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: 8,
      paddingVertical: 10,
      alignItems: 'center',
    },
    outlineButtonText: { color: colors.textSecondary, fontWeight: '600', fontSize: 13 },
    dangerCard: { borderColor: colors.dangerBorder },
    dangerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    dangerButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderWidth: 1,
      borderColor: colors.dangerBorder,
      borderRadius: 8,
      paddingVertical: 10,
      paddingHorizontal: 16,
      alignSelf: 'flex-start',
      marginTop: 4,
    },
    dangerButtonFilled: { backgroundColor: colors.danger, borderColor: colors.danger },
    dangerButtonText: { color: colors.dangerMuted, fontWeight: '600', fontSize: 13 },
    modalBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    modalCard: {
      width: '100%',
      maxWidth: 380,
      backgroundColor: colors.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 16,
      gap: 10,
    },
    modalActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  });
}
