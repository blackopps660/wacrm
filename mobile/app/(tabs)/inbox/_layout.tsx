import { Pressable } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAppTheme } from '../../../hooks/use-theme';

export default function InboxLayout() {
  const { colors } = useAppTheme();
  const router = useRouter();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '700' },
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: 'Inbox',
          headerRight: () => (
            <Pressable
              onPress={() => router.push('/inbox/new')}
              hitSlop={8}
              style={{ paddingHorizontal: 4 }}
            >
              <Ionicons name="create-outline" size={22} color={colors.text} />
            </Pressable>
          ),
        }}
      />
      <Stack.Screen name="archived" options={{ title: 'Archived' }} />
      {/* [id] renders its own header (contact name + lifecycle stage
          pill + search/3-dot actions) — the default Stack header would
          just duplicate the title bar above it. */}
      <Stack.Screen name="[id]" options={{ headerShown: false }} />
      <Stack.Screen name="new" options={{ title: 'New Message', presentation: 'modal' }} />
    </Stack>
  );
}
