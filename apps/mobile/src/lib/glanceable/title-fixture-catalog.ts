import { type GlanceableFixture } from './fixture-catalog';

/**
 * Dev-only fixtures whose point is the session title: a very long Latin title,
 * and titles in scripts with tall fallback line boxes. Split out of
 * `fixture-catalog.ts` so each module stays inside the line budget.
 */

export const TITLE_FIXTURES = {
  'long-title': {
    description: 'Mixed counts with a very long newest-session title.',
    rows: () => [
      { status: 'permission', ago: 17, title: 'Migrate the billing webhooks' },
      {
        status: 'busy',
        ago: 1,
        title:
          'Refactor the authentication middleware so expired refresh tokens rotate before the websocket reconnects on flaky networks',
      },
      { status: 'busy', ago: 9, title: 'Write the release notes' },
      { status: 'idle', ago: 33, title: 'Triage new issues' },
    ],
  },
  'thai-titles': {
    description: 'Only running, with Thai session titles (tall fallback line box).',
    rows: () => [
      { status: 'busy', ago: 2, title: 'แก้ไขการทดสอบเข้าสู่ระบบที่ไม่เสถียร' },
      { status: 'busy', ago: 11, title: 'เขียนบันทึกประจำรุ่น' },
      { status: 'busy', ago: 19, title: 'ตรวจสอบรายการเซสชัน' },
    ],
  },
  'myanmar-titles': {
    description: 'Only running, with Myanmar session titles (tallest fallback line box).',
    rows: () => [
      {
        status: 'busy',
        ago: 2,
        title: 'မတည်ငြိမ်သော လော့ဂ်အင် စမ်းသပ်မှုကို ပြင်ဆင်ခြင်း',
      },
      { status: 'busy', ago: 11, title: 'ထွက်ရှိမှု မှတ်စုများ ရေးသားခြင်း' },
      { status: 'busy', ago: 19, title: 'ဆက်ရှင်စာရင်းကို စစ်ဆေးခြင်း' },
    ],
  },
} satisfies Record<string, GlanceableFixture>;
