import { services } from '../services/registry';
import { parseEnvFile, findMissingVars } from '../utils/env';
import * as ui from '../utils/ui';
import { join } from 'path';

export async function envCheck(root: string) {
  ui.header('Environment Variable Check');

  const envLocalPath = join(root, '.env.local');
  const envLocalExists = await Bun.file(envLocalPath).exists();
  if (envLocalExists) {
    ui.success('.env.local exists');
  } else {
    ui.error('.env.local missing — run: vercel env pull');
  }

  const vercelProjectPath = join(root, '.vercel', 'project.json');
  const vercelLinked = await Bun.file(vercelProjectPath).exists();
  if (vercelLinked) {
    ui.success('Vercel project linked');
  } else {
    ui.warn('Vercel project not linked — run: vercel link --project kilocode-app');
  }

  let allGood = envLocalExists && vercelLinked;

  const servicesWithEnv = services.filter(s => s.envFile);

  for (const svc of servicesWithEnv) {
    const examplePath = join(root, svc.dir, svc.envFile!);
    const actualPath = join(root, svc.dir, '.dev.vars');

    const exampleExists = await Bun.file(examplePath).exists();
    const actualExists = await Bun.file(actualPath).exists();

    if (!actualExists) {
      ui.warn(`${svc.name}: .dev.vars missing (copy from ${svc.envFile})`);
      allGood = false;
      continue;
    }

    if (exampleExists) {
      const exampleContent = await Bun.file(examplePath).text();
      const actualContent = await Bun.file(actualPath).text();
      const example = parseEnvFile(exampleContent);
      const actual = parseEnvFile(actualContent);
      const missing = findMissingVars(example, actual);

      if (missing.length > 0) {
        ui.warn(`${svc.name}: placeholder values: ${missing.join(', ')}`);
        allGood = false;
      } else {
        ui.success(`${svc.name}: .dev.vars OK`);
      }
    }
  }

  if (allGood) {
    console.log(`\n  ${ui.green('All environment checks passed!')}\n`);
  } else {
    console.log(`\n  ${ui.yellow('Some checks need attention (see above)')}\n`);
  }
}
