import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * The Māori catalog named the share surfaces with two roots, `tiri` and
 * `tohatoha`, so the same action read as two different words on the share
 * sheet, the live-link row and the shared-session page. It now keeps one root,
 * `tohatoha`, across the whole flow, and marks the live-link new-message lines
 * with the present/habitual `e … ana` form so both states of the row read as
 * ongoing behaviour rather than as a finished event.
 *
 * The link-revoke button, its confirmation title and its failure line had
 * drifted onto two verbs; they now share `tango`. The file notice names a
 * single file in its `_one` entry instead of repeating the plural noun, and the
 * to-do sentences are corrected wordings, so a later edit to any of these
 * families cannot silently restore the old copy.
 */

beforeAll(async () => {
  await i18n.changeLanguage('mi');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Māori share copy', () => {
  it('keeps one share root across the flow', () => {
    expect(i18n.t('sessionShare.title')).toBe('Tohatoha wātū');
    expect(i18n.t('sessionShare.existingDescription')).toBe(
      'He hono tohatoha kē tō tēnei wātū. Mā te waihanga i tētahi hono hou me ēnei tautuhinga e whakakapi, ā, ka mutu te mahi a te hono tawhito.'
    );
    expect(i18n.t('sharedSession.title')).toBe('Wātū kua tohatohaina');
    expect(i18n.t('sharedSession.sharedBy', { owner: 'Ana' })).toBe('Nā Ana i tohatoha');
    expect(i18n.t('sharedSession.unavailableDescription')).toBe(
      'Kua pau, kua whakakorehia rānei tēnei hono tohatoha.'
    );
    expect(i18n.t('share.title')).toBe('Tohatoha ki Kilo');
    expect(i18n.t('share.staleTitle')).toBe('Kāore te tohatoha e wātea ana');
  });
});

describe('Māori live-link scope pair', () => {
  it('marks both new-message states as present/habitual', () => {
    expect(i18n.t('sessionShare.includesNewMessages')).toBe('E whakaurua ana ngā karere hou.');
    expect(i18n.t('sessionShare.excludesNewMessages')).toBe(
      'Kāore e whakaurua ana ngā karere hou.'
    );
  });
});

describe('Māori link revoke copy', () => {
  it('keeps the button, title and failure line on one remove verb', () => {
    expect(i18n.t('sessionShare.revoke')).toBe('Tangohia hono');
    expect(i18n.t('sessionShare.revokeTitle')).toBe('Tangohia te hono?');
    expect(i18n.t('sessionShare.revokeFailed')).toBe('Kāore i taea te tango i te hono.');
  });
});

describe('Māori file notice', () => {
  it('names a single file in the singular category and the plural above one', () => {
    const one = i18n.t('share.onlyFirstFilesAttached', { count: 1, displayCount: '1' });
    const many = i18n.t('share.onlyFirstFilesAttached', { count: 3, displayCount: '3' });
    expect(one).toBe('Ka whakapirihia te kōnae 1 tuatahi anake.');
    expect(many).toBe('Ka whakapirihia ngā kōnae 3 tuatahi anake.');
    expect(one).not.toBe(many);
  });
});

describe('Māori to-do copy', () => {
  it('keeps the corrected sentence wordings', () => {
    expect(i18n.t('todos.item.linkFailed')).toBe('Kāore i taea te hono i te wātū ki te mahi');
    expect(i18n.t('todos.item.sessionNeedsInput')).toBe('E hiahia ana te wātū ki te tāuru');
    expect(i18n.t('todos.item.startNowHint')).toBe('Pēhia kia roa hei tīmata me te kore arotake');
    expect(i18n.t('todos.item.unlinkConfirmTitle', { title: 'Tāera' })).toBe(
      'Wetea te hononga o Tāera?'
    );
  });

  it('keeps the archived list heading for one and several lists', () => {
    expect(i18n.t('todos.lists.archived', { count: 1 })).toBe('Kua penapenahia (1)');
    expect(i18n.t('todos.lists.archived', { count: 2 })).toBe('Kua penapenahia (2)');
  });
});
