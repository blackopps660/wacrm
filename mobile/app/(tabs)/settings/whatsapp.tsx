import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { apiFetch } from '../../../lib/supabase';

// Read-only status view — same GET /api/whatsapp/config the web
// Settings page uses (now Bearer-auth capable), showing whichever of
// its response shapes it returns. Full credential entry/editing stays
// web-only (typing a Meta access token on a phone is painful and
// rare) — this screen is diagnostic, matching the plan's Phase 5 scope.

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
  const [data, setData] = useState<ConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
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

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#a78bfa" />
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
        <Text style={styles.statusTitle}>
          {data?.connected ? '✓ Connected' : '✕ Not Connected'}
        </Text>
        {data?.connected && data.phone_info && (
          <>
            <Text style={styles.statusDetail}>
              {data.phone_info.verified_name ?? 'Verified number'}
            </Text>
            <Text style={styles.statusDetailMuted}>
              {data.phone_info.display_phone_number}
            </Text>
            {data.phone_info.quality_rating && (
              <Text style={styles.statusDetailMuted}>
                Quality: {data.phone_info.quality_rating}
              </Text>
            )}
          </>
        )}
        {!data?.connected && data?.message && (
          <Text style={styles.statusDetailMuted}>{data.message}</Text>
        )}
      </View>

      <Text style={styles.note}>
        To connect or update WhatsApp credentials, use Settings → WhatsApp on the web app.
      </Text>

      <Pressable style={styles.refreshButton} onPress={() => { setLoading(true); load().finally(() => setLoading(false)); }}>
        <Text style={styles.refreshButtonText}>Refresh</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#020617', padding: 16 },
  center: { flex: 1, backgroundColor: '#020617', alignItems: 'center', justifyContent: 'center' },
  errorBox: { backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: 8, padding: 10, marginBottom: 12 },
  errorText: { color: '#fca5a5', fontSize: 12 },
  statusCard: {
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
  },
  statusCardConnected: { backgroundColor: 'rgba(74,222,128,0.08)', borderColor: 'rgba(74,222,128,0.3)' },
  statusCardDisconnected: { backgroundColor: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.3)' },
  statusTitle: { color: '#f8fafc', fontSize: 16, fontWeight: '700' },
  statusDetail: { color: '#e2e8f0', fontSize: 14, marginTop: 8 },
  statusDetailMuted: { color: '#94a3b8', fontSize: 12, marginTop: 4 },
  note: { color: '#64748b', fontSize: 12, marginTop: 16, lineHeight: 18 },
  refreshButton: {
    marginTop: 20,
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  refreshButtonText: { color: '#e2e8f0', fontWeight: '600' },
});
