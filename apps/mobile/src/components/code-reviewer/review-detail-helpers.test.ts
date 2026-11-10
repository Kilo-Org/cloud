import { describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';

import {
  councilDecisionLabel,
  councilVoteLabel,
  findingsEmptyCopyKey,
  flattenCouncilFindings,
  gateThresholdLabel,
  reviewCancellationLabel,
  reviewFailureLabel,
  selectRetryAction,
  severityLabelKey,
} from './review-detail-helpers';

type Finding = { path: string; severity: string };

function specialist(findings: Finding[]) {
  return { findings };
}

describe('flattenCouncilFindings', () => {
  it('returns no findings for a null council result', () => {
    expect(flattenCouncilFindings<Finding>(null)).toEqual([]);
  });

  it('returns no findings for an undefined council result', () => {
    expect(flattenCouncilFindings<Finding>(undefined)).toEqual([]);
  });

  it('returns no findings when every specialist has zero findings', () => {
    expect(
      flattenCouncilFindings<Finding>({ specialists: [specialist([]), specialist([])] })
    ).toEqual([]);
  });

  it('flattens findings across specialists in order', () => {
    const result = flattenCouncilFindings<Finding>({
      specialists: [
        specialist([
          { path: 'a.ts', severity: 'critical' },
          { path: 'b.ts', severity: 'warning' },
        ]),
        specialist([{ path: 'c.ts', severity: 'nitpick' }]),
      ],
    });
    expect(result.map(f => f.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
});

describe('councilDecisionLabel', () => {
  it('labels pass and block', () => {
    expect(councilDecisionLabel('pass')).toBe('Pass');
    expect(councilDecisionLabel('block')).toBe('Block');
  });

  it('labels a null decision (advisory) as no decision', () => {
    expect(councilDecisionLabel(null)).toBe('No decision');
    expect(councilDecisionLabel(undefined)).toBe('No decision');
  });
});

describe('councilVoteLabel', () => {
  it('labels pass and block', () => {
    expect(councilVoteLabel('pass')).toBe('Pass');
    expect(councilVoteLabel('block')).toBe('Block');
  });

  it('labels a null vote as no result', () => {
    expect(councilVoteLabel(null)).toBe('No result');
    expect(councilVoteLabel(undefined)).toBe('No result');
  });
});

describe('reviewFailureLabel', () => {
  it.each([
    ['github_installation_required', 'githubInstallationRequired'],
    ['github_ip_allow_list', 'githubIpAllowList'],
    ['gitlab_project_access_required', 'gitlabProjectAccessRequired'],
    ['byok_invalid_key', 'byokInvalidKey'],
    ['selected_model_unavailable', 'selectedModelUnavailable'],
    ['repeated_repository_clone_timeout', 'repeatedRepositoryCloneTimeout'],
  ] as const)('uses localized action-required copy for %s', (reason, copyKey) => {
    expect(reviewFailureLabel(i18n.t, 'Internal diagnostic', reason)).toBe(
      i18n.t(`codeReviewer.actionRequired.${copyKey}.description`)
    );
  });

  it.each([null, 'upstream_error', 'future-reason'])(
    'does not expose unknown diagnostics for %s',
    reason => {
      expect(reviewFailureLabel(i18n.t, 'Internal diagnostic', reason)).toBe(
        i18n.t('codeReviewer.reviewDetail.reviewFailed')
      );
    }
  );

  it('localizes the known service-unreachable dispatch message', () => {
    expect(
      reviewFailureLabel(
        i18n.t,
        'Dispatch failed: could not reach the code review service. ' +
          'It may be offline — retry the review once it is running.',
        'upstream_error'
      )
    ).toBe(i18n.t('codeReviewer.reviewDetail.serviceUnavailable'));
  });
});

describe('gateThresholdLabel', () => {
  it.each(['off', 'all', 'critical', 'warning'] as const)('localizes %s', threshold => {
    expect(gateThresholdLabel(threshold)).toBe(i18n.t(`codeReviewer.gate.${threshold}`));
  });

  it.each(['future-threshold', 'constructor', ''])('labels unknown %s', threshold => {
    expect(gateThresholdLabel(threshold)).toBe(i18n.t('common.unknown'));
  });
});

describe('severityLabelKey', () => {
  it.each([
    ['critical', 'common.critical'],
    ['warning', 'codeReviewer.gateThreshold.warning'],
    ['suggestion', 'agentChat.suggestion.title'],
    ['nitpick', 'codeReviewer.reviewDetail.severityNitpick'],
  ] as const)('names the copy of %s', (severity, key) => {
    expect(i18n.t(severityLabelKey(severity))).toBe(i18n.t(key));
  });

  it.each(['future-tier', 'constructor', ''])('falls back for an unknown %s', severity => {
    expect(i18n.t(severityLabelKey(severity))).toBe(i18n.t('common.unknown'));
  });
});

describe('selectRetryAction', () => {
  const enabled = { isEnabled: true, actionRequired: null };

  it('keeps Retry for a manual review whatever the config says', () => {
    expect(
      selectRetryAction({
        hasManualConfig: true,
        configPending: false,
        config: { isEnabled: false, actionRequired: { reason: 'byok_invalid_key' } },
      })
    ).toBe('retry');
  });

  it('shows nothing while the config loads', () => {
    expect(
      selectRetryAction({ hasManualConfig: false, configPending: true, config: undefined })
    ).toBeNull();
  });

  it('keeps Retry when the config is unknown', () => {
    expect(
      selectRetryAction({ hasManualConfig: false, configPending: false, config: undefined })
    ).toBe('retry');
  });

  it('keeps Retry when Code Reviewer is on and needs no attention', () => {
    expect(
      selectRetryAction({ hasManualConfig: false, configPending: false, config: enabled })
    ).toBe('retry');
  });

  it('links to the settings when Code Reviewer is off', () => {
    expect(
      selectRetryAction({
        hasManualConfig: false,
        configPending: false,
        config: { isEnabled: false, actionRequired: null },
      })
    ).toBe('fix-settings');
  });

  it('links to the settings when the configuration needs attention', () => {
    expect(
      selectRetryAction({
        hasManualConfig: false,
        configPending: false,
        config: { ...enabled, actionRequired: { reason: 'byok_invalid_key' } },
      })
    ).toBe('fix-settings');
  });
});

describe('reviewCancellationLabel', () => {
  const label = (over: {
    status: string;
    errorMessage: string | null;
    terminalReason?: string | null;
    platformLabel?: string;
  }) =>
    reviewCancellationLabel(i18n.t, {
      platformLabel: 'GitHub',
      ...over,
    });

  it('leaves reviews that did not end cancelled or interrupted alone', () => {
    expect(
      label({ status: 'completed', errorMessage: 'Superseded by new push', terminalReason: null })
    ).toBeNull();
  });

  it('shows nothing when there is no stored message to explain', () => {
    expect(label({ status: 'cancelled', errorMessage: null })).toBeNull();
  });

  it('explains a review replaced by a newer commit, by reason or by message', () => {
    const expected = i18n.t('codeReviewer.reviewDetail.cancelReasonSuperseded');
    expect(label({ status: 'cancelled', errorMessage: 'Superseded by new push' })).toBe(expected);
    expect(
      label({
        status: 'cancelled',
        errorMessage: 'Superseded by duplicate merge-commit continuation',
      })
    ).toBe(expected);
    expect(
      label({ status: 'cancelled', errorMessage: 'worker stopped', terminalReason: 'superseded' })
    ).toBe(expected);
  });

  it('names the disconnected platform in the recovery step', () => {
    const message = 'Platform integration disconnected';
    expect(label({ status: 'cancelled', errorMessage: message, platformLabel: 'GitLab' })).toBe(
      i18n.t('codeReviewer.reviewDetail.cancelReasonIntegrationDisconnected', {
        platform: 'GitLab',
      })
    );
  });

  it('explains both Bitbucket cancellation causes', () => {
    expect(label({ status: 'cancelled', errorMessage: 'Bitbucket Code Reviewer disabled' })).toBe(
      i18n.t('codeReviewer.reviewDetail.cancelReasonBitbucketReviewerDisabled')
    );
    expect(
      label({
        status: 'cancelled',
        errorMessage: 'Bitbucket pull request state superseded this review',
      })
    ).toBe(i18n.t('codeReviewer.reviewDetail.cancelReasonBitbucketPullRequestChanged'));
  });

  it('falls back to the outcome for a cause the row cannot tell apart', () => {
    expect(label({ status: 'cancelled', errorMessage: 'Cancelled by user' })).toBe(
      i18n.t('codeReviewer.reviewDetail.cancelReasonCancelled')
    );
    expect(label({ status: 'interrupted', errorMessage: 'container restarted' })).toBe(
      i18n.t('codeReviewer.reviewDetail.cancelReasonInterrupted')
    );
  });

  it('reads an interrupt persisted as cancelled by its reason', () => {
    expect(
      label({
        status: 'cancelled',
        errorMessage: 'container restarted',
        terminalReason: 'interrupted',
      })
    ).toBe(i18n.t('codeReviewer.reviewDetail.cancelReasonInterrupted'));
  });
});

describe('findingsEmptyCopyKey', () => {
  it.each(['queued', 'pending', 'running'])(
    'reports an unfinished review as still in progress (%s)',
    status => {
      // A review that has not ended has no result to report, so the section may
      // never read as a clean "no findings" outcome.
      expect(findingsEmptyCopyKey(status)).toBe('codeReviewer.reviewDetail.findingsInProgress');
    }
  );

  it.each(['cancelled', 'interrupted'])('reports an early ending (%s)', status => {
    expect(findingsEmptyCopyKey(status)).toBe(
      'codeReviewer.reviewDetail.findingsEndedWithoutResults'
    );
  });

  it('keeps the failure copy for a failed review', () => {
    expect(findingsEmptyCopyKey('failed')).toBe('codeReviewer.reviewDetail.findingsUnavailable');
  });

  it('reports an ended review with no findings as a result', () => {
    expect(findingsEmptyCopyKey('completed')).toBe('codeReviewer.reviewDetail.noFindings');
    // A status the catalog does not know yet still ended, so a clean result is
    // the only claim left to make.
    expect(findingsEmptyCopyKey('something-new')).toBe('codeReviewer.reviewDetail.noFindings');
  });

  it('names a catalog key the active locale actually translates', () => {
    const key = findingsEmptyCopyKey('running');
    expect(i18n.t(key)).not.toBe(key);
    expect(i18n.t('codeReviewer.reviewDetail.findingsEndedWithoutResults')).not.toBe(
      'codeReviewer.reviewDetail.findingsEndedWithoutResults'
    );
  });
});
