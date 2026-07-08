import { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useAppTheme } from '../hooks/use-theme';
import { spacing } from '../lib/theme';
import { resolveAuthedSource, type AuthedSource } from '../lib/media';

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Voice-note style player for `content_type: 'audio'` messages, matching the web app's <audio> playback but as a WhatsApp-style bubble control. */
export function AudioMessage({ url, tint }: { url: string; tint: 'agent' | 'customer' }) {
  // Inbound audio is served from an auth-gated proxy route
  // (`/api/whatsapp/media/[mediaId]`) — the web app gets that for free
  // via cookies, but this native player does a raw HTTP GET with no
  // cookie jar, so without an explicit Bearer header it 401s silently
  // and just never loads (the bubble renders but never plays).
  const [source, setSource] = useState<AuthedSource | null>(null);
  useEffect(() => {
    let cancelled = false;
    resolveAuthedSource(url).then((resolved) => {
      if (!cancelled) setSource(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const player = useAudioPlayer(source);
  const status = useAudioPlayerStatus(player);
  const { colors } = useAppTheme();

  // Release the player when this bubble unmounts (e.g. scrolled far
  // enough out of the virtualized list) so playback doesn't keep
  // running in the background.
  useEffect(() => {
    return () => {
      player.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle() {
    if (status.playing) {
      player.pause();
    } else {
      if (status.didJustFinish || status.currentTime >= status.duration) {
        player.seekTo(0);
      }
      player.play();
    }
  }

  const progress = status.duration > 0 ? status.currentTime / status.duration : 0;
  const iconColor = tint === 'agent' ? colors.white : colors.text;
  const trackColor = tint === 'agent' ? 'rgba(255,255,255,0.3)' : colors.borderStrong;
  const fillColor = tint === 'agent' ? colors.white : colors.accent;

  return (
    <View style={styles.row}>
      <Pressable onPress={toggle} style={styles.playButton} hitSlop={8}>
        <Ionicons name={status.playing ? 'pause' : 'play'} size={18} color={iconColor} />
      </Pressable>
      <View style={styles.trackWrap}>
        <View style={[styles.track, { backgroundColor: trackColor }]}>
          <View style={[styles.trackFill, { backgroundColor: fillColor, width: `${progress * 100}%` }]} />
        </View>
        <Text style={[styles.time, { color: iconColor }]}>
          {status.isLoaded ? formatTime(status.playing || status.currentTime > 0 ? status.currentTime : status.duration) : '…'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 180 },
  playButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  trackWrap: { flex: 1, gap: 2 },
  track: { height: 3, borderRadius: 2, overflow: 'hidden' },
  trackFill: { height: '100%', borderRadius: 2 },
  time: { fontSize: 10, opacity: 0.8 },
});
