/**
 * Record the modules that carry bytes into a WXT production build.
 *
 * The extension SBOM lists a package only when the shipped bundle carries bytes
 * of it, so the build has to report the bundler's module graph: it is gone once
 * the build process exits. This plugin writes that graph to the directory named
 * by `KILO_EXTENSION_SBOM_MODULES_DIR`, one JSON file per build, and never
 * touches the bundle. Without the variable the plugin is left out of the Vite
 * config entirely, so the build output is byte-identical to a normal build.
 *
 * A record is `{ "modules": [{ id, bytes }], "assets": [{ file, bytes }] }`:
 * module ids with the bytes they rendered into an output chunk, and the original
 * file of every emitted asset with that asset's byte length. The file name is a
 * prefix of the sha256 of the build's sorted output file names, which keeps one
 * file per build without depending on the build order.
 */
/* eslint-disable import/no-nodejs-modules -- The plugin records build output for the SBOM script and runs in the build process, not in the extension. */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Plugin } from 'vite';

const OUTPUT_DIR_ENV = 'KILO_EXTENSION_SBOM_MODULES_DIR';
/** Length of the sha256 prefix that names a build's record file. */
const RECORD_NAME_LENGTH = 16;

/**
 * Ascending order of two text values, without the locale collation that
 * `localeCompare` applies: a record file must not depend on the machine's locale.
 */
function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

interface ModuleRecord {
  id: string;
  bytes: number;
}

interface AssetRecord {
  file: string;
  bytes: number;
}

/** The plugin, or `false` when the build was not asked to record its module graph. */
export function sbomModulesPlugin(): Plugin | false {
  const outputDir = process.env[OUTPUT_DIR_ENV];
  if (outputDir === undefined || outputDir.length === 0) {
    return false;
  }

  let root = process.cwd();

  return {
    configResolved({ root: resolvedRoot }) {
      root = resolvedRoot;
    },
    generateBundle(_options, bundle) {
      const modules: ModuleRecord[] = [];
      const assets: AssetRecord[] = [];
      const fileNames: string[] = [];

      for (const entry of Object.values(bundle)) {
        fileNames.push(entry.fileName);
        if (entry.type === 'chunk') {
          for (const [id, module] of Object.entries(entry.modules)) {
            if (module.renderedLength > 0) {
              modules.push({ bytes: module.renderedLength, id });
            }
          }
        } else {
          const { source } = entry;
          const bytes =
            source instanceof Uint8Array ? source.byteLength : Buffer.byteLength(source);
          for (const original of entry.originalFileNames) {
            assets.push({ bytes, file: resolve(root, original) });
          }
        }
      }

      const name = createHash('sha256')
        .update(fileNames.toSorted().join('\n'))
        .digest('hex')
        .slice(0, RECORD_NAME_LENGTH);

      mkdirSync(outputDir, { recursive: true });
      writeFileSync(
        join(outputDir, `${name}.json`),
        `${JSON.stringify(
          {
            assets: assets.toSorted((left, right) => compareText(left.file, right.file)),
            modules: modules.toSorted((left, right) => compareText(left.id, right.id)),
          },
          null,
          2
        )}\n`
      );
    },
    name: 'kilo-extension-sbom-modules',
  };
}
