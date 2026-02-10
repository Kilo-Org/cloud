'use client';

import { useState } from 'react';
import type { TtfbBaseline } from '@/app/admin/alerting-ttfb/types';
import type { BaselineState } from '@/app/admin/alerting/types';

export function useTtfbBaselineState() {
  const [baselineByModel, setBaselineByModel] = useState<Record<string, TtfbBaseline | null>>({});
  const [baselineStatus, setBaselineStatus] = useState<Record<string, BaselineState>>({});

  const setLoading = (modelId: string) => {
    setBaselineStatus(prev => ({
      ...prev,
      [modelId]: { status: 'loading' },
    }));
  };

  const setBaseline = (modelId: string, baseline: TtfbBaseline | null) => {
    setBaselineByModel(prev => ({
      ...prev,
      [modelId]: baseline,
    }));
    setBaselineStatus(prev => ({
      ...prev,
      [modelId]: { status: 'idle' },
    }));
  };

  const setError = (modelId: string, message: string) => {
    setBaselineByModel(prev => {
      const next = { ...prev };
      delete next[modelId];
      return next;
    });
    setBaselineStatus(prev => ({
      ...prev,
      [modelId]: { status: 'error', message },
    }));
  };

  return {
    baselineByModel,
    baselineStatus,
    setLoading,
    setBaseline,
    setError,
  };
}
