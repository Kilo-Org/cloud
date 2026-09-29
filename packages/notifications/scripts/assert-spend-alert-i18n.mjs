import { translatePush } from '../src/i18n.ts';
import { genericPushContentForPushData } from '../src/push-presentation.ts';

const params = { scopeName: 'Acme Corp', amountUsd: '12' };
const genericBody = locale =>
  genericPushContentForPushData({ type: 'spend_alert', scope: 'personal' }, locale).body;

const rows = [
  [
    'is.internal.title',
    translatePush('is', 'internal.spendAlert.title', params),
    'Útgjaldaviðvörun',
  ],
  [
    'is.internal.body',
    translatePush('is', 'internal.spendAlert.body', params),
    'Útgjöld Acme Corp fóru yfir $12',
  ],
  ['is.generic.body', genericBody('is'), 'Útgjöldin þín þarfnast athygli'],
  [
    'it.internal.title',
    translatePush('it', 'internal.spendAlert.title', params),
    'Avviso di spesa',
  ],
  [
    'it.internal.body',
    translatePush('it', 'internal.spendAlert.body', params),
    'La spesa di Acme Corp ha superato $12',
  ],
  ['it.generic.body', genericBody('it'), 'La tua spesa richiede attenzione'],
];

for (const [key, value] of rows) console.log(`${key}: ${value}`);

const mismatched = rows.filter(([, value, expected]) => value !== expected);
for (const [key, value, expected] of mismatched) {
  console.error(`${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
}
if (mismatched.length > 0) process.exitCode = 1;
