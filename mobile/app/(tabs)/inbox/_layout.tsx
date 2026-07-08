import { Stack } from 'expo-router';
import { colors } from '../../../lib/theme';

export default function InboxLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '700' },
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Inbox' }} />
      {/* [id] renders its own header (contact name + lifecycle stage
          pill + search/3-dot actions) — the default Stack header would
          just duplicate the title bar above it. */}
      <Stack.Screen name="[id]" options={{ headerShown: false }} />
    </Stack>
  );
}
