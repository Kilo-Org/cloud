import { describe, expect, it } from 'vitest';
import {
  escapeSqlIdentifier,
  escapeSqlLike,
  escapeSqlString,
  sqlStringLiteral,
  sqlStringOrNull,
  sqlValue,
} from './escape';

describe('escapeSqlString', () => {
  it('passes plain ASCII through unchanged', () => {
    expect(escapeSqlString('plain-handle_42')).toBe('plain-handle_42');
    expect(escapeSqlString('hello world')).toBe('hello world');
  });

  it('returns empty string for empty input', () => {
    expect(escapeSqlString('')).toBe('');
  });

  it('doubles single quotes (Go: " \' " -> " \'\' ")', () => {
    expect(escapeSqlString("o'malley")).toBe("o''malley");
    expect(escapeSqlString("''")).toBe("''''");
  });

  it('doubles backslashes', () => {
    expect(escapeSqlString('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  it('escapes backslash before quote (order: backslash first)', () => {
    // Go semantics: `\` -> `\\` first, then `'` -> `''`. So input `\'`
    // becomes `\\''` (NOT `\\\\''` and NOT `\''`).
    expect(escapeSqlString("\\'")).toBe("\\\\''");
  });

  it('preserves UTF-8 / unicode bytes verbatim', () => {
    // Go's strings.ReplaceAll operates on bytes but the patterns are ASCII,
    // so non-ASCII UTF-8 sequences pass through. JS string replace on the
    // same ASCII patterns gives the same result.
    expect(escapeSqlString('café')).toBe('café');
    expect(escapeSqlString('日本語')).toBe('日本語');
    expect(escapeSqlString('🤠 howdy')).toBe('🤠 howdy');
  });

  it('does not transform null bytes, newlines, or tabs', () => {
    // EscapeSQL only touches `\` and `'`. Other control chars are passed
    // through; callers must validate input shape if those are unsafe.
    expect(escapeSqlString('a\0b')).toBe('a\0b');
    expect(escapeSqlString('a\nb\tc')).toBe('a\nb\tc');
  });

  it('matches representative Go DML outputs from commons.go', () => {
    // From ClaimWantedDML: UPDATE wanted SET claimed_by='%s' ...
    // with rigHandle="rig-1" -> claimed_by='rig-1'
    expect(`claimed_by='${escapeSqlString('rig-1')}'`).toBe("claimed_by='rig-1'");

    // From InsertWantedDML title field with an apostrophe.
    expect(`'${escapeSqlString("Bob's Wanted")}'`).toBe("'Bob''s Wanted'");
  });
});

describe('escapeSqlLike', () => {
  it('applies SQL escape, then escapes % and _ wildcards', () => {
    expect(escapeSqlLike('100%')).toBe('100\\%');
    expect(escapeSqlLike('a_b')).toBe('a\\_b');
    expect(escapeSqlLike("o'_malley%")).toBe("o''\\_malley\\%");
  });

  it('passes plain text through unchanged', () => {
    expect(escapeSqlLike('plain')).toBe('plain');
  });

  it('escapes backslashes first (Go order)', () => {
    // backslash -> doubled, then % escaped, _ escaped
    expect(escapeSqlLike('\\%_')).toBe('\\\\\\%\\_');
  });
});

describe('escapeSqlIdentifier', () => {
  it('wraps a plain identifier in backticks', () => {
    expect(escapeSqlIdentifier('wanted')).toBe('`wanted`');
    expect(escapeSqlIdentifier('claimed_by')).toBe('`claimed_by`');
  });

  it('doubles embedded backticks', () => {
    expect(escapeSqlIdentifier('weird`name')).toBe('`weird``name`');
    // input "``" -> each backtick doubled -> "````", wrapped -> "``````"
    expect(escapeSqlIdentifier('``')).toBe('``````');
  });

  it('handles empty input (yields empty backtick pair)', () => {
    expect(escapeSqlIdentifier('')).toBe('``');
  });
});

describe('sqlStringLiteral', () => {
  it('wraps the escaped value in single quotes', () => {
    expect(sqlStringLiteral('hi')).toBe("'hi'");
    expect(sqlStringLiteral("o'brien")).toBe("'o''brien'");
    expect(sqlStringLiteral('')).toBe("''");
  });
});

describe('sqlStringOrNull', () => {
  it('returns the literal NULL for empty / null / undefined', () => {
    expect(sqlStringOrNull('')).toBe('NULL');
    expect(sqlStringOrNull(null)).toBe('NULL');
    expect(sqlStringOrNull(undefined)).toBe('NULL');
  });

  it('returns a quoted, escaped literal otherwise', () => {
    expect(sqlStringOrNull('hello')).toBe("'hello'");
    expect(sqlStringOrNull("o'malley")).toBe("'o''malley'");
  });

  it('matches the Go "field or NULL" convention from InsertWantedDML', () => {
    // Go: descField := "NULL"; if item.Description != "" {
    //   descField = fmt.Sprintf("'%s'", EscapeSQL(item.Description))
    // }
    expect(sqlStringOrNull('')).toBe('NULL');
    expect(sqlStringOrNull('a desc')).toBe("'a desc'");
  });
});

describe('sqlValue', () => {
  it('renders null and undefined as NULL', () => {
    expect(sqlValue(null)).toBe('NULL');
    expect(sqlValue(undefined)).toBe('NULL');
  });

  it('renders strings as quoted, escaped literals', () => {
    expect(sqlValue('hi')).toBe("'hi'");
    expect(sqlValue("o'malley")).toBe("'o''malley'");
  });

  it('renders finite numbers without quotes', () => {
    expect(sqlValue(0)).toBe('0');
    expect(sqlValue(42)).toBe('42');
    expect(sqlValue(-1.5)).toBe('-1.5');
  });

  it('renders bigints as plain integers', () => {
    expect(sqlValue(123n)).toBe('123');
    expect(sqlValue(-9007199254740993n)).toBe('-9007199254740993');
  });

  it('renders booleans as TRUE / FALSE', () => {
    expect(sqlValue(true)).toBe('TRUE');
    expect(sqlValue(false)).toBe('FALSE');
  });

  it('throws on NaN / Infinity', () => {
    expect(() => sqlValue(Number.NaN)).toThrow(/non-finite/);
    expect(() => sqlValue(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => sqlValue(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/);
  });
});
