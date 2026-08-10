import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@jest/globals';

import {
  recoveryConfirmationMatches,
  redispatchToastCopy,
  resolveRecoveryActionGate,
  retryToastCopy,
} from './data-export-recovery';
import {
  ExportIdConfirmationField,
  PurgeConsequences,
  RecoveryActionItem,
  RecoveryErrorAlert,
  RedispatchConsequences,
  RetryConsequences,
} from './DataExportRecoveryParts';

const EXPORT_ID = '2c4f8a10-1111-4222-8333-444455556666';

describe('resolveRecoveryActionGate', () => {
  const eligible = { eligible: true, disabledReason: null };
  const ineligible = { eligible: false, disabledReason: 'A worker lease is active.' };

  it('enables server-eligible actions for admins', () => {
    const gate = resolveRecoveryActionGate(eligible);
    expect(gate).toEqual({ disabled: false, reason: null });
  });

  it('surfaces the server disabled reason for ineligible actions', () => {
    const gate = resolveRecoveryActionGate(ineligible);
    expect(gate.disabled).toBe(true);
    expect(gate.reason).toBe('A worker lease is active.');
  });

  it('falls back to a generic reason when the server gives none', () => {
    const gate = resolveRecoveryActionGate({ eligible: false, disabledReason: null });
    expect(gate.disabled).toBe(true);
    expect(gate.reason).toBeTruthy();
  });
});

describe('recoveryConfirmationMatches', () => {
  it('requires exact equality with the full export ID', () => {
    expect(recoveryConfirmationMatches(EXPORT_ID, EXPORT_ID)).toBe(true);
    expect(recoveryConfirmationMatches(`${EXPORT_ID} `, EXPORT_ID)).toBe(false);
    expect(recoveryConfirmationMatches(EXPORT_ID.toUpperCase(), EXPORT_ID)).toBe(false);
    expect(recoveryConfirmationMatches(EXPORT_ID.slice(0, 8), EXPORT_ID)).toBe(false);
    expect(recoveryConfirmationMatches('', EXPORT_ID)).toBe(false);
  });
});

describe('redispatchToastCopy', () => {
  it('reports a sent dispatch as success with the generation', () => {
    const copy = redispatchToastCopy({ generation: 7, dispatch: 'sent' });
    expect(copy.kind).toBe('success');
    expect(copy.description).toContain('Generation 7');
    expect(copy.description).toContain('worker');
  });

  it('reports a pending dispatch as a warning that the outbox will deliver', () => {
    const copy = redispatchToastCopy({ generation: 3, dispatch: 'pending' });
    expect(copy.kind).toBe('warning');
    expect(copy.description).toContain('outbox');
  });
});

describe('retryToastCopy', () => {
  it('reports a sent replacement as success', () => {
    const copy = retryToastCopy({
      replacementExportId: EXPORT_ID,
      generation: 1,
      dispatch: 'sent',
    });
    expect(copy.kind).toBe('success');
  });

  it('reports a pending replacement as a warning', () => {
    const copy = retryToastCopy({
      replacementExportId: EXPORT_ID,
      generation: 1,
      dispatch: 'pending',
    });
    expect(copy.kind).toBe('warning');
    expect(copy.description).toContain('outbox');
  });
});

describe('RecoveryActionItem', () => {
  const baseProps = {
    title: 'Redispatch',
    description: 'Requeue the export.',
    actionLabel: 'Redispatch export',
    pendingLabel: 'Redispatching…',
    icon: React.createElement('svg'),
    variant: 'outline' as const,
    isPending: false,
    anyPending: false,
    onSelect: () => {},
  };

  it('renders an enabled action without a reason', () => {
    const html = renderToStaticMarkup(
      React.createElement(RecoveryActionItem, {
        ...baseProps,
        gate: { disabled: false, reason: null },
      })
    );

    expect(html).toContain('Redispatch export');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('role="status"');
  });

  it('renders a disabled action with its visible reason', () => {
    const html = renderToStaticMarkup(
      React.createElement(RecoveryActionItem, {
        ...baseProps,
        gate: {
          disabled: true,
          reason: 'A worker lease is active.',
        },
      })
    );

    expect(html).toContain('disabled=""');
    expect(html).toContain('A worker lease is active.');
    expect(html).toContain('role="status"');
  });

  it('shows the pending label with an ellipsis while running', () => {
    const html = renderToStaticMarkup(
      React.createElement(RecoveryActionItem, {
        ...baseProps,
        isPending: true,
        anyPending: true,
        gate: { disabled: false, reason: null },
      })
    );

    expect(html).toContain('Redispatching…');
    expect(html).toContain('animate-spin');
    expect(html).toContain('disabled=""');
  });

  it('disables competing actions while another mutation is pending', () => {
    const html = renderToStaticMarkup(
      React.createElement(RecoveryActionItem, {
        ...baseProps,
        anyPending: true,
        gate: { disabled: false, reason: null },
      })
    );

    expect(html).toContain('disabled=""');
  });
});

describe('ExportIdConfirmationField', () => {
  it('renders the visible export ID code and a monospace exact-match input', () => {
    const html = renderToStaticMarkup(
      React.createElement(ExportIdConfirmationField, {
        id: 'confirm-export-id',
        exportId: EXPORT_ID,
        value: '',
        disabled: false,
        onChange: () => {},
      })
    );

    expect(html).toContain(
      `<code class="bg-muted/50 w-fit max-w-full rounded-md px-2 py-1 font-mono text-xs break-all">${EXPORT_ID}</code>`
    );
    expect(html).toContain(`placeholder="${EXPORT_ID}"`);
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('spellCheck="false"');
    expect(html).toContain('font-mono');
    expect(html).toContain('aria-describedby="confirm-export-id-hint"');
    expect(html).toContain('must match exactly');
  });
});

describe('recovery dialog copy', () => {
  it('explains that redispatch restarts the one-shot export', () => {
    const html = renderToStaticMarkup(React.createElement(RedispatchConsequences));

    expect(html).toContain('fenced dispatch generation');
    expect(html).toContain('Legacy cursor and part state is discarded');
    expect(html).toContain('interrupted multipart upload is aborted');
    expect(html).toContain('original snapshot and export ID are preserved');
  });

  it('explains purge permanence, cleanup, no replacement, and the signed URL window', () => {
    const html = renderToStaticMarkup(React.createElement(PurgeConsequences));

    expect(html).toContain('Permanently removes this export without a replacement');
    expect(html).toContain('execution state and outbox history');
    expect(html).toContain('Queues deletion of the stored artifact and any open multipart upload');
    expect(html).toContain('the user may request another export immediately');
    expect(html).toContain('signed download URL may keep working for up to 5 minutes');
  });

  it('explains retry replaces the export from the same snapshot and bypasses the limit', () => {
    const html = renderToStaticMarkup(React.createElement(RetryConsequences));

    expect(html).toContain('Removes this export and its history');
    expect(html).toContain('new export ID from the same snapshot');
    expect(html).toContain('24-hour request limit is bypassed');
  });
});

describe('RecoveryErrorAlert', () => {
  it('renders a destructive inline alert with the mutation error', () => {
    const html = renderToStaticMarkup(
      React.createElement(RecoveryErrorAlert, {
        title: 'Purge failed',
        message: 'This export changed after the page loaded. Refresh before trying again',
      })
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('Purge failed');
    expect(html).toContain('This export changed after the page loaded');
  });
});
