import { describe, expect, it } from 'vitest';

import { resolveShareDestinationAdmission } from './share-cli-admission';

const NOT_CONNECTED_TITLE = 'Session not connected';
const NOT_CONNECTED_MESSAGE =
  "This session runs on a Kilo CLI that isn't connected, so it can't receive messages right now. Reconnect the CLI on that machine, or pick another session.";

const CANT_RECEIVE_FILES_TITLE = "This session can't receive files";
const CANT_RECEIVE_FILES_MESSAGE =
  "The Kilo CLI running this session can't receive files. Update the CLI on that machine, or share to a new session instead.";

describe('resolveShareDestinationAdmission', () => {
  it('passes non-cli platforms through untouched', () => {
    expect(
      resolveShareDestinationAdmission({
        createdOnPlatform: 'cloud-agent',
        live: false,
        attachmentsCapable: false,
        hasFiles: true,
      })
    ).toEqual({ ok: true });

    expect(
      resolveShareDestinationAdmission({
        createdOnPlatform: 'cloud-agent-web',
        live: false,
        attachmentsCapable: false,
        hasFiles: true,
      })
    ).toEqual({ ok: true });
  });

  it('passes null createdOnPlatform through (non-cli)', () => {
    expect(
      resolveShareDestinationAdmission({
        createdOnPlatform: null,
        live: false,
        attachmentsCapable: false,
        hasFiles: true,
      })
    ).toEqual({ ok: true });
  });

  it('rejects cli + not live, with or without files', () => {
    expect(
      resolveShareDestinationAdmission({
        createdOnPlatform: 'cli',
        live: false,
        attachmentsCapable: false,
        hasFiles: false,
      })
    ).toEqual({
      ok: false,
      title: NOT_CONNECTED_TITLE,
      message: NOT_CONNECTED_MESSAGE,
    });

    expect(
      resolveShareDestinationAdmission({
        createdOnPlatform: 'cli',
        live: false,
        attachmentsCapable: true,
        hasFiles: true,
      })
    ).toEqual({
      ok: false,
      title: NOT_CONNECTED_TITLE,
      message: NOT_CONNECTED_MESSAGE,
    });

    expect(NOT_CONNECTED_MESSAGE).toMatch(/CLI/);
  });

  it('accepts cli + live + capable + files', () => {
    expect(
      resolveShareDestinationAdmission({
        createdOnPlatform: 'cli',
        live: true,
        attachmentsCapable: true,
        hasFiles: true,
      })
    ).toEqual({ ok: true });
  });

  it('rejects cli + live + incapable + files', () => {
    expect(
      resolveShareDestinationAdmission({
        createdOnPlatform: 'cli',
        live: true,
        attachmentsCapable: false,
        hasFiles: true,
      })
    ).toEqual({
      ok: false,
      title: CANT_RECEIVE_FILES_TITLE,
      message: CANT_RECEIVE_FILES_MESSAGE,
    });

    expect(CANT_RECEIVE_FILES_MESSAGE).toMatch(/CLI/);
  });

  it('accepts cli + live + incapable + text-only', () => {
    expect(
      resolveShareDestinationAdmission({
        createdOnPlatform: 'cli',
        live: true,
        attachmentsCapable: false,
        hasFiles: false,
      })
    ).toEqual({ ok: true });
  });

  it('rejects cli + live + capabilities-absent (attachmentsCapable false) + files', () => {
    // Absent capabilities map to attachmentsCapable: false at the call site.
    expect(
      resolveShareDestinationAdmission({
        createdOnPlatform: 'cli',
        live: true,
        attachmentsCapable: false,
        hasFiles: true,
      })
    ).toEqual({
      ok: false,
      title: CANT_RECEIVE_FILES_TITLE,
      message: CANT_RECEIVE_FILES_MESSAGE,
    });
  });

  it('accepts cli + live + capable + text-only', () => {
    expect(
      resolveShareDestinationAdmission({
        createdOnPlatform: 'cli',
        live: true,
        attachmentsCapable: true,
        hasFiles: false,
      })
    ).toEqual({ ok: true });
  });
});
