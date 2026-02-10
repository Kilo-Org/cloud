export type AlertingDraft = {
  enabled: boolean;
  errorRatePercent: string;
  minRequestsPerWindow: string;
};

export type AlertingBaseline = {
  model: string;
  errorRate1d: number;
  errorRate3d: number;
  errorRate7d: number;
  requests1d: number;
  requests3d: number;
  requests7d: number;
};

export type BaselineState = {
  status: 'idle' | 'loading' | 'error';
  message?: string;
};

export type ModelOption = {
  openrouterId: string;
  name: string;
};
