import { describe, expect, it } from 'vitest';
import {
  AutoAnalysisOwnerMessageSchema,
  DEFAULT_SECURITY_AGENT_CONFIG,
  resolveSecurityAgentModels,
} from './types.js';

describe('AutoAnalysisOwnerMessageSchema', () => {
  it('accepts valid owner messages', () => {
    const parsed = AutoAnalysisOwnerMessageSchema.parse({
      ownerType: 'org',
      ownerId: 'org_123',
      dispatchId: 'dispatch_123',
      enqueuedAt: '2026-02-26T00:00:00.000Z',
    });

    expect(parsed.ownerType).toBe('org');
    expect(parsed.ownerId).toBe('org_123');
  });

  it('rejects messages with missing ownerId', () => {
    const result = AutoAnalysisOwnerMessageSchema.safeParse({
      ownerType: 'user',
      ownerId: '',
      dispatchId: 'dispatch_123',
      enqueuedAt: '2026-02-26T00:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });
});

describe('DEFAULT_SECURITY_AGENT_CONFIG', () => {
  it('defaults to auto analysis mode and high threshold', () => {
    expect(DEFAULT_SECURITY_AGENT_CONFIG.analysis_mode).toBe('auto');
    expect(DEFAULT_SECURITY_AGENT_CONFIG.auto_analysis_min_severity).toBe('high');
  });
});

describe('resolveSecurityAgentModels', () => {
  it('prefers explicit triage and analysis model slugs independently', () => {
    expect(
      resolveSecurityAgentModels({
        model_slug: 'legacy/model',
        triage_model_slug: 'triage/model',
        analysis_model_slug: 'analysis/model',
      })
    ).toEqual({ triageModel: 'triage/model', analysisModel: 'analysis/model' });
  });

  it('uses legacy model_slug as fallback for both Worker launch phases', () => {
    expect(resolveSecurityAgentModels({ model_slug: 'legacy/model' })).toEqual({
      triageModel: 'legacy/model',
      analysisModel: 'legacy/model',
    });
  });
});
