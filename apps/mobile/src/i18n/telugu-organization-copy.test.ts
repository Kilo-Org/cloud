import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * Telugu copy for the organization screens and the offline banner. Each value
 * below either carried sentence punctuation where the row is a label, named a
 * noun the English source does not contain, or addressed the reader where the
 * English source describes the alert the setting sends.
 */

beforeAll(async () => {
  await i18n.changeLanguage('te');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Telugu organization, offline and invite copy', () => {
  it('leaves the offline banner label and the organization boundary titles unpunctuated', () => {
    expect(i18n.t('offline.noInternet')).toBe('ఇంటర్నెట్ కనెక్షన్ లేదు');
    expect(i18n.t('organization.boundary.loadErrorTitle')).toBe('మీ సంస్థలను లోడ్ చేయలేకపోయాము');
    expect(i18n.t('organization.boundary.organizationUnavailable')).toBe('సంస్థ అందుబాటులో లేదు');
  });

  it('names the organization-defined credit category without an added noun', () => {
    expect(i18n.t('organization.creditActivity.category.organization_custom')).toBe('సంస్థ కస్టమ్');
  });

  it('keeps the invite email error unpunctuated like its canonical entry', () => {
    expect(i18n.t('organization.inviteMember.emailError')).toBe(
      'చెల్లుబాటు అయ్యే ఇమెయిల్ చిరునామాను నమోదు చేయండి'
    );
  });

  it('describes the low-balance alert the setting emails without addressing the reader', () => {
    expect(i18n.t('organization.lowBalanceAlert.subtitle')).toBe(
      'ఈ సంస్థ బ్యాలెన్స్ మీరు సెట్ చేసిన మొత్తం కంటే తగ్గినప్పుడు, మీరు జాబితా చేసిన చిరునామాలకు ఇమెయిల్ ద్వారా హెచ్చరిక పంపబడుతుంది.'
    );
    expect(i18n.t('organization.lowBalanceAlert.thresholdError')).toBe(
      '0 కంటే ఎక్కువ మొత్తాన్ని నమోదు చేయండి'
    );
  });

  it('keeps the daily-limit messages unpunctuated and the placeholder intact', () => {
    expect(i18n.t('organization.memberLimit.memberNotFound')).toBe('సభ్యుడు కనిపించలేదు');
    expect(i18n.t('organization.memberLimit.blankError')).toBe(
      'మొత్తాన్ని నమోదు చేయండి లేదా కింద ఉన్న ‘పరిమితిని తీసివేయండి’ నొక్కండి'
    );
    expect(i18n.t('organization.memberLimit.blankWithoutLimitError', { max: '2,000' })).toBe(
      '0 నుండి 2,000 మధ్య రోజువారీ పరిమితిని నమోదు చేయండి'
    );
    expect(i18n.t('organization.memberLimit.rangeError', { max: '2,000' })).toBe(
      '0 నుండి 2,000 మధ్య మొత్తాన్ని నమోదు చేయండి'
    );
  });
});
