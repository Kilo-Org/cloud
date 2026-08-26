import { isAllowedSalesDemoEmail } from './sales-demo-email';
import {
  SALES_DEMO_MEMBER_COUNT,
  salesDemoMemberAvatarUrl,
  salesDemoMemberEmail,
  salesDemoMemberName,
} from './sales-demo';

describe('sales demo email allow-list', () => {
  it.each([['dev@kilocode.ai'], ['dev@anaconda.com']])('accepts %s', email => {
    expect(isAllowedSalesDemoEmail(email)).toBe(true);
  });

  it.each([['dev@gmail.com'], ['dev@example.com']])('rejects %s', email => {
    expect(isAllowedSalesDemoEmail(email)).toBe(false);
  });
});

describe('sales demo member helpers', () => {
  it('formats the first member email from the human name', () => {
    expect(salesDemoMemberEmail(1)).toBe('ava.chen@harborline.ai');
  });

  it('formats the last member name from the human name', () => {
    expect(salesDemoMemberName(25)).toBe('Nora Green');
  });

  it('emits a harborline.ai email for every member and never example.com', () => {
    for (let n = 1; n <= SALES_DEMO_MEMBER_COUNT; n++) {
      const email = salesDemoMemberEmail(n);
      expect(email).toMatch(/@harborline\.ai$/);
      expect(email).not.toMatch(/example\.com$/);
      expect(salesDemoMemberName(n)).toMatch(/^\S+ \S+$/);
    }
  });

  it('builds a gravatar URL from the email', () => {
    expect(salesDemoMemberAvatarUrl('ava.chen@harborline.ai')).toBe(
      'https://www.gravatar.com/avatar/70a9d7183d05d7771f7f502f77c0d021?s=80&d=identicon'
    );
  });
});
