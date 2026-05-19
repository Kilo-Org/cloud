import { describe, expect, it } from 'vitest';
import {
  acceptCompletionDML,
  acceptUpstreamDML,
  claimWantedDML,
  closeUpstreamDML,
  closeWantedDML,
  deleteWantedDML,
  formatNowUtc,
  formatTagsJson,
  insertWantedDML,
  rejectCompletionDML,
  submitCompletionDML,
  unclaimWantedDML,
  updateWantedDML,
} from './dml.generated';

/**
 * Smoke tests for the generated DML helpers. The expected strings are
 * hand-derived from running the Go reference (`commons.go`) on the same
 * inputs; if the generator drifts from the Go output, these tests will
 * fail.
 */

describe('formatTagsJson', () => {
  it('returns NULL for undefined or empty', () => {
    expect(formatTagsJson(undefined)).toBe('NULL');
    expect(formatTagsJson([])).toBe('NULL');
  });

  it('formats a list of plain tags', () => {
    expect(formatTagsJson(['a', 'b'])).toBe(`'["a","b"]'`);
  });

  it('escapes backslashes and double quotes', () => {
    expect(formatTagsJson(['a\\b', 'c"d'])).toBe(`'["a\\\\b","c\\"d"]'`);
  });
});

describe('formatNowUtc', () => {
  it('formats a Date as YYYY-MM-DD HH:MM:SS in UTC', () => {
    const d = new Date(Date.UTC(2025, 0, 2, 3, 4, 5));
    expect(formatNowUtc(d)).toBe('2025-01-02 03:04:05');
  });
});

describe('claimWantedDML', () => {
  it('renders the canonical Go output', () => {
    expect(claimWantedDML({ wantedId: 'wl-abc', rigHandle: 'polecat' })).toBe(
      "UPDATE wanted SET claimed_by='polecat', status='claimed', updated_at=NOW() WHERE id='wl-abc' AND status='open'"
    );
  });

  it('escapes single quotes in inputs', () => {
    expect(claimWantedDML({ wantedId: "o'malley", rigHandle: "rig'n" })).toBe(
      "UPDATE wanted SET claimed_by='rig''n', status='claimed', updated_at=NOW() WHERE id='o''malley' AND status='open'"
    );
  });
});

describe('unclaimWantedDML', () => {
  it('renders the canonical Go output', () => {
    expect(unclaimWantedDML({ wantedId: 'wl-abc' })).toBe(
      "UPDATE wanted SET claimed_by=NULL, status='open', updated_at=NOW() WHERE id='wl-abc' AND status='claimed'"
    );
  });
});

describe('closeWantedDML', () => {
  it('renders the canonical Go output', () => {
    expect(closeWantedDML({ wantedId: 'wl-abc' })).toBe(
      "UPDATE wanted SET status='completed', updated_at=NOW() WHERE id='wl-abc' AND status='in_review'"
    );
  });
});

describe('deleteWantedDML', () => {
  it('renders the canonical Go output', () => {
    expect(deleteWantedDML({ wantedId: 'wl-abc' })).toBe(
      "UPDATE wanted SET status='withdrawn', updated_at=NOW() WHERE id='wl-abc' AND status='open'"
    );
  });
});

describe('rejectCompletionDML', () => {
  it('returns DELETE then UPDATE', () => {
    expect(rejectCompletionDML({ wantedId: 'wl-abc' })).toEqual([
      "DELETE FROM completions WHERE wanted_id='wl-abc'",
      "UPDATE wanted SET status='claimed', updated_at=NOW() WHERE id='wl-abc' AND status='in_review'",
    ]);
  });
});

