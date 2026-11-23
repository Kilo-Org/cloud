import { afterEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { LTR_ISOLATE_CLOSE } from '@/lib/bidi';

import { toolDisplayName } from './tool-display-name';

afterEach(async () => {
  await i18n.changeLanguage('en');
});

const FSI = '\u2068';

/** Every tool this app can put in front of a chat, with its English name. */
const KNOWN_TOOLS = [
  ['time', 'Time'],
  ['web_search', 'Search the web'],
  ['settings_list', 'Show settings'],
  ['settings_set', 'Change settings'],
] as const;

describe('toolDisplayName', () => {
  it.each(KNOWN_TOOLS)('names the %s tool in the catalog, isolated', async (id, label) => {
    await i18n.changeLanguage('en');
    // The isolate is part of the value: a tool name sits inside a translated
    // sentence, and an unisolated Latin run reorders it on a right-to-left screen.
    expect(toolDisplayName(id)).toBe(`${FSI}${label}${LTR_ISOLATE_CLOSE}`);
  });

  it('returns an unknown id raw, inside the isolate pair', () => {
    // An MCP tool's name is its server's own; no catalog here can name it, so
    // the id is shown as it arrived rather than cased or dropped.
    expect(toolDisplayName('mcp_kilo_read-file')).toBe(
      `${FSI}mcp_kilo_read-file${LTR_ISOLATE_CLOSE}`
    );
    expect(toolDisplayName('some_future_tool')).toBe(`${FSI}some_future_tool${LTR_ISOLATE_CLOSE}`);
  });

  it('returns an id that names an inherited member raw, never a prototype member', () => {
    // A bare object-literal index would hit `Object.prototype` here and hand
    // `i18n.t` a function instead of the id.
    expect(toolDisplayName('constructor')).toBe(`${FSI}constructor${LTR_ISOLATE_CLOSE}`);
    expect(toolDisplayName('__proto__')).toBe(`${FSI}__proto__${LTR_ISOLATE_CLOSE}`);
    expect(toolDisplayName('toString')).toBe(`${FSI}toString${LTR_ISOLATE_CLOSE}`);
  });

  it("names the tool in the reader's own catalog", async () => {
    await i18n.changeLanguage('en');
    const english = toolDisplayName('web_search');
    await i18n.changeLanguage('ar');
    const arabic = toolDisplayName('web_search');
    // The Arabic catalog translates the web-search title, so a known tool is
    // never left as the English label on a right-to-left screen.
    expect(arabic).not.toBe(english);
    expect(arabic).toBe(`${FSI}${i18n.t('modelChat.webSearch.title')}${LTR_ISOLATE_CLOSE}`);
    expect(arabic.startsWith(FSI)).toBe(true);
    expect(arabic.endsWith(LTR_ISOLATE_CLOSE)).toBe(true);
  });
});
