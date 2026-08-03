import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScheduledSeatCountNotice, SeatCountChangeMessage, SeatUpdateActions } from './SeatsDetail';
import { getScheduledSeatDecrease } from './scheduled-seat-decrease';

describe('SeatCountChangeMessage', () => {
  function render(currentSeats: number, newSeats: number, hasKiloPass = false) {
    return renderToStaticMarkup(
      React.createElement(SeatCountChangeMessage, { currentSeats, newSeats, hasKiloPass })
    );
  }

  test('explains that added seats also add Kilo Pass subscriptions', () => {
    const html = render(6, 10, true);

    expect(html).toContain('Adding 4 seats');
    expect(html).toContain('also adds 4 Kilo Pass subscriptions');
    expect(html).toContain('increases Kilo Pass billing');
  });

  test('explains that removed seats also remove Kilo Pass subscriptions', () => {
    const html = render(10, 9, true);

    expect(html).toContain('Removing 1 seat');
    expect(html).toContain('also removes 1 Kilo Pass subscription at the next renewal');
  });

  test('does not mention Kilo Pass without a covered agreement', () => {
    const html = render(6, 10);

    expect(html).toContain('Adding 4 seats');
    expect(html).not.toContain('Kilo Pass');
  });
});

describe('SeatUpdateActions', () => {
  test('disables actions and announces progress while seats are updating', () => {
    const html = renderToStaticMarkup(
      React.createElement(SeatUpdateActions, {
        isUpdating: true,
        onCancel: () => undefined,
        onSave: () => undefined,
      })
    );

    expect(html).toContain('Updating seats');
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain('animate-spin');
  });
});

describe('ScheduledSeatCountNotice', () => {
  test('projects a scheduled decrease from the provider quantity', () => {
    expect(
      getScheduledSeatDecrease({
        currentSeatCount: 25,
        providerSeatCount: 10,
        currentPeriodEnd: 1_787_788_800,
      })
    ).toEqual({
      nextSeatCount: 10,
      nextSeatCountEffectiveAt: '2026-08-27T00:00:00.000Z',
    });
  });

  test('shows the next-cycle seat count and effective date', () => {
    const html = renderToStaticMarkup(
      React.createElement(ScheduledSeatCountNotice, {
        currentSeatCount: 25,
        nextSeatCount: 10,
        effectiveAt: '2026-08-27T00:00:00.000Z',
      })
    );

    expect(html).toContain('Seat count scheduled to decrease');
    expect(html).toContain('change from 25 to 10');
    expect(html).toContain('Aug 27, 2026');
    expect(html).toContain('continue using all 25 seats until then');
  });
});
