import 'server-only';

import { randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { kiloclaw_inbound_email_aliases } from '@kilocode/db/schema';
import { KILOCLAW_INBOUND_EMAIL_DOMAIN } from '@/lib/config.server';
import { db, type DrizzleTransaction } from '@/lib/drizzle';

const MAX_ALIAS_INSERT_ATTEMPTS = 16;

const ALIAS_WORDS: ReadonlyArray<ReadonlyArray<string>> = [
  [
    'amber',
    'cedar',
    'cobalt',
    'copper',
    'coral',
    'ember',
    'golden',
    'hazel',
    'indigo',
    'ivory',
    'jade',
    'linen',
    'ochre',
    'olive',
    'pearl',
    'russet',
    'silver',
    'sienna',
    'slate',
    'teal',
    'umber',
    'violet',
    'walnut',
    'willow',
  ],
  [
    'brook',
    'canyon',
    'cove',
    'dawn',
    'field',
    'forest',
    'harbor',
    'island',
    'lagoon',
    'meadow',
    'mesa',
    'mountain',
    'orchard',
    'prairie',
    'river',
    'sierra',
    'summit',
    'thicket',
    'tundra',
    'valley',
    'waterfall',
    'woodland',
    'grove',
    'ridge',
  ],
  [
    'bright',
    'calm',
    'clear',
    'clever',
    'gentle',
    'glad',
    'keen',
    'lively',
    'mellow',
    'nimble',
    'patient',
    'quiet',
    'rapid',
    'ready',
    'steady',
    'sunny',
    'swift',
    'tidy',
    'vivid',
    'warm',
    'wise',
    'zesty',
    'brisk',
    'solid',
  ],
  [
    'acorn',
    'birch',
    'clover',
    'fern',
    'garden',
    'heron',
    'laurel',
    'maple',
    'moss',
    'otter',
    'pine',
    'quartz',
    'raven',
    'sparrow',
    'spruce',
    'stone',
    'thistle',
    'violet',
    'wren',
    'yarrow',
    'cedar',
    'juniper',
    'lichen',
    'sage',
  ],
];

export function normalizeInboundEmailAlias(alias: string): string {
  return alias.trim().toLowerCase();
}

export function legacyInboundEmailAddress(
  instanceId: string,
  domain: string = KILOCLAW_INBOUND_EMAIL_DOMAIN
): string {
  return `ki-${instanceId.replace(/-/g, '')}@${domain}`;
}

export function generateInboundEmailAlias(): string {
  return ALIAS_WORDS.map(group => {
    const word = group[randomInt(group.length)];
    if (!word) throw new Error('Inbound email alias word list is empty');
    return word;
  }).join('-');
}

export async function createDefaultInboundEmailAlias(
  tx: DrizzleTransaction,
  instanceId: string
): Promise<string> {
  for (let attempt = 0; attempt < MAX_ALIAS_INSERT_ATTEMPTS; attempt += 1) {
    const alias = normalizeInboundEmailAlias(generateInboundEmailAlias());
    const [inserted] = await tx
      .insert(kiloclaw_inbound_email_aliases)
      .values({ alias, instance_id: instanceId })
      .onConflictDoNothing()
      .returning({ alias: kiloclaw_inbound_email_aliases.alias });

    if (inserted) return inserted.alias;
  }

  throw new Error('Failed to allocate a unique inbound email alias');
}

export async function getInboundEmailAddressForInstance(
  instanceId: string,
  domain: string = KILOCLAW_INBOUND_EMAIL_DOMAIN
): Promise<string> {
  const [aliasRow] = await db
    .select({ alias: kiloclaw_inbound_email_aliases.alias })
    .from(kiloclaw_inbound_email_aliases)
    .where(eq(kiloclaw_inbound_email_aliases.instance_id, instanceId))
    .orderBy(kiloclaw_inbound_email_aliases.alias)
    .limit(1);

  if (aliasRow) return `${aliasRow.alias}@${domain}`;
  return legacyInboundEmailAddress(instanceId, domain);
}
