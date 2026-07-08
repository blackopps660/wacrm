import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Appearance } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { darkColors, lightColors, type Palette } from '../lib/theme';

export type ThemeMode = 'system' | 'dark' | 'light';
export type FontSize = 'small' | 'medium' | 'large' | 'xlarge';

const FONT_SCALE: Record<FontSize, number> = {
  small: 0.9,
  medium: 1,
  large: 1.12,
  xlarge: 1.25,
};

const MODE_KEY = 'blinkmoon:theme-mode';
const FONT_KEY = 'blinkmoon:font-size';

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  resolvedScheme: 'dark' | 'light';
  colors: Palette;
  fontSize: FontSize;
  setFontSize: (size: FontSize) => void;
  fontScale: number;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('dark');
  const [fontSize, setFontSizeState] = useState<FontSize>('medium');
  const [systemScheme, setSystemScheme] = useState(() => Appearance.getColorScheme() ?? 'dark');

  useEffect(() => {
    AsyncStorage.getItem(MODE_KEY).then((saved) => {
      if (saved === 'dark' || saved === 'light' || saved === 'system') setModeState(saved);
    });
    AsyncStorage.getItem(FONT_KEY).then((saved) => {
      if (saved === 'small' || saved === 'medium' || saved === 'large' || saved === 'xlarge') {
        setFontSizeState(saved);
      }
    });
    const sub = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemScheme(colorScheme ?? 'dark');
    });
    return () => sub.remove();
  }, []);

  function setMode(next: ThemeMode) {
    setModeState(next);
    void AsyncStorage.setItem(MODE_KEY, next);
  }

  function setFontSize(next: FontSize) {
    setFontSizeState(next);
    void AsyncStorage.setItem(FONT_KEY, next);
  }

  const resolvedScheme = mode === 'system' ? systemScheme : mode;
  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      setMode,
      resolvedScheme,
      colors: resolvedScheme === 'light' ? lightColors : darkColors,
      fontSize,
      setFontSize,
      fontScale: FONT_SCALE[fontSize],
    }),
    [mode, resolvedScheme, fontSize],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useAppTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Same fail-open pattern as useAuth() — a screen rendered outside
    // the provider (shouldn't happen, but Fast Refresh edge cases do)
    // gets a sane dark-mode default instead of a crash.
    return {
      mode: 'dark',
      setMode: () => {},
      resolvedScheme: 'dark',
      colors: darkColors,
      fontSize: 'medium',
      setFontSize: () => {},
      fontScale: 1,
    };
  }
  return ctx;
}
