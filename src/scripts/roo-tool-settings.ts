import * as z from 'zod';
import yaml from 'js-yaml';

const settingsSchema = z.object({
  includedTools: z.array(z.string()).optional(),
  excludedTools: z.array(z.string()).optional(),
});

const responseSchema = z.object({
  data: z.array(
    z.object({
      name: z.string(),
      deprecated: z.boolean().optional(),
      settings: z.object({}).optional(),
      versionedSettings: z.record(z.string(), settingsSchema).optional(),
    })
  ),
});

async function main() {
  const rawResponse = await fetch('https://api.roocode.com/proxy/v1/models');
  const parsedResponse = responseSchema.parse(await rawResponse.json());
  console.log(yaml.dump(parsedResponse.data.filter(d => !d.deprecated)));
}

main().catch(console.error);
