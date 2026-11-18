import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const shaPattern = /^[a-f0-9]{40}$/;
const catalogPath = 'services/cloud-agent-next/runtime-targets.json';

export function catalogNeedsPublication(catalog) {
  if (
    !catalog?.default ||
    !catalog.targets ||
    typeof catalog.targets !== 'object' ||
    Array.isArray(catalog.targets)
  )
    throw new Error('Invalid runtime target catalog');
  if (
    [catalog.default, ...Object.values(catalog.targets)].some(
      target =>
        target?.mode !== 'downloaded' ||
        target?.image !== 'runtime-free' ||
        target.interactiveOrgIds !== undefined
    )
  )
    throw new Error('Invalid runtime target: only downloaded runtime-free startup is supported');
  return true;
}

/** Read the runtime target catalog exactly as committed at the source SHA. */
export async function readSourceCatalog(sourceSha, token, request = fetch) {
  if (!shaPattern.test(sourceSha)) throw new Error('Publication check requires an exact SHA');
  const response = await request(
    'https://api.github.com/repos/Kilo-Org/cloud/contents/' + catalogPath + '?ref=' + sourceSha,
    {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github.raw+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!response.ok) throw new Error('Runtime target catalog could not be read');
  return JSON.parse(await response.text());
}

async function main() {
  const catalog = await readSourceCatalog(process.env.SOURCE_SHA ?? '', process.env.GITHUB_TOKEN);
  await fs.appendFile(
    process.env.GITHUB_OUTPUT,
    'needed=' + String(catalogNeedsPublication(catalog)) + '\n'
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
