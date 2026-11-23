import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * The Profile Agents settings screen names one thing — the agent — so all five
 * values below must keep that one Korean noun, 에이전트, and the `visibility`
 * heading must name the setting instead of an unrelated noun:
 *
 * - `profiles.agents.add`, `empty` and `name` labelled the agent with two other
 *   nouns (상담원 / 대리인) that the same screen's title and remaining rows do
 *   not use.
 * - `profiles.agents.nameRequired` used a further noun, 상담사, for the name
 *   field that `name` labels.
 * - `profiles.agents.visibility` read "clock", not the visibility it heads.
 *
 * The values are pinned so a later edit cannot reintroduce the mixed nouns.
 */

type Case = { locale: string; key: string; value: string };

const CASES: Case[] = [
  { locale: 'ko', key: 'profiles.agents.add', value: '에이전트 추가' },
  { locale: 'ko', key: 'profiles.agents.empty', value: '아직 에이전트 없음' },
  { locale: 'ko', key: 'profiles.agents.name', value: '에이전트 이름' },
  { locale: 'ko', key: 'profiles.agents.nameRequired', value: '에이전트 이름을 입력하세요.' },
  { locale: 'ko', key: 'profiles.agents.visibility', value: '표시 범위' },
];

const LOCALES = [...new Set(CASES.map(c => c.locale))];

beforeAll(async () => {
  await Promise.all(LOCALES.map(locale => i18n.loadLanguages(locale)));
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Korean Profile Agents copy that used more than one noun', () => {
  it.each(CASES)('$locale reads $value at $key', async ({ locale, key, value }) => {
    await i18n.changeLanguage(locale);
    expect(i18n.t(key)).toBe(value);
  });
});
