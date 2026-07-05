// Ported verbatim from src/lib/dashboard/types.ts (web app).

export interface MetricDelta {
  current: number;
  previous: number;
}

export interface MetricsBundle {
  activeConversations: MetricDelta;
  newContactsToday: MetricDelta;
  openDealsValue: number;
  openDealsCount: number;
  messagesSentToday: MetricDelta;
}

export interface ConversationsSeriesPoint {
  day: string; // YYYY-MM-DD local
  incoming: number;
  outgoing: number;
}

export interface PipelineStageSlice {
  id: string;
  name: string;
  color: string;
  dealCount: number;
  totalValue: number;
}

export interface PipelineDonutData {
  stages: PipelineStageSlice[];
  totalValue: number;
}

export interface ResponseTimeBucket {
  /** 0 = Mon … 6 = Sun (Monday-first). */
  dow: number;
  avgMinutes: number | null;
  samples: number;
}

export interface ResponseTimeSummary {
  buckets: ResponseTimeBucket[];
  thisWeekAvg: number | null;
  lastWeekAvg: number | null;
}

export type ActivityKind = 'message' | 'deal' | 'broadcast' | 'automation' | 'contact';

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  text: string;
  at: string;
  href?: string;
}