describe('submitCompletionDML', () => {
  it('returns UPDATE wanted then INSERT IGNORE completion (no hop)', () => {
    const out = submitCompletionDML({
      completionId: 'c-1',
      wantedId: 'wl-abc',
      rigHandle: 'polecat',
      evidence: 'http://e',
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(
      "UPDATE wanted SET status='in_review', evidence_url='http://e', updated_at=NOW() WHERE id='wl-abc' AND status='claimed' AND claimed_by='polecat'"
    );
    expect(out[1]).toBe(
      "INSERT IGNORE INTO completions (id, wanted_id, completed_by, evidence, hop_uri, completed_at) " +
        "SELECT 'c-1', 'wl-abc', 'polecat', 'http://e', NULL, NOW() " +
        "FROM wanted WHERE id='wl-abc' AND status='in_review' AND claimed_by='polecat' " +
        "AND NOT EXISTS (SELECT 1 FROM completions WHERE wanted_id='wl-abc')"
    );
  });

  it('substitutes hop_uri when provided', () => {
    const out = submitCompletionDML({
      completionId: 'c-1',
      wantedId: 'wl-abc',
      rigHandle: 'polecat',
      evidence: 'e',
      hopUri: 'h://1',
    });
    expect(out[1]).toContain("'h://1'");
  });
});

describe('insertWantedDML', () => {
  it('rejects empty id or title', () => {
    expect(() => insertWantedDML({ id: '', title: 't' })).toThrow(/ID/);
    expect(() => insertWantedDML({ id: 'a', title: '' })).toThrow(/title/);
  });

  it('produces the canonical Go output for a minimal item', () => {
    // Priority defaults to 0 to match Go's int zero-value semantics.
    const out = insertWantedDML({
      id: 'wl-abc',
      title: 'Fix it',
      now: '2025-01-02 03:04:05',
    });
    expect(out).toBe(
      "INSERT INTO wanted (id, title, description, project, type, priority, tags, posted_by, status, effort_level, created_at, updated_at)\n" +
        "VALUES ('wl-abc', 'Fix it', NULL, NULL, NULL, 0, NULL, NULL, 'open', 'medium', '2025-01-02 03:04:05', '2025-01-02 03:04:05')"
    );
  });

  it('threads description, project, type, postedBy through sqlStringOrNull', () => {
    const out = insertWantedDML({
      id: 'wl-1',
      title: 't',
      description: 'd',
      project: 'p',
      type: 'feature',
      priority: 1,
      tags: ['a', 'b'],
      postedBy: 'polecat',
      now: '2025-01-02 03:04:05',
    });
    expect(out).toContain(`'d'`);
    expect(out).toContain(`'p'`);
    expect(out).toContain(`'feature'`);
    expect(out).toContain(`'["a","b"]'`);
    expect(out).toContain(`'polecat'`);
  });
});

describe('updateWantedDML', () => {
  it('throws when no fields are set', () => {
    expect(() => updateWantedDML({ wantedId: 'wl-abc', fields: {} })).toThrow(/no fields/);
  });

  it('builds a partial UPDATE in field order', () => {
    expect(
      updateWantedDML({
        wantedId: 'wl-abc',
        fields: { title: 'New', priority: 1 },
      })
    ).toBe("UPDATE wanted SET title='New', priority=1, updated_at=NOW() WHERE id='wl-abc' AND status='open'");
  });

  it('treats tags as set even when empty', () => {
    expect(
      updateWantedDML({
        wantedId: 'wl-abc',
        fields: { tags: [] },
      })
    ).toBe("UPDATE wanted SET tags=NULL, updated_at=NOW() WHERE id='wl-abc' AND status='open'");
  });

  it('skips negative priority (Go: -1 means not set)', () => {
    expect(() =>
      updateWantedDML({ wantedId: 'wl-abc', fields: { priority: -1 } })
    ).toThrow(/no fields/);
  });
});

describe('acceptCompletionDML', () => {
  it('returns INSERT stamp, UPDATE completion, UPDATE wanted', () => {
    const out = acceptCompletionDML({
      wantedId: 'wl-abc',
      completionId: 'c-1',
      rigHandle: 'polecat',
      stamp: {
        id: 's-1',
        subject: 'rabbit',
        quality: 5,
        reliability: 4,
        severity: 'leaf',
        skillTags: ['typescript'],
        message: 'good',
      },
    });
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(
      "INSERT INTO stamps (id, author, subject, valence, confidence, severity, context_id, context_type, skill_tags, message, hop_uri, created_at) " +
        "VALUES ('s-1', 'polecat', 'rabbit', '{\"quality\": 5, \"reliability\": 4}', 1.0, 'leaf', 'c-1', 'completion', '[\"typescript\"]', 'good', NULL, NOW())"
    );
    expect(out[1]).toBe(
      "UPDATE completions SET validated_by='polecat', stamp_id='s-1', validated_at=NOW() WHERE id='c-1'"
    );
    expect(out[2]).toBe(
      "UPDATE wanted SET status='completed', updated_at=NOW() WHERE id='wl-abc' AND status='in_review'"
    );
  });
});

describe('acceptUpstreamDML', () => {
  it('returns 5 statements in canonical order', () => {
    const out = acceptUpstreamDML({
      wantedId: 'wl-abc',
      completionId: 'c-1',
      completedBy: 'rabbit',
      evidence: 'e',
      rigHandle: 'polecat',
      stamp: {
        id: 's-1',
        subject: 'rabbit',
        quality: 5,
        reliability: 4,
        severity: 'leaf',
      },
    });
    expect(out).toHaveLength(5);
    expect(out[0]).toBe("DELETE FROM completions WHERE wanted_id='wl-abc'");
    expect(out[1]).toContain("INSERT IGNORE INTO completions");
    expect(out[2]).toBe(
      "UPDATE wanted SET status='completed', claimed_by='rabbit', evidence_url='e', updated_at=NOW() WHERE id='wl-abc'"
    );
    expect(out[3]).toContain('INSERT INTO stamps');
    expect(out[4]).toBe(
      "UPDATE completions SET validated_by='polecat', stamp_id='s-1', validated_at=NOW() WHERE id='c-1'"
    );
  });
});

describe('closeUpstreamDML', () => {
  it('returns DELETE, INSERT IGNORE completion, UPDATE wanted', () => {
    const out = closeUpstreamDML({
      wantedId: 'wl-abc',
      completionId: 'c-1',
      completedBy: 'rabbit',
      evidence: 'e',
    });
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("DELETE FROM completions WHERE wanted_id='wl-abc'");
    expect(out[1]).toBe(
      "INSERT IGNORE INTO completions (id, wanted_id, completed_by, evidence, hop_uri, completed_at) VALUES ('c-1', 'wl-abc', 'rabbit', 'e', NULL, NOW())"
    );
    expect(out[2]).toBe(
      "UPDATE wanted SET status='completed', claimed_by='rabbit', evidence_url='e', updated_at=NOW() WHERE id='wl-abc'"
    );
  });
});
