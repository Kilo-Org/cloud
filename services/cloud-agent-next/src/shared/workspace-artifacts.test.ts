import { describe, expect, it } from 'vitest';
import {
  validateWorkspaceArtifactPath,
  workspaceArtifactContentType,
  workspaceArtifactObjectKey,
  WORKSPACE_ARTIFACT_MAX_DEPTH,
  WORKSPACE_ARTIFACT_MAX_PATH_BYTES,
} from './workspace-artifacts.js';

describe('validateWorkspaceArtifactPath', () => {
  it('accepts nested regular relative paths', () => {
    expect(validateWorkspaceArtifactPath('reports/2026/summary.pdf')).toEqual({
      ok: true,
      relativePath: 'reports/2026/summary.pdf',
    });
  });

  it('rejects excluded segments and dot segments', () => {
    expect(validateWorkspaceArtifactPath('node_modules/pkg/index.js')).toEqual({
      ok: false,
      reason: 'excluded_segment',
    });
    expect(validateWorkspaceArtifactPath('src/__pycache__/x.pyc')).toEqual({
      ok: false,
      reason: 'excluded_segment',
    });
    expect(validateWorkspaceArtifactPath('venv/bin/python')).toEqual({
      ok: false,
      reason: 'excluded_segment',
    });
    expect(validateWorkspaceArtifactPath('reports/.hidden')).toEqual({
      ok: false,
      reason: 'excluded_segment',
    });
    expect(validateWorkspaceArtifactPath('.git/config')).toEqual({
      ok: false,
      reason: 'excluded_segment',
    });
  });

  it('rejects traversal, absolute, malformed, and control-character paths', () => {
    expect(validateWorkspaceArtifactPath('../secret')).toEqual({
      ok: false,
      reason: 'invalid_segment',
    });
    expect(validateWorkspaceArtifactPath('reports/../secret')).toEqual({
      ok: false,
      reason: 'invalid_segment',
    });
    expect(validateWorkspaceArtifactPath('/etc/passwd')).toEqual({
      ok: false,
      reason: 'invalid_segment',
    });
    expect(validateWorkspaceArtifactPath('reports//summary.pdf')).toEqual({
      ok: false,
      reason: 'invalid_segment',
    });
    expect(validateWorkspaceArtifactPath('reports\\summary.pdf')).toEqual({
      ok: false,
      reason: 'invalid_character',
    });
    expect(validateWorkspaceArtifactPath('reports/\u0000summary.pdf')).toEqual({
      ok: false,
      reason: 'invalid_character',
    });
    expect(validateWorkspaceArtifactPath('')).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects non-NFC paths, deep paths, and long paths', () => {
    expect(validateWorkspaceArtifactPath('reports/cafe\u0301.txt')).toEqual({
      ok: false,
      reason: 'not_nfc',
    });
    const deep = Array.from({ length: WORKSPACE_ARTIFACT_MAX_DEPTH + 1 }, () => 'dir').join('/');
    expect(validateWorkspaceArtifactPath(deep)).toEqual({ ok: false, reason: 'too_deep' });
    const long = `${'a'.repeat(WORKSPACE_ARTIFACT_MAX_PATH_BYTES)}/x`;
    expect(validateWorkspaceArtifactPath(long)).toEqual({ ok: false, reason: 'too_long' });
  });
});

describe('workspace artifact helpers', () => {
  it('maps file extensions to content types and falls back to octet-stream', () => {
    expect(workspaceArtifactContentType('reports/summary.PDF')).toBe('application/pdf');
    expect(workspaceArtifactContentType('images/photo.png')).toBe('image/png');
    expect(workspaceArtifactContentType('archive.unknown')).toBe('application/octet-stream');
  });

  it('builds a per-sandbox object key', () => {
    expect(workspaceArtifactObjectKey('sbx_1', 'object-1')).toBe('sbx_1/object-1');
  });
});
