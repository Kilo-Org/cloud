import { readFileSync } from 'node:fs';
import { URL as FileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SNAPSHOT_ELIGIBLE_LIFETIME_MS, SNAPSHOT_PLATFORM_LIFETIME_MS } from './policy.js';

const day = 24 * 60 * 60_000;
const templateSchema = z.object({
  Resources: z.object({
    Artifacts: z.object({
      Properties: z.object({
        LifecycleConfiguration: z.object({
          Rules: z.array(
            z.object({
              Id: z.string(),
              Status: z.string(),
              Prefix: z.string(),
              ExpirationInDays: z.number(),
            })
          ),
        }),
      }),
    }),
  }),
});

describe('prepared archive retention contract', () => {
  it.each(['template.json', 'template.ecs.json'])(
    'expires eligibility one day before storage retention in %s',
    filename => {
      const template = templateSchema.parse(
        JSON.parse(
          readFileSync(new FileURL(`../../deploy/aws/${filename}`, import.meta.url), 'utf8')
        )
      );
      const rules = template.Resources.Artifacts.Properties.LifecycleConfiguration.Rules.filter(
        rule => rule.Prefix === 'kilo/archives/environments/'
      );
      expect(rules).toHaveLength(1);
      expect(rules[0].Status).toBe('Enabled');
      const retainedFor = rules[0].ExpirationInDays * day;
      expect(SNAPSHOT_PLATFORM_LIFETIME_MS).toBe(retainedFor);
      expect(SNAPSHOT_ELIGIBLE_LIFETIME_MS).toBe(retainedFor - day);
    }
  );
});
