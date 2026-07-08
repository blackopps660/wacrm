import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { Ionicons } from '@expo/vector-icons';
import { supabase, apiFetch, API_BASE_URL } from '../../../lib/supabase';
import { useAppTheme } from '../../../hooks/use-theme';
import { radius, scaleFontSizes, spacing, type Palette } from '../../../lib/theme';

// Status view + "Connect with Meta" launcher — the manual credential
// form stays web-only (typing a Meta access token on a phone is
// painful and rare), but Embedded Signup is just as good from a
// device since it's a Meta-hosted flow: this opens the same page
// src/app/whatsapp-embedded-signup/page.tsx renders for web, inside
// an in-app browser tab, carrying this device's session token since
// there's no shared cookie jar with a mobile WebBrowser session.

interface ConfigResponse {
  connected: boolean;
  reason?: string;
  message?: string;
  needs_reset?: boolean;
  phone_info?: {
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
  };
}

export default function WhatsAppStatusScreen() {
  const { colors, fontScale } = useAppTheme();
  const styles = useMemo(() => scaleFontSizes(makeStyles(colors), fontScale), [colors, fontScale]);
  const [data, setData] = useState<ConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch('/api/whatsapp/config', { method: 'GET' });
      const body = (await res.json()) as ConfigResponse;
      setData(body);
    } catch (err) {
      console.error('[WhatsApp status] load error:', err);
      setError(err instanceof Error ? err.message : 'Failed to load status');
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  async function handleConnectWithMeta() {
    setConnecting(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) return;

      const url = `${API_BASE_URL}/whatsapp-embedded-signup?mobile=1&token=${encodeURIComponent(session.access_token)}`;
      const result = await WebBrowser.openAuthSessionAsync(url, 'blinkmoon://whatsapp-connected');
      if (result.type === 'success') {
        setLoading(true);
        await load();
        setLoading(false);
      }
    } finally {
      setConnecting(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <View
        style={[
          styles.statusCard,
          data?.connected ? styles.statusCardConnected : styles.statusCardDisconnected,
        ]}
      >
        <View style={styles.statusHeader}>
          <Ionicons
            name={data?.connected ? 'checkmark-circle' : 'close-circle'}
            size={20}
            color={data?.connected ? colors.success : colors.danger}
          />
          <Text style={styles.statusTitle}>{data?.connected ? 'Connected' : 'Not Connected'}</Text>
        </View>
        {data?.connected && data.phone_info && (
          <>
            <Text style={styles.statusDetail}>{data.phone_info.verified_name ?? 'Verified number'}</Text>
            <Text style={styles.statusDetailMuted}>{data.phone_info.display_phone_number}</Text>
            {data.phone_info.quality_rating && (
              <Text style={styles.statusDetailMuted}>Quality: {data.phone_info.quality_rating}</Text>
            )}
          </>
        )}
        {!data?.connected && data?.message && <Text style={styles.statusDetailMuted}>{data.message}</Text>}
      </View>

      {!data?.connected && (
        <Pressable
          style={({ pressed }) => [styles.connectButton, pressed && { opacity: 0.85 }]}
          onPress={handleConnectWithMeta}
          disabled={connecting}
        >
          {connecting ? (
            <ActivityIndicator color={colors.white} size="small" />
          ) : (
            <>
              <Ionicons name="logo-facebook" size={18} color={colors.white} />
              <Text style={styles.connectButtonText}>Connect with Meta</Text>
            </>
          )}
        </Pressable>
      )}

      <Text style={styles.note}>
        For advanced options (manual token entry, webhook config), use Settings → WhatsApp on the
        web app.
      </Text>

      <Pressable
        style={styles.refreshButton}
        onPress={() => {
          setLoading(true);
          load().finally(() => setLoading(false));
        }}
      >
        <Text style={styles.refreshButtonText}>Refresh</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg, padding: spacing.lg },
    center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    errorBox: { backgroundColor: colors.dangerBg, borderRadius: radius.sm, padding: spacing.sm + 2, marginBottom: spacing.md },
    errorText: { color: colors.dangerMuted, fontSize: 12 },
    statusCard: {
      borderRadius: radius.lg,
      padding: spacing.lg,
      borderWidth: 1,
    },
    statusHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    statusCardConnected: { backgroundColor: 'rgba(74,222,128,0.08)', borderColor: 'rgba(74,222,128,0.3)' },
    statusCardDisconnected: { backgroundColor: colors.dangerBg, borderColor: colors.dangerBorder },
    statusTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
    statusDetail: { color: colors.textSecondary, fontSize: 14, marginTop: spacing.sm },
    statusDetailMuted: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
    connectButton: {
      marginTop: spacing.lg,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      backgroundColor: colors.primary,
      borderRadius: radius.sm,
      paddingVertical: spacing.md + 2,
    },
    connectButtonText: { color: colors.white, fontWeight: '700', fontSize: 15 },
    note: { color: colors.textFaint, fontSize: 12, marginTop: spacing.lg, lineHeight: 18 },
    refreshButton: {
      marginTop: spacing.lg,
      borderWidth: 1,
      borderColor: colors.borderStrong,
      borderRadius: radius.sm,
      paddingVertical: spacing.md,
      alignItems: 'center',
    },
    refreshButtonText: { color: colors.textSecondary, fontWeight: '600' },
  });
}
