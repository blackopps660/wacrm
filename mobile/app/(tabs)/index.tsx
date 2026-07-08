import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Dimensions,
} from 'react-native';
import { LineChart, PieChart, BarChart } from 'react-native-gifted-charts';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/use-auth';
import { useAppTheme } from '../../hooks/use-theme';
import { formatCurrency } from '../../lib/currency';
import { scaleFontSizes, type Palette } from '../../lib/theme';
import {
  loadMetrics,
  loadConversationsSeries,
  loadPipelineDonut,
  loadResponseTime,
  loadActivity,
} from '../../lib/dashboard/queries';
import { DOW_SHORT_MON_FIRST } from '../../lib/dashboard/date-utils';
import type {
  MetricsBundle,
  ConversationsSeriesPoint,
  PipelineDonutData,
  ResponseTimeSummary,
} from '../../lib/dashboard/types';
import type { ActivityItem } from '../../lib/dashboard/types';

const RANGE_OPTIONS = [7, 30, 90] as const;
const CHART_WIDTH = Dimensions.get('window').width - 64;

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function MetricCard({
  label,
  value,
  delta,
  styles,
}: {
  label: string;
  value: string;
  delta?: number;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.metricCard}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
      {delta !== undefined && (
        <Text
          style={[
            styles.metricDelta,
            delta > 0 ? styles.deltaUp : delta < 0 ? styles.deltaDown : styles.deltaFlat,
          ]}
        >
          {delta > 0 ? '+' : ''}
          {delta} vs yesterday
        </Text>
      )}
    </View>
  );
}

