import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * Pashto marks the plural on the counted noun and on the verb that agrees with
 * it, so a family whose `_one` entry repeats its `_other` copy never inflects
 * for the count it exists for: "1 فایلونه" where the catalog's own singular is
 * "فایل". Every family below shipped exactly that. Both categories are pinned
 * for each one, so a copy that repeats the plural in `_one` (or the singular in
 * `_other`) fails.
 */

// The catalog is loaded per language by the app's backend, so the language has
// to change once rather than passing `lng` to each call.
beforeAll(async () => {
  await i18n.changeLanguage('ps');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Pashto count-one copy', () => {
  it('inflects the counted noun to the singular at one', () => {
    expect(i18n.t('agentChat.toolCard.filesBadge', { count: 1, displayCount: '1' })).toBe('1 فایل');
    expect(i18n.t('agentChat.toolCard.linesBadge', { count: 1, displayCount: '1' })).toBe('1 کرښه');
    expect(i18n.t('agentChat.toolCard.matchesBadge', { count: 1, displayCount: '1' })).toBe(
      '1 پایله'
    );
    expect(i18n.t('agentChat.composer.charactersRemaining', { count: 1 })).toBe('1 توری پاتې دی');
    expect(
      i18n.t('agentChat.toolRun.condensedLabel', { count: 1, itemCount: '1', last: 'Bash' })
    ).toBe('1 توکی; Bash');
    expect(
      i18n.t('agentChat.attachmentPicker.maxFilesAllowed', { count: 1, displayCount: '1' })
    ).toBe('تر 1 فایل پورې اجازه شته.');
    expect(i18n.t('chat.attachment.limit', { count: 1, displayCount: '1' })).toBe(
      'تاسو کولی شئ تر 1 پورې فایل ونښلوئ.'
    );
    expect(i18n.t('prReview.checks.checksCount', { count: 1, displayCount: '1' })).toBe(
      '1 ازموینه'
    );
    expect(i18n.t('prReview.hunkRows.expandAllLines', { count: 1, displayCount: '1' })).toBe(
      'ټوله 1 کرښه ښکاره کړئ'
    );
    expect(i18n.t('prReview.diff.truncationBanner', { count: 1, limit: '5', total: '1' })).toBe(
      'له 1 بدل شوي فایل څخه لومړنی 5 ښودل کېږي — دا د GitHub API حد دی.'
    );
    expect(i18n.t('securityAgent.dashboard.findingsCount', { count: 1, displayCount: '1' })).toBe(
      '1 موندنه'
    );
    expect(i18n.t('securityAgent.auditReport.eventsCount', { count: 1, displayCount: '1' })).toBe(
      '1 پېښه'
    );
    expect(i18n.t('securityAgent.dashboard.daysOverdue', { count: 1, displayCount: '1' })).toBe(
      '1 ورځ له مهلته تېره'
    );
    expect(i18n.t('share.onlyFirstFilesAttached', { count: 1, displayCount: '1' })).toBe(
      'یوازې لومړنی 1 فایل به ضمیمه شي.'
    );
    expect(i18n.t('todos.item.runCount', { count: 1 })).toBe('1 اجرا');
  });

  it('keeps the plural at other counts', () => {
    expect(i18n.t('agentChat.toolCard.filesBadge', { count: 2, displayCount: '2' })).toBe(
      '2 فایلونه'
    );
    expect(i18n.t('agentChat.toolCard.linesBadge', { count: 2, displayCount: '2' })).toBe('2 کرښې');
    expect(i18n.t('agentChat.toolCard.matchesBadge', { count: 2, displayCount: '2' })).toBe(
      '2 پایلې'
    );
    expect(i18n.t('agentChat.composer.charactersRemaining', { count: 2 })).toBe('2 توري پاتې دي');
    expect(
      i18n.t('agentChat.toolRun.condensedLabel', { count: 2, itemCount: '2', last: 'Bash' })
    ).toBe('2 توکي; Bash');
    expect(
      i18n.t('agentChat.attachmentPicker.maxFilesAllowed', { count: 2, displayCount: '2' })
    ).toBe('تر 2 فایلونو پورې اجازه شته.');
    expect(i18n.t('chat.attachment.limit', { count: 2, displayCount: '2' })).toBe(
      'تاسو کولی شئ تر 2 پورې فایلونه ونښلوئ.'
    );
    expect(i18n.t('prReview.checks.checksCount', { count: 2, displayCount: '2' })).toBe(
      '2 ازموینې'
    );
    expect(i18n.t('prReview.hunkRows.expandAllLines', { count: 2, displayCount: '2' })).toBe(
      'ټولې 2 کرښې ښکاره کړئ'
    );
    expect(i18n.t('prReview.diff.truncationBanner', { count: 2, limit: '5', total: '2' })).toBe(
      'له 2 بدل شویو فایلونو څخه لومړني 5 ښودل کېږي — دا د GitHub API حد دی.'
    );
    expect(i18n.t('securityAgent.dashboard.findingsCount', { count: 2, displayCount: '2' })).toBe(
      '2 موندنې'
    );
    expect(i18n.t('securityAgent.auditReport.eventsCount', { count: 2, displayCount: '2' })).toBe(
      '2 پېښې'
    );
    expect(i18n.t('securityAgent.dashboard.daysOverdue', { count: 2, displayCount: '2' })).toBe(
      '2 ورځې له مهلته تېرې'
    );
    expect(i18n.t('share.onlyFirstFilesAttached', { count: 2, displayCount: '2' })).toBe(
      'یوازې لومړني 2 فایلونه به ضمیمه شي.'
    );
    expect(i18n.t('todos.item.runCount', { count: 2 })).toBe('2 اجراوې');
  });

  it('names the restore counts without a numeral-governed noun', () => {
    // The restore lines carry two numbers, so i18next cannot pick a plural
    // category for them. The counted noun is a generic plural no numeral
    // governs, and the two figures follow it as a label.
    expect(i18n.t('agentChat.preparation.detailColdRestore', { applied: '1', total: '4' })).toBe(
      'ساړه بیا راوړنه، سناپشاټ پلی شو، بېرته راوړل شوي فایلونه: 1 له 4'
    );
    expect(
      i18n.t('agentChat.preparation.detailRestoreIncompleteFiles', {
        skipped: '1',
        total: '4',
        reasons: 'the patch did not apply',
      })
    ).toBe('بېرته نه راوړل شوي فایلونه: 1 له 4 (the patch did not apply)');
  });
});
