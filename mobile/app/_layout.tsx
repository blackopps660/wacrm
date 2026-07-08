import { useEffect } from 'react';
import { Platform } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { AuthProvider, useAuth } from '../hooks/use-auth';
import { ThemeProvider, useAppTheme } from '../hooks/use-theme';

function RootNavigator() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    const inAuthGroup = segments[0] === 'login';

    if (!user && !inAuthGroup) {
      router.replace('/login');
    } else if (user && inAuthGroup) {
      router.replace('/(tabs)');
    }
  }, [user, loading, segments, router]);

  // Tapping a push notification deep-links straight to the
  // conversation it's about — `data.conversationId` is set server-side
  // in src/lib/push/dispatch.ts. Two paths: the app was already
  // running (listener fires live) or was killed and got launched by
  // the tap (checked once via getLastNotificationResponse on mount).
  //
  // Push/local notifications aren't a web platform — several of these
  // APIs throw (not just no-op) when called there, which would crash
  // the whole app on this debugging-only target. Android/iOS are the
  // real targets (per the mobile plan), so just skip entirely on web.
  useEffect(() => {
    if (Platform.OS === 'web') return;

    function openConversation(response: Notifications.NotificationResponse) {
      const conversationId = response.notification.request.content.data?.conversationId;
      if (typeof conversationId === 'string') {
        router.push(`/inbox/${conversationId}`);
      }
    }

    const lastResponse = Notifications.getLastNotificationResponse();
    if (lastResponse) openConversation(lastResponse);

    const subscription = Notifications.addNotificationResponseReceivedListener(openConversation);
    return () => subscription.remove();
  }, [router]);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}

function ThemedStatusBar() {
  const { resolvedScheme } = useAppTheme();
  return <StatusBar style={resolvedScheme === 'light' ? 'dark' : 'light'} />;
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ThemedStatusBar />
        <RootNavigator />
      </AuthProvider>
    </ThemeProvider>
  );
}
