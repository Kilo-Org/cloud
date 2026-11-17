// Test-only harness for `wireEnvLocal`. `stack-service.ts` resolves the repo
// root as `path.resolve(import.meta.dirname, '../..')`, so a fixture tree in a
// temp directory — with the real sources copied into it — is the only way to
// exercise the writer without touching the developer's own `.env.local`.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

type WireResult = { appended: boolean; keptRealWarehouse?: boolean };

export type WireEnvLocalFixture = {
  envLocalPath: string;
  wire(): Promise<WireResult>;
  restore(): void;
};

export function wireEnvLocalFixture(envLocal: string | undefined): WireEnvLocalFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-snowflake-stack-'));
  const moduleDir = path.join(root, 'dev', 'mock-snowflake');
  const sourceDir = import.meta.dirname;
  const envLocalPath = path.join(root, '.env.local');

  fs.mkdirSync(moduleDir, { recursive: true });
  for (const name of ['stack-service.ts', 'tls-env.ts', 'server.ts', 'warehouse.ts']) {
    fs.copyFileSync(path.join(sourceDir, name), path.join(moduleDir, name));
  }
  fs.mkdirSync(path.join(moduleDir, 'fixtures', 'tls'), { recursive: true });
  fs.writeFileSync(path.join(moduleDir, 'fixtures', 'tls', 'cert.pem'), 'CERT');
  fs.writeFileSync(path.join(moduleDir, 'fixtures', 'tls', 'key.pem'), 'KEY');
  fs.writeFileSync(
    path.join(moduleDir, 'fixtures', 'snowflake-env.txt'),
    'SNOWFLAKE_ACCOUNT_HOST=127.0.0.1:4792\nSNOWFLAKE_USERNAME=local\n'
  );
  if (envLocal !== undefined) fs.writeFileSync(envLocalPath, envLocal);

  return {
    envLocalPath,
    async wire(): Promise<WireResult> {
      // The fixture copy of stack-service.ts computes the same `../..` layout
      // as the real one, so running the real logic here is the point of the
      // harness. The import target only exists after this harness has copied
      // the sources into the temp root, so a static import is impossible; tsx
      // registers an ESM loader, so the dynamic import loads real TypeScript.
      const mod = (await import(pathToFileURL(path.join(moduleDir, 'stack-service.ts')).href)) as {
        wireEnvLocal(): WireResult;
      };
      return mod.wireEnvLocal();
    },
    restore(): void {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
