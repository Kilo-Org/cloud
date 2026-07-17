import { type KiloSessionId } from 'cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import { type InstancePickerInstance } from '@/lib/picker-bridge';

import {
  REMOTE_SPAWN_INSTANCE_DISCONNECTED_NOTE,
  REMOTE_SPAWN_NON_RETRYABLE_TOAST,
  REMOTE_SPAWN_RETRYABLE_TOAST,
  type RemoteSubmitOutcomeAction,
  resolveRemoteSubmitOutcome,
} from './remote-submit-outcome';

const SESSION_ID: KiloSessionId = 'ses_12345678901234567890123456' as KiloSessionId;
const CONNECTION_ID = 'conn-abc123';

function instance(connectionId: string): InstancePickerInstance {
  return { connectionId, name: 'laptop', projectName: 'kilo' };
}

describe('resolveRemoteSubmitOutcome', () => {
  describe('ready outcome', () => {
    it('returns a navigate action with the sessionID', () => {
      const result: RemoteSubmitOutcomeAction = resolveRemoteSubmitOutcome({
        outcome: { status: 'ready', sessionID: SESSION_ID },
        refetchedInstances: [],
        selectedConnectionId: CONNECTION_ID,
      });
      expect(result).toEqual({ kind: 'navigate', sessionID: SESSION_ID });
    });

    it('ignores the refetchedInstances and selectedConnectionId', () => {
      const result = resolveRemoteSubmitOutcome({
        outcome: { status: 'ready', sessionID: SESSION_ID },
        refetchedInstances: [instance(CONNECTION_ID)],
        selectedConnectionId: CONNECTION_ID,
      });
      expect(result.kind).toBe('navigate');
    });
  });

  describe('retryable outcome', () => {
    it('returns a retryable action with the fixed toast copy', () => {
      const result = resolveRemoteSubmitOutcome({
        outcome: { status: 'retryable', reason: 'timeout', cause: new Error('timeout') },
        refetchedInstances: [instance(CONNECTION_ID)],
        selectedConnectionId: CONNECTION_ID,
      });
      expect(result.kind).toBe('retryable');
      if (result.kind === 'retryable') {
        expect(result.toast).toBe(REMOTE_SPAWN_RETRYABLE_TOAST);
        expect(result.shouldRefetchInstances).toBe(true);
      }
    });

    it('sets shouldResetSelectionToCloudAgent to false when the connectionId is still present', () => {
      const result = resolveRemoteSubmitOutcome({
        outcome: { status: 'retryable', reason: 'timeout', cause: new Error('timeout') },
        refetchedInstances: [instance(CONNECTION_ID), instance('conn-other')],
        selectedConnectionId: CONNECTION_ID,
      });
      expect(result.kind).toBe('retryable');
      if (result.kind === 'retryable') {
        expect(result.shouldResetSelectionToCloudAgent).toBe(false);
        expect(result.showInstanceDisconnectedNote).toBe(false);
      }
    });

    it('sets shouldResetSelectionToCloudAgent to true when the connectionId is gone from the list', () => {
      const result = resolveRemoteSubmitOutcome({
        outcome: { status: 'retryable', reason: 'timeout', cause: new Error('timeout') },
        refetchedInstances: [instance('conn-other')],
        selectedConnectionId: CONNECTION_ID,
      });
      expect(result.kind).toBe('retryable');
      if (result.kind === 'retryable') {
        expect(result.shouldResetSelectionToCloudAgent).toBe(true);
        expect(result.showInstanceDisconnectedNote).toBe(true);
      }
    });

    it('sets shouldResetSelectionToCloudAgent to true when the list is empty', () => {
      const result = resolveRemoteSubmitOutcome({
        outcome: { status: 'retryable', reason: 'timeout', cause: new Error('timeout') },
        refetchedInstances: [],
        selectedConnectionId: CONNECTION_ID,
      });
      expect(result.kind).toBe('retryable');
      if (result.kind === 'retryable') {
        expect(result.shouldResetSelectionToCloudAgent).toBe(true);
        expect(result.showInstanceDisconnectedNote).toBe(true);
      }
    });

    it('sets shouldResetSelectionToCloudAgent to true when selectedConnectionId is null', () => {
      // Edge case: if the user somehow triggered a spawn with no
      // selection (shouldn't happen, but defensive), we reset to null
      // (no-op) and show the note.
      const result = resolveRemoteSubmitOutcome({
        outcome: { status: 'retryable', reason: 'timeout', cause: new Error('timeout') },
        refetchedInstances: [instance(CONNECTION_ID)],
        selectedConnectionId: null,
      });
      expect(result.kind).toBe('retryable');
      if (result.kind === 'retryable') {
        expect(result.shouldResetSelectionToCloudAgent).toBe(true);
        expect(result.showInstanceDisconnectedNote).toBe(true);
      }
    });
  });

  describe('nonRetryable outcome', () => {
    it('returns a nonRetryable action with the fixed toast copy', () => {
      const result = resolveRemoteSubmitOutcome({
        outcome: {
          status: 'nonRetryable',
          reason: 'CLI_UPGRADE_REQUIRED',
          cause: new Error('CLI_UPGRADE_REQUIRED'),
        },
        refetchedInstances: [instance(CONNECTION_ID)],
        selectedConnectionId: CONNECTION_ID,
      });
      expect(result).toEqual({
        kind: 'nonRetryable',
        toast: REMOTE_SPAWN_NON_RETRYABLE_TOAST,
      });
    });

    it('ignores the refetchedInstances and selectedConnectionId', () => {
      const result = resolveRemoteSubmitOutcome({
        outcome: {
          status: 'nonRetryable',
          reason: 'CLI_UPGRADE_REQUIRED',
          cause: new Error('CLI_UPGRADE_REQUIRED'),
        },
        refetchedInstances: [],
        selectedConnectionId: null,
      });
      expect(result.kind).toBe('nonRetryable');
    });
  });

  describe('toast copy constants', () => {
    it('exports the instance-disconnected note as a constant', () => {
      expect(REMOTE_SPAWN_INSTANCE_DISCONNECTED_NOTE).toBe(
        'The selected instance disconnected. Start a session on Cloud Agent or pick another instance.'
      );
    });
  });
});
