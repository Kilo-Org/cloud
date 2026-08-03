import { describe, expect, it } from 'vitest';

import {
  resolveRepositorySectionView,
  shouldShowRepositoryError,
} from './new-session-repository-state';

describe('shouldShowRepositoryError', () => {
  it('keeps cached repositories visible after a background refetch error', () => {
    expect(shouldShowRepositoryError({ isError: true, repositoryCount: 1 })).toBe(false);
  });

  it('shows the error when no cached repositories are available', () => {
    expect(shouldShowRepositoryError({ isError: true, repositoryCount: 0 })).toBe(true);
  });
});

describe('resolveRepositorySectionView', () => {
  // ── loading ───────────────────────────────────────────────────────
  it('returns loading first, regardless of other values', () => {
    expect(
      resolveRepositorySectionView({
        isLoading: true,
        isError: false,
        integrationInstalled: true,
        repositoryCount: 5,
        connectCheckFailed: false,
      })
    ).toBe('loading');
  });

  it('returns loading even when error and connect fallback are present', () => {
    expect(
      resolveRepositorySectionView({
        isLoading: true,
        isError: true,
        integrationInstalled: false,
        repositoryCount: 0,
        connectCheckFailed: true,
      })
    ).toBe('loading');
  });

  // ── error ─────────────────────────────────────────────────────────
  it('returns error when query failed with no cached repos', () => {
    expect(
      resolveRepositorySectionView({
        isLoading: false,
        isError: true,
        integrationInstalled: undefined,
        repositoryCount: 0,
        connectCheckFailed: false,
      })
    ).toBe('error');
  });

  it('does NOT return error when query failed but cached repos exist', () => {
    expect(
      resolveRepositorySectionView({
        isLoading: false,
        isError: true,
        integrationInstalled: undefined,
        repositoryCount: 3,
        connectCheckFailed: false,
      })
    ).toBe('repos');
  });

  // ── connect-fallback ──────────────────────────────────────────────
  it('returns connect-fallback when the flag is set', () => {
    expect(
      resolveRepositorySectionView({
        isLoading: false,
        isError: false,
        integrationInstalled: false,
        repositoryCount: 0,
        connectCheckFailed: true,
      })
    ).toBe('connect-fallback');
  });

  it('connect-fallback takes precedence over connect', () => {
    expect(
      resolveRepositorySectionView({
        isLoading: false,
        isError: false,
        integrationInstalled: false,
        repositoryCount: 0,
        connectCheckFailed: true,
      })
    ).toBe('connect-fallback');
  });

  // ── connect ───────────────────────────────────────────────────────
  it('returns connect when GitHub is not installed', () => {
    expect(
      resolveRepositorySectionView({
        isLoading: false,
        isError: false,
        integrationInstalled: false,
        repositoryCount: 0,
        connectCheckFailed: false,
      })
    ).toBe('connect');
  });

  it('returns repos when integrationInstalled is undefined (still loading)', () => {
    expect(
      resolveRepositorySectionView({
        isLoading: false,
        isError: false,
        integrationInstalled: undefined,
        repositoryCount: 0,
        connectCheckFailed: false,
      })
    ).toBe('repos');
  });

  // ── connected-empty ───────────────────────────────────────────────
  it('returns connected-empty when installed but no repos visible', () => {
    expect(
      resolveRepositorySectionView({
        isLoading: false,
        isError: false,
        integrationInstalled: true,
        repositoryCount: 0,
        connectCheckFailed: false,
      })
    ).toBe('connected-empty');
  });

  // ── repos (happy) ─────────────────────────────────────────────────
  it('returns repos when installed with repos visible', () => {
    expect(
      resolveRepositorySectionView({
        isLoading: false,
        isError: false,
        integrationInstalled: true,
        repositoryCount: 3,
        connectCheckFailed: false,
      })
    ).toBe('repos');
  });

  // ── precedence boundaries ─────────────────────────────────────────
  it('error beats connect-fallback', () => {
    expect(
      resolveRepositorySectionView({
        isLoading: false,
        isError: true,
        integrationInstalled: false,
        repositoryCount: 0,
        connectCheckFailed: true,
      })
    ).toBe('error');
  });

  it('connect-fallback beats connect', () => {
    expect(
      resolveRepositorySectionView({
        isLoading: false,
        isError: false,
        integrationInstalled: false,
        repositoryCount: 0,
        connectCheckFailed: true,
      })
    ).toBe('connect-fallback');
  });

  it('connect beats connected-empty', () => {
    expect(
      resolveRepositorySectionView({
        isLoading: false,
        isError: false,
        integrationInstalled: false,
        repositoryCount: 0,
        connectCheckFailed: false,
      })
    ).toBe('connect');
  });

  it('connected-empty beats repos', () => {
    expect(
      resolveRepositorySectionView({
        isLoading: false,
        isError: false,
        integrationInstalled: true,
        repositoryCount: 0,
        connectCheckFailed: false,
      })
    ).toBe('connected-empty');
  });
});
