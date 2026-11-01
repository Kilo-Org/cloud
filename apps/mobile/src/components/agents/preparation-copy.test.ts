import { type PreparationStepSnapshot } from '@kilocode/cloud-agent-sdk';
import { beforeEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { SUPPORTED_LANGUAGES } from '@/i18n/languages';

import {
  preparationDetailText,
  preparationErrorText,
  preparationStepLabel,
  splitFailureSentence,
} from './preparation-copy';

const { t } = i18n;

function step(key: string): PreparationStepSnapshot {
  return {
    id: `phase:${key}`,
    key,
    kind: 'phase',
    label: key.replaceAll('_', ' '),
    status: 'running',
    startedAt: 1000,
    revision: 1,
  };
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('preparationStepLabel', () => {
  it('names every control-plane phase in the app language', () => {
    expect(
      [
        'workspace_setup',
        'disk_check',
        'cloning',
        'branch',
        'devcontainer_setup',
        'setup_commands',
        'workspace_restore',
        'workspace_backup',
        'sandbox_provision',
        'sandbox_boot',
        'snapshot_fallback',
        'kilo_server',
        'kilo_session',
        'restore_incomplete',
        'ready',
        'failed',
      ].map(key => preparationStepLabel(step(key), t))
    ).toEqual([
      'Workspace setup',
      'Disk check',
      'Cloning repository',
      'Setting up branch',
      'Dev container setup',
      'Running setup commands',
      'Restoring workspace',
      'Saving workspace',
      'Provisioning sandbox',
      'Starting sandbox',
      'Retrying without a snapshot',
      'Starting Kilo',
      'Preparing session',
      'Session restore incomplete',
      'Environment ready',
      'Environment setup failed',
    ]);
  });

  it('never shows a phase key the app does not know', () => {
    expect(preparationStepLabel(step('a_new_phase'), t)).toBe('Environment setup');
  });

  it('treats an inherited object member as an unknown key', () => {
    expect(preparationStepLabel(step('constructor'), t)).toBe('Environment setup');
    expect(preparationStepLabel(step('toString'), t)).toBe('Environment setup');
  });

  it('reads the label from the active catalog, not the server label', async () => {
    await i18n.changeLanguage('ja');
    expect(preparationStepLabel(step('sandbox_provision'), t)).not.toBe('Provisioning sandbox');
    expect(preparationStepLabel(step('sandbox_provision'), t)).toBe(
      i18n.getFixedT('ja')('agentChat.preparation.stepSandboxProvision')
    );
    await i18n.changeLanguage('en');
  });
});

describe('preparationDetailText', () => {
  it('matches the control plane sentences in both of their endings', () => {
    expect(preparationDetailText('Cloning repository...', t)).toBe('Cloning repository');
    expect(preparationDetailText('Cloning repository', t)).toBe('Cloning repository');
    expect(preparationDetailText('Retrying sandbox creation', t)).toBe('Retrying sandbox creation');
    expect(preparationDetailText('Warm workspace reused', t)).toBe('Warm workspace reused');
    expect(preparationDetailText('Importing session...', t)).toBe('Importing session');
  });

  it('reads a clone retry and git progress with localized numbers', async () => {
    expect(preparationDetailText('Retrying clone (attempt 2 of 3)', t)).toBe(
      'Retrying clone (attempt 2 of 3)'
    );
    expect(preparationDetailText('Cloning repository... Receiving objects: 45%', t)).toBe(
      '45% complete'
    );
    await i18n.changeLanguage('ja');
    expect(preparationDetailText('Cloning repository... Receiving objects: 45%', t)).toBe(
      i18n.getFixedT('ja')('agentChat.preparation.detailProgressPercent', { percent: '45' })
    );
    await i18n.changeLanguage('en');
  });

  it('falls back to a generic line for a sentence it has no copy for', () => {
    expect(preparationDetailText('Installing the flux capacitor', t)).toBe('Still preparing');
  });
});

describe('preparationErrorText', () => {
  it('names a route failure code', () => {
    expect(preparationErrorText('preparation_timeout', t)).toBe(
      'Environment preparation timed out'
    );
    expect(preparationErrorText('sandbox_lost', t)).toBe('The sandbox was lost');
  });

  it('names the wrapper sentences a step failure carries', () => {
    expect(preparationErrorText('Setup command 2 failed', t)).toBe('Setup command 2 failed');
    expect(preparationErrorText('Setup command 1 timed out', t)).toBe('Setup command 1 timed out');
  });

  it('falls back to the attempt failure title for an unknown value', () => {
    expect(preparationErrorText('clone failed', t)).toBe('Preparation failed');
  });
});

describe('splitFailureSentence', () => {
  it('splits a two-sentence cause into what failed and what to do', () => {
    expect(
      splitFailureSentence(
        'Container limit reached. Stop an existing container before starting another.'
      )
    ).toEqual({
      title: 'Container limit reached.',
      detail: 'Stop an existing container before starting another.',
    });
  });

  it('keeps a one-sentence cause whole and never breaks at a decimal point', () => {
    expect(splitFailureSentence('Environment preparation timed out')).toEqual({
      title: 'Environment preparation timed out',
    });
    expect(splitFailureSentence('Restored 1.5 files after the retry')).toEqual({
      title: 'Restored 1.5 files after the retry',
    });
  });

  it('breaks at the stop a script writes, not only the Latin one', () => {
    expect(splitFailureSentence('कंटेनर सीमा तक पहुँच गई। नया कंटेनर शुरू करने से पहले रोकें।')).toEqual({
      title: 'कंटेनर सीमा तक पहुँच गई।',
      detail: 'नया कंटेनर शुरू करने से पहले रोकें।',
    });
    expect(splitFailureSentence('เซสชันนี้ขาดการอัปเกรดที่จำเป็น เริ่มเซสชันใหม่เพื่อดำเนินการต่อ')).toEqual({
      title: 'เซสชันนี้ขาดการอัปเกรดที่จำเป็น',
      detail: 'เริ่มเซสชันใหม่เพื่อดำเนินการต่อ',
    });
  });

  it('splits the two-sentence failure copy in every catalog', () => {
    for (const tag of SUPPORTED_LANGUAGES) {
      const fixed = i18n.getFixedT(tag);
      for (const code of ['container_limit_reached', 'credential_upgrade_required'] as const) {
        const sentence = splitFailureSentence(preparationErrorText(code, fixed));
        expect(sentence.title.length, `${tag} ${code} has no headline`).toBeGreaterThan(0);
        expect(sentence.detail, `${tag} ${code} lost its second sentence`).toBeTruthy();
      }
    }
  });
});

describe('restore-incomplete report', () => {
  it('localizes the counts, the reason words and the missing paths', () => {
    expect(
      preparationErrorText(
        'Session restore incomplete: 2 of 5 files were not restored (the patch did not apply, the file could not be written). Missing: a.ts, b.ts',
        t
      )
    ).toBe(
      '2 of 5 files were not restored (the patch did not apply, the file could not be written). Missing: a.ts, b.ts'
    );
  });

  it('summarises the paths the wrapper capped', () => {
    expect(
      preparationErrorText(
        'Session restore incomplete: 12 of 20 files were not restored (the path is outside the workspace). Missing: a.ts, b.ts and 10 more',
        t
      )
    ).toBe(
      '12 of 20 files were not restored (the path is outside the workspace). Missing: a.ts, b.ts and 10 more'
    );
  });

  it('reports an unrecognised skip reason generically', () => {
    expect(
      preparationErrorText(
        'Session restore incomplete: 1 of 5 files were not restored (binary file).',
        t
      )
    ).toBe('1 of 5 files were not restored (an unknown reason).');
  });
});

describe('cold restore progress', () => {
  it('reads the applied and total counts', () => {
    expect(preparationDetailText('Cold restore, snapshot applied, 12/20 files restored', t)).toBe(
      'Cold restore, snapshot applied, 12 of 20 files restored'
    );
  });
});