export default function DashboardScreen() {
  const { defaultCurrency, accountId } = useAuth();
  const { colors, fontScale } = useAppTheme();
  const styles = useMemo(() => scaleFontSizes(makeStyles(colors), fontScale), [colors, fontScale]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rangeDays, setRangeDays] = useState<(typeof RANGE_OPTIONS)[number]>(7);

  const [metrics, setMetrics] = useState<MetricsBundle | null>(null);
  const [series, setSeries] = useState<ConversationsSeriesPoint[]>([]);
  const [pipeline, setPipeline] = useState<PipelineDonutData | null>(null);
  const [responseTime, setResponseTime] = useState<ResponseTimeSummary | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Only the time-series chart actually depends on `days` — metrics,
  // pipeline, response time, and activity are range-independent, so
  // splitting this avoids re-running all 5 queries every time the
  // user taps a different 7d/30d/90d chip.
  const loadStatic = useCallback(async () => {
    setError(null);
    try {
      const [m, p, r, a] = await Promise.all([
        loadMetrics(supabase),
        loadPipelineDonut(supabase),
        loadResponseTime(supabase),
        loadActivity(supabase, 20),
      ]);
      setMetrics(m);
      setPipeline(p);
      setResponseTime(r);
      setActivity(a);
    } catch (err) {
      console.error('[Dashboard] load error:', err);
      setError(err instanceof Error ? err.message : 'Failed to load dashboard data');
    }
  }, []);

  const loadSeries = useCallback(async (days: number) => {
    try {
      setSeries(await loadConversationsSeries(supabase, days));
    } catch (err) {
      console.error('[Dashboard] series load error:', err);
    }
  }, []);

  // `accountId` is a dependency (not just read) so switching workspace
  // (Phase 4) re-fetches everything under the new account — tab
  // screens stay mounted across navigation, so a route change alone
  // doesn't re-run this effect the way a full page reload would.
  useEffect(() => {
    setLoading(true);
    loadStatic().finally(() => setLoading(false));
  }, [loadStatic, accountId]);

  // Separate from the effect above so a range-chip tap (rangeDays
  // change) only re-fetches the series, not metrics/pipeline/activity
  // too. Still re-runs on accountId change so a workspace switch loads
  // the new account's series alongside everything else.
  useEffect(() => {
    loadSeries(rangeDays);
  }, [loadSeries, rangeDays, accountId]);

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([loadStatic(), loadSeries(rangeDays)]);
    setRefreshing(false);
  }

  // These must run unconditionally on every render (Rules of Hooks) —
  // they used to live after the `if (loading) return` below, which
  // skipped them entirely on the very first render and threw "Rendered
  // more hooks than during the previous render" the moment loading
  // flipped false.
  const lineData = useMemo(
    () => series.map((p) => ({ value: p.incoming, label: p.day.slice(5) })),
    [series],
  );
  const lineData2 = useMemo(
    () => series.map((p) => ({ value: p.outgoing, label: p.day.slice(5) })),
    [series],
  );

  const pieData = useMemo(
    () =>
      pipeline?.stages.map((s) => ({
        value: s.totalValue || s.dealCount,
        color: s.color,
        text: s.name,
      })) ?? [],
    [pipeline],
  );

  const barData = useMemo(
    () =>
      responseTime?.buckets.map((b) => ({
        value: b.avgMinutes ?? 0,
        label: DOW_SHORT_MON_FIRST[b.dow],
        frontColor: b.samples > 0 ? colors.primary : colors.borderStrong,
      })) ?? [],
    [responseTime, colors],
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
      }
    >
      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* Metric cards */}
      <View style={styles.metricsGrid}>
        <MetricCard
          label="Active Conversations"
          value={String(metrics?.activeConversations.current ?? 0)}
          delta={metrics?.activeConversations.previous}
          styles={styles}
        />
        <MetricCard
          label="New Contacts Today"
          value={String(metrics?.newContactsToday.current ?? 0)}
          delta={
            metrics
              ? metrics.newContactsToday.current - metrics.newContactsToday.previous
              : undefined
          }
          styles={styles}
        />
        <MetricCard
          label="Open Deals Value"
          value={formatCurrency(metrics?.openDealsValue ?? 0, defaultCurrency)}
          styles={styles}
        />
        <MetricCard
          label="Messages Sent Today"
          value={String(metrics?.messagesSentToday.current ?? 0)}
          delta={
            metrics
              ? metrics.messagesSentToday.current - metrics.messagesSentToday.previous
              : undefined
          }
          styles={styles}
        />
      </View>

      {/* Conversations time series */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Conversations</Text>
          <View style={styles.rangeRow}>
            {RANGE_OPTIONS.map((d) => (
              <Pressable
                key={d}
                onPress={() => setRangeDays(d)}
                style={[styles.rangeChip, rangeDays === d && styles.rangeChipActive]}
              >
                <Text
                  style={[
                    styles.rangeChipText,
                    rangeDays === d && styles.rangeChipTextActive,
                  ]}
                >
                  {d}d
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
        {series.length > 0 ? (
          <LineChart
            data={lineData}
            data2={lineData2}
            color1={colors.primary}
            color2={colors.info}
            thickness={2}
            width={CHART_WIDTH}
            height={160}
            hideDataPoints
            hideRules
            xAxisColor={colors.border}
            yAxisColor={colors.border}
            yAxisTextStyle={{ color: colors.textFaint, fontSize: 10 }}
            xAxisLabelTextStyle={{ color: colors.textFaint, fontSize: 9 }}
            noOfSections={3}
            spacing={rangeDays === 7 ? 40 : rangeDays === 30 ? 10 : 4}
            initialSpacing={10}
          />
        ) : (
          <Text style={styles.emptyText}>No data yet</Text>
        )}
        <View style={styles.legendRow}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: colors.primary }]} />
            <Text style={styles.legendText}>Incoming</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: colors.info }]} />
            <Text style={styles.legendText}>Outgoing</Text>
          </View>
        </View>
      </View>

      {/* Pipeline donut */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Pipeline</Text>
        {pieData.length > 0 ? (
          <View style={styles.pieRow}>
            <PieChart
              data={pieData}
              donut
              radius={70}
              innerRadius={45}
              innerCircleColor={colors.surface}
              centerLabelComponent={() => (
                <Text style={styles.pieCenterText}>
                  {formatCurrency(pipeline?.totalValue ?? 0, defaultCurrency)}
                </Text>
              )}
            />
            <View style={styles.pieLegend}>
              {pipeline?.stages.map((s) => (
                <View key={s.id} style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: s.color }]} />
                  <Text style={styles.legendText} numberOfLines={1}>
                    {s.name} ({s.dealCount})
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : (
          <Text style={styles.emptyText}>No open deals</Text>
        )}
      </View>

      {/* Response time by weekday */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Avg. Response Time</Text>
        {barData.length > 0 ? (
          <BarChart
            data={barData}
            width={CHART_WIDTH}
            height={140}
            barWidth={20}
            spacing={16}
            hideRules
            xAxisColor={colors.border}
            yAxisColor={colors.border}
            yAxisTextStyle={{ color: colors.textFaint, fontSize: 10 }}
            xAxisLabelTextStyle={{ color: colors.textFaint, fontSize: 10 }}
            noOfSections={3}
          />
        ) : (
          <Text style={styles.emptyText}>No data yet</Text>
        )}
      </View>

      {/* Activity feed */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Recent Activity</Text>
        {activity.length === 0 ? (
          <Text style={styles.emptyText}>No recent activity</Text>
        ) : (
          activity.map((item) => (
            <View key={item.id} style={styles.activityRow}>
              <Text style={styles.activityText} numberOfLines={2}>
                {item.text}
              </Text>
              <Text style={styles.activityTime}>{timeAgo(item.at)}</Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 16, paddingBottom: 40, gap: 16 },
    center: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    errorBox: {
      backgroundColor: colors.dangerBg,
      borderRadius: 8,
      padding: 10,
    },
    errorText: { color: colors.dangerMuted, fontSize: 12 },
    metricsGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 12,
      justifyContent: 'space-between',
    },
    metricCard: {
      width: '47%',
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.border,
    },
    metricLabel: { color: colors.textMuted, fontSize: 11 },
    metricValue: { color: colors.text, fontSize: 20, fontWeight: '700', marginTop: 6 },
    metricDelta: { fontSize: 11, marginTop: 4 },
    deltaUp: { color: colors.success },
    deltaDown: { color: colors.danger },
    deltaFlat: { color: colors.textFaint },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.border,
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 12,
    },
    cardTitle: { color: colors.text, fontSize: 14, fontWeight: '600', marginBottom: 8 },
    rangeRow: { flexDirection: 'row', gap: 6 },
    rangeChip: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 12,
      backgroundColor: colors.surfaceRaised,
    },
    rangeChipActive: { backgroundColor: colors.primary },
    rangeChipText: { color: colors.textMuted, fontSize: 11 },
    rangeChipTextActive: { color: colors.white, fontWeight: '600' },
    legendRow: { flexDirection: 'row', gap: 16, marginTop: 10 },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    legendDot: { width: 8, height: 8, borderRadius: 4 },
    legendText: { color: colors.textMuted, fontSize: 11, flexShrink: 1 },
    pieRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
    pieCenterText: { color: colors.text, fontSize: 11, fontWeight: '600' },
    pieLegend: { flex: 1, gap: 8 },
    emptyText: { color: colors.textFaint, fontSize: 13, textAlign: 'center', paddingVertical: 20 },
    activityRow: {
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingVertical: 10,
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: 8,
    },
    activityText: { color: colors.textSecondary, fontSize: 13, flex: 1 },
    activityTime: { color: colors.textFaint, fontSize: 11 },
  });
}
