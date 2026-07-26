import { describe, expect, it } from 'vitest';

import { resolveShareDestinationAdmission, resolveShareHasFiles } from './share-cli-admission';
import { type SharePayloadValidation } from './share-payload-validation';

const NOT_CONNECTED_TITLE = 'Session not connected';
const NOT_CONNECTED_MESSAGE =
  "This session runs on a Kilo CLI that isn't connected, so it can't receive messages right now. Reconnect the CLI on that machine, or pick another session.";

const CANT_RECEIVE_FILES_TITLE = "This session can't receive files";
const CANT_RECEIVE_FILES_MESSAGE =
  "The Kilo CLI running this session can't receive files. Update the CLI on that machine, or share to a new session instead.";

describe('resolveShareHasFiles', () => {
  it('pending validation uses the raw file count (0 and >0)', () => {
    expect(resolveShareHasFiles(null, 0)).toBe(false);
    expect(resolveShareHasFiles(null, 2)).toBe(true);
  });

  it('ok with accepted files is true', () => {
    const validation: SharePayloadValidation = {
      kind: 'ok',
      accepted: [
        {
          name: 'a.jpg',
          uri: 'file:///a.jpg',
          measuredSize: 1,
          kind: 'image',
        },
      ],
      rejectedNotes: [],
      truncated: false,
      usable: true,
    };
    expect(resolveShareHasFiles(validation, 1)).toBe(true);
  });

  it('ok with zero accepted is false even when raw count > 0', () => {
    const validation: SharePayloadValidation = {
      kind: 'ok',
      accepted: [],
      rejectedNotes: [{ name: 'bad.exe', reason: 'denied' }],
      truncated: false,
      usable: true,
    };
    expect(resolveShareHasFiles(validation, 3)).toBe(false);
  });

  it('all-rejected is false', () => {
    const validation: SharePayloadValidation = {
      kind: 'all-rejected',
      reason: 'denied',
      message: 'None of the shared files can be attached.',
    };
    expect(resolveShareHasFiles(validation, 2)).toBe(false);
  });
});

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
