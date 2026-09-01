// These files are bundled as Wrangler Data modules. The wrapper build runs in
// the Worker package's predeploy hook, so the DO never depends on an operator's
// local filesystem at runtime.
// @ts-expect-error Wrangler Data rule supplies the module at bundle time.
import wrapperArtifact from '../../wrapper/dist/wrapper.js';
// @ts-expect-error Wrangler Data rule supplies the module at bundle time.
import controlWrapperArtifact from '../../wrapper/dist/control-wrapper.js';

export type RuntimeArtifact = {
  path: string;
  bytes: Uint8Array;
  sha256: string;
};

function artifactBytes(value: unknown): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  throw new Error('Runtime artifact was not bundled as binary data');
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function getVercelRuntimeArtifacts(): Promise<RuntimeArtifact[]> {
  const artifacts = [
    {
      path: 'usr/local/bin/kilocode-wrapper.js',
      bytes: artifactBytes(wrapperArtifact),
    },
    {
      path: 'usr/local/bin/kilocode-control-wrapper.js',
      bytes: artifactBytes(controlWrapperArtifact),
    },
  ];
  return Promise.all(
    artifacts.map(async artifact => ({
      ...artifact,
      sha256: await sha256(artifact.bytes),
    }))
  );
}
