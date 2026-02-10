'use client';

import { useEffect, useState } from 'react';
import type { AlertingDraft } from '@/app/admin/alerting/types';
import { DEFAULT_ERROR_RATE_PERCENT, DEFAULT_MIN_REQUESTS } from '@/app/admin/alerting/utils';

type AlertingConfigItem = {
  model: string;
  enabled: boolean;
  errorRateSlo: number;
  minRequestsPerWindow: number;
};

type UseAlertingModelDraftsParams = {
  configs: AlertingConfigItem[] | null | undefined;
};

export function useAlertingModelDrafts({ configs }: UseAlertingModelDraftsParams) {
  const [drafts, setDrafts] = useState<Record<string, AlertingDraft>>({});

  useEffect(() => {
    if (!configs) return;

    setDrafts(prev => {
      const next = { ...prev };
      for (const config of configs) {
        if (next[config.model]) continue;
        next[config.model] = {
          enabled: config.enabled,
          errorRatePercent: ((1 - config.errorRateSlo) * 100).toFixed(2),
          minRequestsPerWindow: String(config.minRequestsPerWindow),
        };
      }
      return next;
    });
  }, [configs]);

  const updateDraft = (modelId: string, partial: Partial<AlertingDraft>) => {
    setDrafts(prev => {
      const existing = prev[modelId];
      if (!existing) return prev;
      return {
        ...prev,
        [modelId]: {
          ...existing,
          ...partial,
        },
      };
    });
  };

  const addDraft = (modelId: string) => {
    setDrafts(prev => ({
      ...prev,
      [modelId]: {
        enabled: false,
        errorRatePercent: DEFAULT_ERROR_RATE_PERCENT,
        minRequestsPerWindow: DEFAULT_MIN_REQUESTS,
      },
    }));
  };

  const removeDraft = (modelId: string) => {
    setDrafts(prev => {
      if (!prev[modelId]) return prev;
      const next = { ...prev };
      delete next[modelId];
      return next;
    });
  };

  return {
    drafts,
    updateDraft,
    addDraft,
    removeDraft,
  };
}
