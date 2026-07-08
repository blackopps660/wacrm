// Single source of truth for the mobile app's visual language.
// `colors` stays exported as the dark palette for any not-yet-themed
// call site, but every screen should really get its palette from
// `useAppTheme()` (hooks/use-theme.tsx) so it reacts to the user's
// Settings > Appearance choice instead of being locked to dark mode.

export interface Palette {
  bg: string;
  /** Message-list background specifically — WhatsApp gives the chat
   * screen its own distinct tone (a wallpaper-like beige in light mode,
   * a near-black teal in dark mode) rather than reusing the general
   * app background everywhere. */
  chatBg: string;
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
  /** Outgoing (agent) chat bubble background/text/meta — WhatsApp's
   * bubble colors don't track the primary accent color 1:1 (a light
   * mint bubble in light mode needs dark text, not white). */
  bubbleAgentBg: string;
  bubbleAgentText: string;
  bubbleAgentMeta: string;
  bubbleCustomerBg: string;
}

export const darkColors: Palette = {
  // Backgrounds — WhatsApp's dark theme
  bg: '#111B21',
  chatBg: '#0B141A',
  surface: '#1F2C34',
  surfaceRaised: '#2A3942',
  border: '#2A3942',
  borderStrong: '#374045',

  // Text
  text: '#E9EDEF',
  textSecondary: '#D1D7DB',
  textMuted: '#8696A0',
  textFaint: '#667781',

  // Brand — WhatsApp teal-green
  primary: '#00A884',
  primaryMuted: 'rgba(0,168,132,0.15)',
  accent: '#00A884',

  // Chart / secondary accent
  info: '#53BDEB',

  // Status
  success: '#00A884',
  successMuted: '#8696A0',
  danger: '#F15C6D',
  dangerMuted: '#F15C6D',
  dangerBg: 'rgba(241,92,109,0.12)',
  dangerBorder: 'rgba(241,92,109,0.3)',

  white: '#ffffff',

  bubbleAgentBg: '#005C4B',
  bubbleAgentText: '#E9EDEF',
  bubbleAgentMeta: 'rgba(233,237,239,0.7)',
  bubbleCustomerBg: '#202C33',
} as const;

export const lightColors: Palette = {
  bg: '#F7F8FA',
  chatBg: '#ECE5DD',
  surface: '#ffffff',
  surfaceRaised: '#F0F2F5',
  border: '#E9EDEF',
  borderStrong: '#D1D7DB',

  text: '#111B21',
  textSecondary: '#3B4A54',
  textMuted: '#667781',
  textFaint: '#8696A0',

  primary: '#008069',
  primaryMuted: 'rgba(0,128,105,0.1)',
  accent: '#008069',

  info: '#0284c7',

  success: '#008069',
  successMuted: '#25D366',
  danger: '#dc2626',
  dangerMuted: '#ef4444',
  dangerBg: 'rgba(220,38,38,0.08)',
  dangerBorder: 'rgba(220,38,38,0.25)',

  white: '#ffffff',

  bubbleAgentBg: '#D9FDD3',
  bubbleAgentText: '#111B21',
  bubbleAgentMeta: 'rgba(17,27,33,0.45)',
  bubbleCustomerBg: '#ffffff',
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
