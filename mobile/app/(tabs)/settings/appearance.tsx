import { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme, type ThemeMode, type FontSize } from '../../../hooks/use-theme';
import { radius, scaleFontSizes, spacing, type Palette } from '../../../lib/theme';

const MODE_OPTIONS: { value: ThemeMode; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { value: 'system', label: 'System', icon: 'phone-portrait-outline' },
  { value: 'light', label: 'Light', icon: 'sunny-outline' },
  { value: 'dark', label: 'Dark', icon: 'moon-outline' },
];

const FONT_OPTIONS: { value: FontSize; label: string; sample: number }[] = [
  { value: 'small', label: 'Small', sample: 13 },
  { value: 'medium', label: 'Medium', sample: 15 },
  { value: 'large', label: 'Large', sample: 17 },
  { value: 'xlarge', label: 'Extra Large', sample: 19 },
];

export default function AppearanceScreen() {
  const { colors, mode, setMode, fontSize, setFontSize, fontScale } = useAppTheme();
  const styles = useMemo(() => scaleFontSizes(makeStyles(colors), fontScale), [colors, fontScale]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Theme</Text>
      <View style={styles.card}>
        {MODE_OPTIONS.map((opt, i) => {
          const active = mode === opt.value;
          return (
            <Pressable
              key={opt.value}
              style={[styles.row, i < MODE_OPTIONS.length - 1 && styles.rowBorder]}
              onPress={() => setMode(opt.value)}
            >
              <Ionicons name={opt.icon} size={20} color={active ? colors.accent : colors.textMuted} />
              <Text style={[styles.rowLabel, active && styles.rowLabelActive]}>{opt.label}</Text>
              {active && <Ionicons name="checkmark" size={20} color={colors.accent} />}
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.sectionTitle}>Font Size</Text>
      <View style={styles.card}>
        {FONT_OPTIONS.map((opt, i) => {
          const active = fontSize === opt.value;
          return (
            <Pressable
              key={opt.value}
              style={[styles.row, i < FONT_OPTIONS.length - 1 && styles.rowBorder]}
              onPress={() => setFontSize(opt.value)}
            >
              <Text style={[styles.sampleText, { fontSize: opt.sample }]}>Aa</Text>
              <Text style={[styles.rowLabel, active && styles.rowLabelActive]}>{opt.label}</Text>
              {active && <Ionicons name="checkmark" size={20} color={colors.accent} />}
            </Pressable>
          );
        })}
      </View>

      <View style={styles.previewCard}>
        <Text style={styles.previewTitle}>Preview</Text>
        <Text style={styles.previewBody}>
          This is how message text and labels will look across the app with your current settings.
        </Text>
      </View>
    </ScrollView>
  );
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xl * 2 },
    sectionTitle: {
      color: colors.textFaint,
      fontSize: 12,
      fontWeight: '600',
      textTransform: 'uppercase',
      marginBottom: -spacing.sm,
    },
    card: {
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
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md + 2,
    },
    rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
    rowLabel: { flex: 1, color: colors.textSecondary, fontSize: 15 },
    rowLabelActive: { color: colors.text, fontWeight: '600' },
    sampleText: { color: colors.textMuted, fontWeight: '700', width: 28, textAlign: 'center' },
    previewCard: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.lg,
      gap: spacing.xs,
    },
    previewTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
    previewBody: { color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  });
}
