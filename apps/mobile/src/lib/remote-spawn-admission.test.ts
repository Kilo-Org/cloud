import { describe, expect, it } from 'vitest';

import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { type SharePayload } from '@/lib/share-payload';

import {
  REMOTE_SPAWN_FILES_NOT_SUPPORTED_TOAST,
  resolveRemoteSpawnAdmission,
} from './remote-spawn-admission';

const instance: InstancePickerInstance = {
  connectionId: 'conn-1',
  name: 'CLI',
  projectName: 'project',
};

const filesPayload: SharePayload = {
  text: '',
  files: [
    { name: 'report.pdf', uri: 'file:///tmp/report.pdf', mimeType: 'application/pdf', size: 1024 },
  ],
  failedFiles: [],
};

describe('resolveRemoteSpawnAdmission', () => {
  it('rejects files for an explicitly incapable instance', () => {
    expect(
      resolveRemoteSpawnAdmission({
        instance: { ...instance, capabilities: { attachments: false } },
        payload: filesPayload,
      })
    ).toEqual({ allowed: false, toast: REMOTE_SPAWN_FILES_NOT_SUPPORTED_TOAST });
  });

  it('admits files when capability is unknown', () => {
    expect(resolveRemoteSpawnAdmission({ instance, payload: filesPayload })).toEqual({
      allowed: true,
    });
  });
});
