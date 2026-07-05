import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { apiFetch } from './supabase';

// Foreground display behavior — the inbox already updates live via
// Supabase Realtime while the app is open, but still surface the
// system notification banner (it's cheap, and matches how WhatsApp
// itself behaves) rather than suppressing it.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Requests notification permission and returns the device's Expo push
 * token, or null if permission was denied or no EAS project is
 * configured yet.
 *
 * Requires `extra.eas.projectId` in app.json, which only exists after
 * running `eas init` (creates a project under the developer's own
 * Expo account — not something to do without their say-so). Until
 * that's set up, this fails closed: logs a clear message and returns
 * null rather than throwing, so the rest of the app is unaffected.
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  // Not a target platform (Android/iOS only) — several expo-notifications
  // APIs below throw outright on web rather than no-op, which would crash
  // callers like the web preview used for debugging.
  if (Platform.OS === 'web') return null;

  if (!Device.isDevice) {
    console.warn('[push] Push notifications require a physical device (simulators have no APNs/FCM).');
    return null;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') {
    console.warn('[push] Notification permission denied.');
    return null;
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) {
    console.warn(
      '[push] No EAS project ID configured (app.json extra.eas.projectId) — run `eas init` to enable push notifications.',
    );
    return null;
  }

  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    return token;
  } catch (err) {
    console.error('[push] Failed to get Expo push token:', err);
    return null;
  }
}

/** Registers this device's push token with the backend (POST /api/mobile/push-token). */
export async function syncPushTokenWithBackend(): Promise<void> {
  const token = await registerForPushNotificationsAsync();
  if (!token) return;

  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  try {
    const res = await apiFetch('/api/mobile/push-token', {
      method: 'POST',
      body: JSON.stringify({ expo_push_token: token, platform }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.error('[push] Failed to register push token with backend:', body.error);
    }
  } catch (err) {
    console.error('[push] syncPushTokenWithBackend threw:', err);
  }
}

/** Unregisters this device's push token (call on sign-out) — best-effort. */
export async function unregisterPushToken(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    if (!projectId) return;
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!token) return;
    await apiFetch('/api/mobile/push-token', {
      method: 'DELETE',
      body: JSON.stringify({ expo_push_token: token }),
    });
  } catch (err) {
    // Best-effort — sign-out should never be blocked by this.
    console.warn('[push] unregisterPushToken failed (non-fatal):', err);
  }
}
