import { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../../hooks/use-auth';
import { useAppTheme } from '../../../hooks/use-theme';
import { useWhatsappStatus, type WhatsappStatus } from '../../../hooks/use-whatsapp-status';
import { Avatar } from '../../../components/Avatar';
import { radius, scaleFontSizes, spacing, type Palette } from '../../../lib/theme';

function statusDotColor(status: WhatsappStatus, colors: Palette): string {
  if (status === 'green') return colors.success;
  if (status === 'yellow') return '#F59E0B';
  if (status === 'red') return colors.danger;
  return colors.textFaint;
}

function statusLabel(status: WhatsappStatus): string {
  if (status === 'green') return 'Connected';
  if (status === 'yellow') return 'Needs attention';
  if (status === 'red') return 'Not connected';
  return 'Checking…';
}

function SettingsRow({
  icon,
  label,
  value,
  onPress,
  colors,
  styles,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label?: string;
  value: string;
  onPress: () => void;
  colors: Palette;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.rowPressed]} onPress={onPress}>
      <View style={styles.rowIcon}>
        <Ionicons name={icon} size={18} color={colors.accent} />
      </View>
      <View style={{ flex: 1 }}>
        {label && <Text style={styles.rowLabel}>{label}</Text>}
        <Text style={styles.rowValue}>{value}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
    </Pressable>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const { profile, account, accountRole, canManageMembers, canEditSettings, signOut } = useAuth();
  const { colors, fontScale } = useAppTheme();
  const styles = useMemo(() => scaleFontSizes(makeStyles(colors), fontScale), [colors, fontScale]);
  const waStatus = useWhatsappStatus();

  return (
    <View style={styles.container}>
      <View style={styles.profileHeader}>
        <View>
          <Avatar label={profile?.full_name || profile?.email || '?'} size={56} />
          {/* WhatsApp connection health — green/amber/red/grey, same
           *  classification as the web sidebar's dot. */}
          <View
            style={[
              styles.statusDot,
              { backgroundColor: statusDotColor(waStatus, colors), borderColor: colors.surface },
            ]}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.profileName} numberOfLines={1}>
            {profile?.full_name || 'Unnamed'}
          </Text>
          <Text style={styles.profileEmail} numberOfLines={1}>
            {profile?.email}
          </Text>
        </View>
      </View>

      <View style={styles.section}>
        <SettingsRow
          icon="person-outline"
          label="Signed in as"
          value={profile?.full_name || profile?.email || '—'}
          onPress={() => router.push('/settings/profile')}
          colors={colors}
          styles={styles}
        />
        <SettingsRow
          icon="business-outline"
          label="Workspace"
          value={`${account?.name ?? '—'} · ${accountRole ? accountRole.charAt(0).toUpperCase() + accountRole.slice(1) : '—'}`}
          onPress={() => router.push('/settings/workspaces')}
          colors={colors}
          styles={styles}
        />
        {canManageMembers && (
          <SettingsRow
            icon="people-outline"
            value="Team Members"
            onPress={() => router.push('/settings/team')}
            colors={colors}
            styles={styles}
          />
        )}
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => router.push('/settings/whatsapp')}
        >
          <View style={styles.rowIcon}>
            <Ionicons name="logo-whatsapp" size={18} color={colors.accent} />
          </View>
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
            <Text style={styles.rowValue}>WhatsApp Status</Text>
            <View
              style={[styles.inlineDot, { backgroundColor: statusDotColor(waStatus, colors) }]}
            />
            <Text style={styles.rowSubtle}>{statusLabel(waStatus)}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
        </Pressable>
        {canEditSettings && (
          <SettingsRow
            icon="sparkles-outline"
            value="AI Agents"
            onPress={() => router.push('/settings/agents')}
            colors={colors}
            styles={styles}
          />
        )}
        <SettingsRow
          icon="color-palette-outline"
          value="Appearance"
          onPress={() => router.push('/settings/appearance')}
          colors={colors}
          styles={styles}
        />
      </View>

      <Pressable style={({ pressed }) => [styles.signOutButton, pressed && { opacity: 0.85 }]} onPress={signOut}>
        <Ionicons name="log-out-outline" size={18} color={colors.dangerMuted} />
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg, padding: spacing.lg, gap: spacing.lg },
    profileHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      padding: spacing.lg,
      borderWidth: 1,
      borderColor: colors.border,
    },
    profileName: { color: colors.text, fontSize: 17, fontWeight: '700' },
    profileEmail: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
    statusDot: {
      position: 'absolute',
      bottom: -1,
      right: -1,
      width: 14,
      height: 14,
      borderRadius: 7,
      borderWidth: 2,
    },
    inlineDot: { width: 7, height: 7, borderRadius: 3.5 },
    rowSubtle: { color: colors.textFaint, fontSize: 12 },
    section: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: 'hidden',
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    rowPressed: { backgroundColor: colors.surfaceRaised },
    rowIcon: {
      width: 32,
      height: 32,
      borderRadius: radius.sm,
      backgroundColor: colors.primaryMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowLabel: { color: colors.textFaint, fontSize: 12 },
    rowValue: { color: colors.text, fontSize: 15, fontWeight: '500', marginTop: 2 },
    signOutButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      backgroundColor: colors.dangerBg,
      borderRadius: radius.sm,
      paddingVertical: spacing.md + 2,
      borderWidth: 1,
      borderColor: colors.dangerBorder,
    },
    signOutText: { color: colors.dangerMuted, fontWeight: '600' },
  });
}
