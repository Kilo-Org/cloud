import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeProbeTemplates, type ProbeTemplates } from './request';

/** A family's capture file name: the `/` its key carries would otherwise nest a directory. */
export function captureFileName(family: string): string {
  return `${family.replaceAll('/', '--')}.json`;
}

/**
 * Writes one capture run's output: the templates file, every captured family's canonical
 * capture, and the removal of a capture whose family this run found unsupported.
 *
 * The two records of a family change together. A family that captures no served
 * representative loses its template entry and its capture file in the same write, because
 * every capture in the directory is read back as one the worker can build a request from.
 *
 * `scope` is `--only`: only those families change, so a family that was already unsupported
 * and this run did not select keeps whatever the directory holds. A full run owns the whole
 * directory, so a capture no template backs is stale and goes.
 */
export function writeProbeCaptureFiles(params: {
  out: string;
  cliVersion: string;
  /** The templates a scoped run merges into; a full run replaces the file instead. */
  existing?: ProbeTemplates;
  captured: ProbeTemplates;
  scope: readonly string[];
  captures: Record<string, object>;
}): { templates: ProbeTemplates; removedFiles: string[] } {
  const { out, cliVersion, captured, scope, captures } = params;
  let templates = captured;
  if (scope.length > 0) {
    if (!params.existing) throw new Error('a scoped capture needs the templates it merges into');
    templates = mergeProbeTemplates(params.existing, captured, scope);
  }
  const capturesDir = join(out, 'probe-captures');
  mkdirSync(capturesDir, { recursive: true });
  const written = new Set(Object.keys(captures).map(captureFileName));
  const stale =
    scope.length > 0
      ? scope.filter(family => !(family in templates.families)).map(captureFileName)
      : readdirSync(capturesDir).filter(name => !written.has(name));
  const removedFiles = stale.filter(name => {
    const file = join(capturesDir, name);
    if (!existsSync(file)) return false;
    rmSync(file);
    return true;
  });
  writeFileSync(join(out, 'probe-templates.json'), `${JSON.stringify(templates, null, 2)}\n`);
  for (const [family, capture] of Object.entries(captures)) {
    writeFileSync(
      join(capturesDir, captureFileName(family)),
      `${JSON.stringify({ cliVersion, ...capture }, null, 2)}\n`
    );
  }
  return { templates, removedFiles };
}
