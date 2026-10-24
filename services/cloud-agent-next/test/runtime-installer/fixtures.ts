import { gzipSync } from 'node:zlib';
import { packageRuntimeRelease, writeTarEntries } from '../../scripts/publish-runtime.js';
import {
  RUNTIME_BASE_ABI,
  RUNTIME_HARD_MAX_EXPANDED_BYTES,
  RUNTIME_HARD_MAX_FILE_COUNT,
  RUNTIME_HARD_MAX_TRANSFER_BYTES,
} from '../../src/sandbox-control/runtime-release.js';

export async function fixtureRuntime(
  cliId = 'B',
  controlId = cliId,
  options: {
    holdSupervisor?: boolean;
    probeFailure?: boolean;
    missingSupervisor?: boolean;
    extraControl?: { path: string; bytes: Uint8Array; mode: number }[];
  } = {}
) {
  const version = cliId === 'A' ? '1.0.0' : '2.0.0';
  const cli = `#!/usr/local/bin/node
import fs from 'node:fs';
if (process.argv.includes('--version')) {
  fs.writeFileSync('/workspace/app/probe-env.json', JSON.stringify(process.env));
  ${options.probeFailure ? 'process.exit(1)' : `console.log(${JSON.stringify(version)})`};
} else { console.log(${JSON.stringify(cliId)}); }
`;
  const wrapper = `import fs from 'node:fs';
const file = '/workspace/app/starts-${controlId}';
fs.appendFileSync(file, 'start\\n');
const processes = fs.readdirSync('/proc').filter(value => /^[0-9]+$/.test(value)).flatMap(value => {
  try { return [fs.readFileSync('/proc/' + value + '/cmdline', 'utf8'), fs.readFileSync('/proc/' + value + '/environ', 'utf8')]; } catch { return []; }
});
fs.writeFileSync('/workspace/app/observed.json', JSON.stringify({ id: ${JSON.stringify(controlId)}, env: process.env, argv: process.argv, pid1: fs.readFileSync('/proc/1/cmdline', 'utf8'), processes }));
console.log('wrapper:${controlId}');
`;
  const controlEntries = [
    {
      path: 'usr/local/bin/kilocode-control-plane-wrapper.js',
      mode: 0o644,
      bytes: Buffer.from(wrapper),
    },
    ...(options.missingSupervisor
      ? []
      : [
          {
            path: 'usr/local/bin/kilocode-control-plane-supervisor.sh',
            mode: 0o755,
            bytes: Buffer.from(
              '#!/bin/sh\n/usr/local/bin/node /usr/local/bin/kilocode-control-plane-wrapper.js\n' +
                (options.holdSupervisor ? '/usr/bin/sleep 60\n' : '')
            ),
          },
        ]),
    ...(options.extraControl ?? []),
  ];
  return packageRuntimeRelease({
    cliTarball: gzipSync(
      writeTarEntries([{ path: 'package/bin/kilo', mode: 0o755, bytes: Buffer.from(cli) }])
    ),
    cliVersion: version,
    cliExecutable: 'package/bin/kilo',
    wrapperSdkVersion: '7.8.1',
    protocol: '1',
    abi: RUNTIME_BASE_ABI,
    platform: { os: 'linux', arch: 'x64', libc: 'glibc', cpu: 'baseline' },
    caps: {
      maxTransferBytes: RUNTIME_HARD_MAX_TRANSFER_BYTES,
      maxExpandedBytes: RUNTIME_HARD_MAX_EXPANDED_BYTES,
      maxFileCount: RUNTIME_HARD_MAX_FILE_COUNT,
    },
    controlEntries,
  });
}
