import { describe, it, expect } from '@jest/globals';
import type {
  MicrodollarUsageContext,
  MicrodollarUsageStats,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';

const PROJECT = 'Auto-routing benchmarks / user/pool/6f1c2f3a-1111-4a2b-8c3d-4e5f60718293';
const USAGE_ID = '44444444-4444-4444-8444-444444444444';

const scheduled: (() => Promise<void>)[] = [];
const defer = (task: () => Promise<void>) => {
  scheduled.push(task);
};

import { recordTerminalNoChargeReceipt } from './terminal-no-charge-receipt';

type Writer = (stats: MicrodollarUsageStats, context: MicrodollarUsageContext) => Promise<unknown>;

/** A writer spy whose recorded arguments keep their real types. */
function spyWriter() {
  const calls: { stats: MicrodollarUsageStats; context: MicrodollarUsageContext }[] = [];
  const write: Writer = async (stats, context) => {
    calls.push({ stats, context });
    return { status: 'recorded' };
  };
  return { write, calls };
}

/**
 * A real context: every required field is present, and only the fields this receipt reads
 * matter to the assertions. Nothing is asserted through a cast.
 */
function context(overrides: Partial<MicrodollarUsageContext> = {}): MicrodollarUsageContext {
  return {
    api_kind: 'chat_completions',
    kiloUserId: 'user-1',
    fraudHeaders: EmptyFraudDetectionHeaders,
    provider: 'openrouter',
    requested_model: 'openai/gpt-4o',
    is_free: false,
    custom_llm_pricing: null,
    promptInfo: { system_prompt_prefix: '', system_prompt_length: 0, user_prompt_prefix: '' },
    max_tokens: 5,
    has_middle_out_transform: false,
    isStreaming: false,
    prior_microdollar_usage: 0,
    project_id: PROJECT,
    status_code: null,
    editor_name: null,
    machine_id: null,
    user_byok: false,
    has_tools: false,
    feature: null,
    session_id: null,
    mode: null,
    auto_model: null,
    reasoning_setting: null,
    inference_region: null,
    ttfb_ms: null,
    usageId: USAGE_ID,
    ...overrides,
  };
}

async function flush() {
  for (const task of scheduled.splice(0)) await task();
}

describe('recordTerminalNoChargeReceipt', () => {
  it('writes an exact zero-cost row under the signed usage id', async () => {
    const { write, calls } = spyWriter();
    recordTerminalNoChargeReceipt(context(), 400, write, defer);
    expect(scheduled).toHaveLength(1);
    await flush();
    expect(calls).toHaveLength(1);
    const [{ stats, context: written }] = calls;
    expect(stats).toMatchObject({
      cost_mUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      status_code: 400,
      hasError: true,
      model: 'openai/gpt-4o',
    });
    expect(written.usageId).toBe(USAGE_ID);
    expect(written.project_id).toBe(PROJECT);
  });

  it('writes nothing for a non-benchmark request', async () => {
    const { write, calls } = spyWriter();
    recordTerminalNoChargeReceipt(context({ project_id: 'handbook' }), 400, write, defer);
    await flush();
    expect(calls).toHaveLength(0);
    expect(scheduled).toHaveLength(0);
  });

  it('writes nothing when the context has no signed usage id', async () => {
    const { write, calls } = spyWriter();
    recordTerminalNoChargeReceipt(context({ usageId: undefined }), 400, write, defer);
    await flush();
    expect(calls).toHaveLength(0);
  });

  it('covers the reserved platform project', async () => {
    const { write, calls } = spyWriter();
    recordTerminalNoChargeReceipt(
      context({ project_id: 'Auto-routing benchmarks / platform' }),
      500,
      write,
      defer
    );
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].stats).toMatchObject({ cost_mUsd: 0, status_code: 500 });
  });

  it('swallows a writer failure so a refusal still answers the client', async () => {
    const attempted: string[] = [];
    const write: Writer = async (_stats, ctx) => {
      attempted.push(ctx.usageId ?? '<none>');
      throw new Error('db down');
    };
    recordTerminalNoChargeReceipt(context(), 400, write, defer);
    await expect(flush()).resolves.toBeUndefined();
    expect(attempted).toEqual([USAGE_ID]);
  });
});
