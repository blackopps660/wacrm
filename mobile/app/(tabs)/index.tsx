import { useCallback, useEffect, useState } from 'react';
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
import { formatCurrency } from '../../lib/currency';
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
}: {
  label: string;
  value: string;
  delta?: number;
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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rangeDays, setRangeDays] = useState<(typeof RANGE_OPTIONS)[number]>(7);

  const [metrics, setMetrics] = useState<MetricsBundle | null>(null);
  const [series, setSeries] = useState<ConversationsSeriesPoint[]>([]);
  const [pipeline, setPipeline] = useState<PipelineDonutData | null>(null);
  const [responseTime, setResponseTime] = useState<ResponseTimeSummary | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(
    async (days: number) => {
      setError(null);
      try {
        const [m, s, p, r, a] = await Promise.all([
          loadMetrics(supabase),
          loadConversationsSeries(supabase, days),
          loadPipelineDonut(supabase),
          loadResponseTime(supabase),
          loadActivity(supabase, 20),
        ]);
        setMetrics(m);
        setSeries(s);
        setPipeline(p);
        setResponseTime(r);
        setActivity(a);
      } catch (err) {
        console.error('[Dashboard] load error:', err);
        setError(err instanceof Error ? err.message : 'Failed to load dashboard data');
      }
    },
    [],
  );

  // `accountId` is a dependency (not just read) so switching workspace
  // (Phase 4) re-fetches everything under the new account — tab
  // screens stay mounted across navigation, so a route change alone
  // doesn't re-run this effect the way a full page reload would.
  useEffect(() => {
    setLoading(true);
    loadAll(rangeDays).finally(() => setLoading(false));
  }, [rangeDays, loadAll, accountId]);

  async function onRefresh() {
    setRefreshing(true);
    await loadAll(rangeDays);
    setRefreshing(false);
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#a78bfa" />
      </View>
    );
  }

  const lineData = series.map((p) => ({ value: p.incoming, label: p.day.slice(5) }));
  const lineData2 = series.map((p) => ({ value: p.outgoing, label: p.day.slice(5) }));

  const pieData =
    pipeline?.stages.map((s) => ({
      value: s.totalValue || s.dealCount,
      color: s.color,
      text: s.name,
    })) ?? [];

  const barData =
    responseTime?.buckets.map((b) => ({
      value: b.avgMinutes ?? 0,
      label: DOW_SHORT_MON_FIRST[b.dow],
      frontColor: b.samples > 0 ? '#7c3aed' : '#334155',
    })) ?? [];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#a78bfa" />
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
        />
        <MetricCard
          label="New Contacts Today"
          value={String(metrics?.newContactsToday.current ?? 0)}
          delta={
            metrics
              ? metrics.newContactsToday.current - metrics.newContactsToday.previous
              : undefined
          }
        />
        <MetricCard
          label="Open Deals Value"
          value={formatCurrency(metrics?.openDealsValue ?? 0, defaultCurrency)}
        />
        <MetricCard
          label="Messages Sent Today"
          value={String(metrics?.messagesSentToday.current ?? 0)}
          delta={
            metrics
              ? metrics.messagesSentToday.current - metrics.messagesSentToday.previous
              : undefined
          }
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
            color1="#7c3aed"
            color2="#38bdf8"
            thickness={2}
            width={CHART_WIDTH}
            height={160}
            hideDataPoints
            hideRules
            xAxisColor="#1e293b"
            yAxisColor="#1e293b"
            yAxisTextStyle={{ color: '#64748b', fontSize: 10 }}
            xAxisLabelTextStyle={{ color: '#64748b', fontSize: 9 }}
            noOfSections={3}
            spacing={rangeDays === 7 ? 40 : rangeDays === 30 ? 10 : 4}
            initialSpacing={10}
          />
        ) : (
          <Text style={styles.emptyText}>No data yet</Text>
        )}
        <View style={styles.legendRow}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#7c3aed' }]} />
            <Text style={styles.legendText}>Incoming</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#38bdf8' }]} />
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
              innerCircleColor="#0f172a"
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
            xAxisColor="#1e293b"
            yAxisColor="#1e293b"
            yAxisTextStyle={{ color: '#64748b', fontSize: 10 }}
            xAxisLabelTextStyle={{ color: '#64748b', fontSize: 10 }}
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#020617' },
  content: { padding: 16, paddingBottom: 40, gap: 16 },
  center: { flex: 1, backgroundColor: '#020617', alignItems: 'center', justifyContent: 'center' },
  errorBox: {
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderRadius: 8,
    padding: 10,
  },
  errorText: { color: '#fca5a5', fontSize: 12 },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'space-between',
  },
  metricCard: {
    width: '47%',
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  metricLabel: { color: '#94a3b8', fontSize: 11 },
  metricValue: { color: '#f8fafc', fontSize: 20, fontWeight: '700', marginTop: 6 },
  metricDelta: { fontSize: 11, marginTop: 4 },
  deltaUp: { color: '#4ade80' },
  deltaDown: { color: '#f87171' },
  deltaFlat: { color: '#64748b' },
  card: {
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  cardTitle: { color: '#f8fafc', fontSize: 14, fontWeight: '600', marginBottom: 8 },
  rangeRow: { flexDirection: 'row', gap: 6 },
  rangeChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: '#1e293b',
  },
  rangeChipActive: { backgroundColor: '#7c3aed' },
  rangeChipText: { color: '#94a3b8', fontSize: 11 },
  rangeChipTextActive: { color: '#fff', fontWeight: '600' },
  legendRow: { flexDirection: 'row', gap: 16, marginTop: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: '#94a3b8', fontSize: 11, flexShrink: 1 },
  pieRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  pieCenterText: { color: '#f8fafc', fontSize: 11, fontWeight: '600' },
  pieLegend: { flex: 1, gap: 8 },
  emptyText: { color: '#64748b', fontSize: 13, textAlign: 'center', paddingVertical: 20 },
  activityRow: {
    borderTopWidth: 1,
    borderTopColor: '#1e293b',
    paddingVertical: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  activityText: { color: '#e2e8f0', fontSize: 13, flex: 1 },
  activityTime: { color: '#64748b', fontSize: 11 },
});
