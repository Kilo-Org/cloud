import { isAllowedSalesDemoEmail } from './sales-demo-email';
import { salesDemoMemberEmail, salesDemoMemberName } from './sales-demo';

describe('sales demo email allow-list', () => {
  it.each([['dev@kilocode.ai'], ['dev@anaconda.com']])('accepts %s', email => {
    expect(isAllowedSalesDemoEmail(email)).toBe(true);
  });

  it.each([['dev@gmail.com'], ['dev@example.com']])('rejects %s', email => {
    expect(isAllowedSalesDemoEmail(email)).toBe(false);
  });
});

describe('sales demo member helpers', () => {
  it('formats the first member email with padded ids', () => {
    expect(salesDemoMemberEmail(1)).toBe('sales-demo-member-01@example.com');
  });

  it('formats the last member name', () => {
    expect(salesDemoMemberName(25)).toBe('Demo Member 25');
  });
});
