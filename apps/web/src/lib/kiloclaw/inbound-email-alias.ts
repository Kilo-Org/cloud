import 'server-only';

import { randomInt } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
  kiloclaw_inbound_email_aliases,
  kiloclaw_inbound_email_reserved_aliases,
} from '@kilocode/db/schema';
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

export function generateInboundEmailAlias(): string {
  return ALIAS_WORDS.map(group => {
    const word = group[randomInt(group.length)];
    if (!word) throw new Error('Inbound email alias word list is empty');
    return word;
  }).join('-');
}

async function reserveInboundEmailAlias(tx: DrizzleTransaction): Promise<string> {
  for (let attempt = 0; attempt < MAX_ALIAS_INSERT_ATTEMPTS; attempt += 1) {
    const alias = normalizeInboundEmailAlias(generateInboundEmailAlias());
    const [inserted] = await tx
      .insert(kiloclaw_inbound_email_reserved_aliases)
      .values({ alias })
      .onConflictDoNothing()
      .returning({ alias: kiloclaw_inbound_email_reserved_aliases.alias });

    if (inserted) return inserted.alias;
  }

  throw new Error('Failed to reserve a unique inbound email alias');
}

async function createInboundEmailAlias(
  tx: DrizzleTransaction,
  instanceId: string
): Promise<string> {
  const alias = await reserveInboundEmailAlias(tx);
  await tx.insert(kiloclaw_inbound_email_aliases).values({ alias, instance_id: instanceId });
  return alias;
}

export async function createDefaultInboundEmailAlias(
  tx: DrizzleTransaction,
  instanceId: string
): Promise<string> {
  return createInboundEmailAlias(tx, instanceId);
}

export async function cycleInboundEmailAddressForInstance(
  instanceId: string,
  domain: string = KILOCLAW_INBOUND_EMAIL_DOMAIN
): Promise<string> {
  const alias = await db.transaction(async tx => {
    await tx
      .update(kiloclaw_inbound_email_aliases)
      .set({ retired_at: new Date().toISOString() })
      .where(
        and(
          eq(kiloclaw_inbound_email_aliases.instance_id, instanceId),
          isNull(kiloclaw_inbound_email_aliases.retired_at)
        )
      );

    return createInboundEmailAlias(tx, instanceId);
  });

  return `${alias}@${domain}`;
}

export async function getInboundEmailAddressForInstance(
  instanceId: string,
  domain: string = KILOCLAW_INBOUND_EMAIL_DOMAIN
): Promise<string | null> {
  const [aliasRow] = await db
    .select({ alias: kiloclaw_inbound_email_aliases.alias })
    .from(kiloclaw_inbound_email_aliases)
    .where(
      and(
        eq(kiloclaw_inbound_email_aliases.instance_id, instanceId),
        isNull(kiloclaw_inbound_email_aliases.retired_at)
      )
    )
    .limit(1);

  if (!aliasRow) return null;
  return `${aliasRow.alias}@${domain}`;
}
