import { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../../hooks/use-auth';
import { useAppTheme } from '../../../hooks/use-theme';
import { Avatar } from '../../../components/Avatar';
import { radius, scaleFontSizes, spacing, type Palette } from '../../../lib/theme';

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
  const { profile, account, accountRole, canManageMembers, signOut } = useAuth();
  const { colors, fontScale } = useAppTheme();
  const styles = useMemo(() => scaleFontSizes(makeStyles(colors), fontScale), [colors, fontScale]);

  return (
    <View style={styles.container}>
      <View style={styles.profileHeader}>
        <Avatar label={profile?.full_name || profile?.email || '?'} size={56} />
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
        <SettingsRow
          icon="logo-whatsapp"
          value="WhatsApp Status"
          onPress={() => router.push('/settings/whatsapp')}
          colors={colors}
          styles={styles}
        />
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
