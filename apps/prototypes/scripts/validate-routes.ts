import { readdirSync } from 'fs';
import { join } from 'path';
import { validatePrototypeRoute } from '../src/lib/prototype-route-authoring';

const appDir = join(process.cwd(), 'src/app');
const routeSlugs = readdirSync(appDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name);

const results = routeSlugs.map(slug => validatePrototypeRoute({ appDir, slug }));
const invalidResults = results.filter(result => !result.valid);

for (const result of results) {
  if (result.issues.length === 0) continue;

  console.log(`Prototype route ${result.slug}:`);
  for (const issue of result.issues) {
    console.log(`- ${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`);
  }
}

if (invalidResults.length > 0) {
  process.exit(1);
}

console.log(`Validated ${results.length} prototype route${results.length === 1 ? '' : 's'}.`);
