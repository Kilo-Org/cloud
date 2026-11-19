// Automation-settings approval-gate contract: the "Require approval before
// auto-remediation" toggle hydrates from the loaded config, persists through
// the save patch object, and renders disabled for read-only viewers. The
// paused gate contract lives here too: the mock state and mount harness they
// share sit in the mounted-test-helpers module.

// The helpers import is first: its vi.mock registrations (react-native among
// them) must be in place before any other import evaluates, so the real
// React Native entry never loads.
import {
  approvalRow,
  capability,
  config,
  connectivity,
  enabledConfig,
  pillGroups,
  platformError,
  renderScreen,
  save,
  saveButton,
  toastSuccess,
  toggleRows,
  trackInteraction,
} from './automation-settings-screen.mounted.test-helpers';

import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { AutomationSettingsScreen } from './automation-settings-screen';

describe('AutomationSettingsScreen approval gate', () => {
  beforeEach(() => {
    config.data = null;
    config.isLoading = false;
    config.isError = false;
    config.isPending = false;
    config.fetchStatus = 'idle';
    platformError.props = null;
    connectivity.committed = 'online';
    capability.canManage = true;
    save.isPending = false;
    save.mutateAsync.mockReset();
    save.mutateAsync.mockResolvedValue({});
    trackInteraction.mutate.mockClear();
    toggleRows.rows = [];
    pillGroups.groups = [];
    saveButton.onSave = null;
    toastSuccess.mockClear();
  });

  it('hydrates the approval toggle from the loaded config', () => {
    config.data = enabledConfig({ autoRemediationRequireApproval: false });
    renderScreen(AutomationSettingsScreen);

    expect(approvalRow().value).toBe(false);
  });

  it('persists the approval toggle through the save patch object', async () => {
    config.data = enabledConfig({ autoRemediationRequireApproval: true });
    renderScreen(AutomationSettingsScreen);

    act(() => {
      approvalRow().onValueChange(false);
    });
    await act(async () => {
      await saveButton.onSave?.();
    });

    expect(save.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ autoRemediationRequireApproval: false })
    );
  });

  it.each([
    // The queued count is this screen's own outcome; without one the screen
    // still confirms the save, so the shared hook must not announce as well.
    [{ existingFindingsQueuedCount: 3 }, 'securityAgent.automation.queued'],
    [{}, 'securityAgent.settingsSave.saved'],
  ])('announces one confirmation for a save result of %j', async (result, expectedKey) => {
    config.data = enabledConfig();
    save.mutateAsync.mockResolvedValue(result);
    renderScreen(AutomationSettingsScreen);

    await act(async () => {
      await saveButton.onSave?.();
    });

    expect(save.options?.announceSaved).toBe(false);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess.mock.calls[0]?.[0]).toBe(
      i18n.t(expectedKey, { count: 3, displayCount: '3' })
    );
  });

  it('renders the approval toggle disabled for read-only viewers', () => {
    capability.canManage = false;
    config.data = enabledConfig();
    renderScreen(AutomationSettingsScreen);

    expect(approvalRow().disabled).toBe(true);
  });

  it('names the connection and offers Retry for a first read paused offline', () => {
    // The online manager paused the cold read on a confirmed-offline device:
    // pending, no data, no error. The loading gate would hold the skeleton
    // until connectivity returns.
    config.data = null;
    config.isPending = true;
    config.fetchStatus = 'paused';
    connectivity.committed = 'offline';
    renderScreen(AutomationSettingsScreen);

    const error = platformError.props;
    if (!error) {
      throw new Error('paused first read did not render the failure screen');
    }
    expect(error.variant).toBe('offline');
    expect(error.message).toBe(i18n.t('securityAgent.automation.couldNotLoad'));
    expect(error.title).toBe(i18n.t('securityAgent.automation.title'));
    act(() => {
      error.onRetry?.();
    });
    expect(config.refetch).toHaveBeenCalledOnce();
  });

  it.each(['unknown', 'online'] as const)(
    'keeps the skeleton for a pause while connectivity is %s',
    state => {
      // The online manager also pauses on an unsettled NetInfo report, which is
      // the normal cold-launch window: that is not a connection failure yet.
      config.data = null;
      config.isPending = true;
      config.fetchStatus = 'paused';
      connectivity.committed = state;
      renderScreen(AutomationSettingsScreen);

      expect(platformError.props).toBeNull();
    }
  );

  it('keeps the skeleton for a first read still in flight', () => {
    config.data = null;
    config.isLoading = true;
    config.fetchStatus = 'fetching';
    renderScreen(AutomationSettingsScreen);

    expect(platformError.props).toBeNull();
  });

  it('names each repeated control with the section it belongs to', () => {
    config.data = enabledConfig({ autoAnalysisEnabled: true, autoRemediationEnabled: true });
    renderScreen(AutomationSettingsScreen);

    const analysisSection = i18n.t('securityAgent.automation.autoAnalysis');
    const remediationSection = i18n.t('securityAgent.automation.autoRemediation');
    const includeTitle = i18n.t('securityAgent.automation.includeExistingFindings');
    const severityTitle = i18n.t('securityAgent.automation.minimumSeverity');

    const includeNames = toggleRows.rows
      .filter(row => row.title === includeTitle)
      .map(row => row.accessibilityLabel);
    expect(includeNames).toHaveLength(2);
    const includeAnalysis = includeNames.filter(name => name?.includes(analysisSection));
    const includeRemediation = includeNames.filter(name => name?.includes(remediationSection));
    expect(includeAnalysis).toHaveLength(1);
    expect(includeRemediation).toHaveLength(1);

    const severityGroups = pillGroups.groups.filter(group => group.label === severityTitle);
    expect(severityGroups).toHaveLength(2);
    const severityNames = severityGroups.map(group => group.accessibilityLabel);
    const severityAnalysis = severityNames.filter(name => name?.includes(analysisSection));
    const severityRemediation = severityNames.filter(name => name?.includes(remediationSection));
    expect(severityAnalysis).toHaveLength(1);
    expect(severityRemediation).toHaveLength(1);

    // Label in name: each accessible name starts with the control's visible
    // title, so a composed name that dropped it cannot pass.
    for (const name of includeNames) {
      expect(name?.startsWith(includeTitle)).toBe(true);
    }
    for (const name of severityNames) {
      expect(name?.startsWith(severityTitle)).toBe(true);
    }

    const names = [...includeNames, ...severityNames];
    expect(new Set(names).size).toBe(4);
  });

  it('titles each section switch briefly with its description as muted copy', () => {
    config.data = enabledConfig();
    renderScreen(AutomationSettingsScreen);

    const sectionNames = [
      'securityAgent.automation.autoAnalysis',
      'securityAgent.automation.autoRemediation',
      'securityAgent.automation.autoDismiss',
    ].map(key => i18n.t(key));
    const sections = [
      {
        title: i18n.t('securityAgent.automation.analyzeNewFindings'),
        description: i18n.t('securityAgent.automation.autoAnalysisDescription'),
      },
      {
        title: i18n.t('securityAgent.automation.openFixPrs'),
        description: i18n.t('securityAgent.automation.autoRemediationDescription'),
      },
      {
        title: i18n.t('securityAgent.automation.dismissNonExploitable'),
        description: i18n.t('securityAgent.automation.autoDismissDescription'),
      },
    ];

    // The rendered rows carry the proof, not the expected pairs: the screen
    // draws one row per section in section order, so a row that repeated or
    // swapped another section's title fails here.
    const rendered = toggleRows.rows.filter(row =>
      sections.some(section => section.title === row.title)
    );
    expect(rendered.map(row => row.title)).toEqual(sections.map(section => section.title));

    for (const [index, section] of sections.entries()) {
      const row = rendered[index];
      if (!row) {
        throw new Error(`section toggle row ${section.title} not found`);
      }

      // Each short title keeps its own description under it, so the three rows
      // cannot swap copy between sections.
      expect(row.subtitle).toBe(section.description);

      // The sentence adds only what the title and heading cannot: the heading
      // already says "Auto", so a subtitle that names the automatic behaviour
      // is the repeated copy this row was trimmed of.
      expect((row.subtitle ?? '').toLowerCase()).not.toMatch(/\bauto/);

      // A title names the setting, not the section it sits under.
      for (const sectionName of sectionNames) {
        expect(row.title).not.toContain(sectionName);
      }
      expect(row.title.endsWith('.')).toBe(false);

      // Label in name: the switch is named by the text the row shows.
      expect(row.accessibilityLabel).toBeUndefined();
    }
  });
});
