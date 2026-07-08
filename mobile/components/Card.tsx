import { View, type ViewProps } from 'react-native';
import { useAppTheme } from '../hooks/use-theme';
import { radius, spacing } from '../lib/theme';

/** Shared elevated surface used for dashboard cards, list containers, form sections. */
export function Card({ style, ...rest }: ViewProps) {
  const { colors } = useAppTheme();
  return (
    <View
      style={[
        { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.border },
        style,
      ]}
      {...rest}
    />
  );
}
