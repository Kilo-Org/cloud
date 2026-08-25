import { describe, expect, it } from 'vitest';

import { type InstancePickerInstance } from '@/lib/picker-bridge';
import { type SharePayload } from '@/lib/share-payload';

import {
  remoteSpawnFilesNotSupportedToast,
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
    ).toEqual({ allowed: false, toast: remoteSpawnFilesNotSupportedToast() });
  });

  it('rejects files when capability is absent', () => {
    expect(resolveRemoteSpawnAdmission({ instance, payload: filesPayload })).toEqual({
      allowed: false,
      toast: remoteSpawnFilesNotSupportedToast(),
    });
  });

  it('admits files when capability is explicitly true', () => {
    expect(
      resolveRemoteSpawnAdmission({
        instance: { ...instance, capabilities: { attachments: true } },
        payload: filesPayload,
      })
    ).toEqual({ allowed: true });
  });

  it('admits a null payload without capability', () => {
    expect(resolveRemoteSpawnAdmission({ instance, payload: null })).toEqual({
      allowed: true,
    });
  });

  it('admits a text-only payload without capability', () => {
    const textOnly: SharePayload = { text: 'hello', files: [], failedFiles: [] };
    expect(resolveRemoteSpawnAdmission({ instance, payload: textOnly })).toEqual({
      allowed: true,
    });
  });
});
