import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import type {
  EnkryptGuardrailReport,
  EnkryptInputScanReport,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';
import type { EnkryptReportSection as EnkryptReportSectionComponent } from './EnkryptReportSection';

let EnkryptReportSection: typeof EnkryptReportSectionComponent;
const originalReact = Object.getOwnPropertyDescriptor(globalThis, 'React');

beforeAll(async () => {
  Object.defineProperty(globalThis, 'React', { configurable: true, writable: true, value: React });
  ({ EnkryptReportSection } = await import('./EnkryptReportSection'));
});

afterAll(() => {
  if (originalReact) Object.defineProperty(globalThis, 'React', originalReact);
  else Reflect.deleteProperty(globalThis, 'React');
});

const timedOutScan: EnkryptInputScanReport = {
  scan: 'log_only',
  part: 'conversation',
  detectors_enabled: ['injection_attack', 'policy_violation'],
  detectors_blocking: [],
  verdict_cache: 'hit',
  verdict_cache_write: 'written',
  total_characters: 576_476,
  total_segments: 1_097,
  cached_characters: 569_536,
  cached_segments: 1_080,
  total_units: 1_097,
  cached_units: 1_080,
  failed_calls_cached: 9,
  calls_cached: 8,
  call_outcomes: { allowed: 8, flagged: 0, blocked: 0, failed: 1, not_sent: 8 },
  calls_skipped: 0,
  omitted_attachments: 2,
  scanned_characters: 3_444,
  decision: 'error_logged',
  error: 'timeout',
  detectors_fired: [],
  attempts: 9,
  credits_cost: 8,
  latency_ms: 56_730,
  chunks: 17,
};

function report(
  scan: EnkryptInputScanReport,
  actions: ('block' | 'log')[] = ['log']
): EnkryptGuardrailReport {
  return {
    settings: {
      status: 'ready',
      detectors: actions.map((action, index) => ({
        detector: index === 0 ? 'injection_attack' : 'keyword_detector',
        action,
      })),
    },
    verdict: 'skip',
    unavailable_reason: null,
    added_latency_ms: 56_730,
    scans: [scan],
  };
}

function scanCardText(guardrailReport: EnkryptGuardrailReport): string {
  const markup = renderToStaticMarkup(
    createElement(EnkryptReportSection, { report: guardrailReport })
  );
  const { document } = parseHTML(`<!doctype html><html><body>${markup}</body></html>`);
  const card = document.querySelector('[aria-label="Enkrypt input guardrail scans"] li');
  return (card?.textContent ?? '').replace(/\s+/g, ' ');
}

describe('EnkryptReportSection scan card', () => {
  it('breaks down a scan the deadline cut short', () => {
    const text = scanCardText(report(timedOutScan));

    expect(text).toContain('Partly failed, logged only');
    expect(text).toContain('17 needed · 8 allowed · 1 failed · 8 not sent');
    expect(text).toContain('Partial hit, stored 8 verdicts, 9 failed (5 min)');
    expect(text).toContain(
      "Timed out: 1 call failed and 8 calls were not sent. All of the request's calls share one 60 s deadline."
    );
    expect(text).not.toContain('Segments fully cached');
    expect(text).not.toContain('Attempts');
  });

  it('says that a log-only scan shares the deadline with the blocking scan that runs first', () => {
    expect(scanCardText(report(timedOutScan, ['log', 'block']))).toContain(
      'share one 60 s deadline, and the blocking scan runs first.'
    );
  });

  it('keeps the error badge when no call finished', () => {
    const text = scanCardText(
      report({
        ...timedOutScan,
        calls_cached: 0,
        failed_calls_cached: 17,
        call_outcomes: { allowed: 0, flagged: 0, blocked: 0, failed: 1, not_sent: 16 },
      })
    );

    expect(text).toContain('Error, logged only');
    expect(text).toContain('17 needed · 1 failed · 16 not sent');
    expect(text).toContain('Partial hit, stored 17 failed (5 min)');
  });

  it('shows segments fully cached when a segment was split into slices', () => {
    expect(scanCardText(report({ ...timedOutScan, total_units: 1_098 }))).toContain(
      'Segments fully cached'
    );
  });

  it('derives the calls not sent from an older report without call outcomes', () => {
    const { calls_cached: _cached, call_outcomes: _outcomes, ...older } = timedOutScan;
    const text = scanCardText(report(older));

    expect(text).toContain('Error, logged only');
    expect(text).toContain('Calls needed17');
    expect(text).toContain('Calls made9');
    expect(text).toContain('Calls not sent8');
    expect(text).toContain('Partial hit, stored (failed, 5 min)');
    expect(text).toContain("Timed out. All of the request's calls share one 60 s deadline.");
  });
});
