// Single source of truth for the mobile app's visual language.
// `colors` stays exported as the dark palette for any not-yet-themed
// call site, but every screen should really get its palette from
// `useAppTheme()` (hooks/use-theme.tsx) so it reacts to the user's
// Settings > Appearance choice instead of being locked to dark mode.

export interface Palette {
  bg: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  borderStrong: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  textFaint: string;
  primary: string;
  primaryMuted: string;
  accent: string;
  info: string;
  success: string;
  successMuted: string;
  danger: string;
  dangerMuted: string;
  dangerBg: string;
  dangerBorder: string;
  white: string;
}

export const darkColors: Palette = {
  // Backgrounds
  bg: '#020617',
  surface: '#0f172a',
  surfaceRaised: '#141e33',
  border: '#1e293b',
  borderStrong: '#334155',

  // Text
  text: '#f8fafc',
  textSecondary: '#e2e8f0',
  textMuted: '#94a3b8',
  textFaint: '#64748b',

  // Brand
  primary: '#7c3aed',
  primaryMuted: 'rgba(124,58,237,0.15)',
  accent: '#a78bfa',

  // Chart / secondary accent
  info: '#38bdf8',

  // Status
  success: '#4ade80',
  successMuted: '#86efac',
  danger: '#f87171',
  dangerMuted: '#fca5a5',
  dangerBg: 'rgba(239,68,68,0.1)',
  dangerBorder: 'rgba(239,68,68,0.3)',

  white: '#ffffff',
} as const;

export const lightColors: Palette = {
  bg: '#f1f5f9',
  surface: '#ffffff',
  surfaceRaised: '#f8fafc',
  border: '#e2e8f0',
  borderStrong: '#cbd5e1',

  text: '#0f172a',
  textSecondary: '#1e293b',
  textMuted: '#475569',
  textFaint: '#94a3b8',

  primary: '#7c3aed',
  primaryMuted: 'rgba(124,58,237,0.1)',
  accent: '#7c3aed',

  info: '#0284c7',

  success: '#16a34a',
  successMuted: '#4ade80',
  danger: '#dc2626',
  dangerMuted: '#ef4444',
  dangerBg: 'rgba(220,38,38,0.08)',
  dangerBorder: 'rgba(220,38,38,0.25)',

  white: '#ffffff',
};

/** @deprecated Prefer `useAppTheme().colors` — kept for any call site not yet wired to the theme context. */
export const colors = darkColors;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
  avatar: 999,
} as const;

export const typography = {
  title: { fontSize: 22, fontWeight: '700' as const },
  heading: { fontSize: 16, fontWeight: '600' as const },
  body: { fontSize: 15, fontWeight: '400' as const },
  label: { fontSize: 13, fontWeight: '500' as const },
  caption: { fontSize: 12, fontWeight: '400' as const },
  micro: { fontSize: 11, fontWeight: '400' as const },
};

export const avatarPalette = [
  '#7c3aed',
  '#38bdf8',
  '#22c55e',
  '#f59e0b',
  '#ec4899',
  '#14b8a6',
  '#f43f5e',
  '#8b5cf6',
] as const;

/** Deterministic color for an avatar based on a stable id/name, so the same contact always gets the same color. */
export function colorForSeed(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return avatarPalette[Math.abs(hash) % avatarPalette.length];
}

/**
 * Applies the user's font-size preference to a finished style sheet by
 * scaling every `fontSize` it finds. Screens build their styles with
 * `useMemo(() => scaleFontSizes(makeStyles(colors), fontScale), [colors, fontScale])`
 * instead of a module-level `StyleSheet.create` — that's what makes
 * both color AND font-size preferences apply without every screen
 * having to hand-multiply each of its own font sizes.
 */
export function scaleFontSizes<T extends Record<string, object>>(
  styleSheet: T,
  fontScale: number,
): T {
  if (fontScale === 1) return styleSheet;
  const scaled: Record<string, object> = {};
  for (const key of Object.keys(styleSheet)) {
    const style = styleSheet[key] as Record<string, unknown>;
    if (typeof style.fontSize === 'number') {
      scaled[key] = { ...style, fontSize: Math.round(style.fontSize * fontScale) };
    } else {
      scaled[key] = style;
    }
  }
  return scaled as T;
}
