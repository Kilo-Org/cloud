export type TtfbAlertingDraft = {
  enabled: boolean;
  ttfbThresholdMs: string;
  ttfbSlo: string;
  minRequestsPerWindow: string;
};

export type TtfbBaseline = {
  model: string;
  p50Ttfb3d: number;
  p95Ttfb3d: number;
  p99Ttfb3d: number;
  requests3d: number;
};
