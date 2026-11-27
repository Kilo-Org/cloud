import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { egressDomainSchema } from '@kilocode/worker-utils/egress-allowlist';
export type HostTlsMaterial = { certificate: string; privateKey: string };

const execute = promisify(execFile);
const MAX_CACHED_HOSTS = 128;
const MAX_PENDING_HOSTS = 8;

/** Keep the ephemeral key material in the supervisor's root-only volatile directory. */
export async function createHostCertificates(runtimePath: string) {
  const directory = await mkdtemp(join(runtimePath, 'tls-'));
  const run = (args: string[]) =>
    execute('openssl', args, { cwd: directory, timeout: 5_000, maxBuffer: 16_384 });
  try {
    await run([
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-noenc',
      '-sha256',
      '-days',
      '2',
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
      '-subj',
      '/CN=Kilo EC2 Workspace Egress',
      '-addext',
      'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ]);
    await run([
      'req',
      '-new',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-noenc',
      '-sha256',
      '-keyout',
      'leaf.key',
      '-out',
      'leaf.csr',
      '-subj',
      '/CN=Kilo EC2 Workload Proxy',
    ]);
    const [authority, privateKey] = await Promise.all([
      readFile(join(directory, 'ca.pem'), 'utf8'),
      readFile(join(directory, 'leaf.key'), 'utf8'),
    ]);
    const cached = new Map<string, HostTlsMaterial>();
    const pending = new Map<string, Promise<HostTlsMaterial>>();
    let closed = false;
    async function issue(host: string) {
      const serial = randomBytes(16).toString('hex');
      const ext = serial + '.ext';
      try {
        await writeFile(
          join(directory, ext),
          [
            'basicConstraints=critical,CA:FALSE',
            'keyUsage=critical,digitalSignature',
            'extendedKeyUsage=serverAuth',
            'authorityKeyIdentifier=keyid,issuer',
            'subjectAltName=DNS:' + host,
          ].join('\n'),
          { mode: 0o600, flag: 'wx' }
        );
        const { stdout } = await run([
          'x509',
          '-req',
          '-in',
          'leaf.csr',
          '-CA',
          'ca.pem',
          '-CAkey',
          'ca.key',
          '-set_serial',
          '0x' + serial,
          '-days',
          '2',
          '-sha256',
          '-extfile',
          ext,
        ]);
        return { certificate: stdout, privateKey };
      } finally {
        await rm(join(directory, ext), { force: true });
      }
    }
    return {
      authority,
      async certificate(hostname: string): Promise<HostTlsMaterial> {
        const host = egressDomainSchema.parse(hostname);
        if (closed) throw new Error('Host TLS authority closed');
        const existing = cached.get(host);
        if (existing) return existing;
        const current = pending.get(host);
        if (current) return current;
        if (pending.size >= MAX_PENDING_HOSTS) throw new Error('Host TLS signing busy');
        const signing = issue(host);
        pending.set(host, signing);
        try {
          const material = await signing;
          if (cached.size >= MAX_CACHED_HOSTS) {
            const oldest = cached.keys().next().value;
            if (oldest) cached.delete(oldest);
          }
          cached.set(host, material);
          return material;
        } finally {
          pending.delete(host);
        }
      },
      async close() {
        closed = true;
        await Promise.allSettled(pending.values());
        cached.clear();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new Error('Host TLS authority unavailable');
  }
}
