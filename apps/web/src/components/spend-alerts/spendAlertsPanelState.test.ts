import {
  MAX_MULTIPLIER_BASIS_POINTS,
  MAX_THRESHOLD_USD,
  MIN_MULTIPLIER_BASIS_POINTS,
  MOBILE_APP_SETUP_HREF,
  MULTIPLIER_FIELD_ERROR,
  SPEND_ALERTS_FORBIDDEN,
  SPEND_ALERTS_LOAD_ERROR,
  SPEND_ALERTS_OFF_IN_NOTIFICATIONS,
  SPEND_ALERTS_PANEL_SLOT_CLASS,
  SPEND_ALERTS_PUSH_NEEDS_DEVICE,
  SPEND_ALERTS_SAVE_ERROR,
  THRESHOLD_FIELD_ERROR,
  derivePanelView,
  draftAfterSave,
  effectivePushFor,
  hasSettingsRow,
  panelControlsVisible,
  pushChannelNote,
  pushControlDisabled,
  toDraft,
  toSaveInput,
  type SpendAlertRuleDraft,
  type SpendAlertRuleWire,
  type SpendAlertsDraft,
  type SpendAlertsQueryData,
} from './spendAlertsPanelState';

function draftRule(
  overrides: Partial<SpendAlertRuleDraft> & { kind: SpendAlertRuleDraft['kind'] }
) {
  return {
    enabled: true,
    thresholdUsd: '',
    windowHours: 24 as const,
    multiplier: '',
    emailEnabled: true,
    pushEnabled: false,
    ...overrides,
  };
}

function draft(overrides: Partial<SpendAlertsDraft> = {}): SpendAlertsDraft {
  return {
    enabled: true,
    rules: [
      draftRule({ kind: 'threshold', thresholdUsd: '50', windowHours: 24 }),
      draftRule({ kind: 'anomaly', multiplier: '3' }),
    ],
    ...overrides,
  };
}

function queryData(overrides: Partial<SpendAlertsQueryData> = {}): SpendAlertsQueryData {
  return {
    canManage: true,
    pushCategoryEnabled: true,
    pushChannelBlocked: false,
    enabled: true,
    rules: [],
    ...overrides,
  };
}

const idleMutation = { isPending: false, isError: false };

describe('derivePanelView states', () => {
  it('shows a reserved loading slot while the settings query is in flight', () => {
    expect(
      derivePanelView({ isLoading: true, isError: false, data: undefined }, undefined, idleMutation)
    ).toEqual({ status: 'loading' });
  });

  it('retryable: a failed load with nothing cached reports a retryable error', () => {
    const view = derivePanelView(
      { isLoading: false, isError: true, data: undefined },
      undefined,
      idleMutation
    );
    expect(view).toEqual({ status: 'load-error', message: SPEND_ALERTS_LOAD_ERROR });
  });

  it('keeps cached settings when a background refetch fails', () => {
    const view = derivePanelView(
      { isLoading: false, isError: true, data: queryData() },
      undefined,
      idleMutation
    );
    expect(view.status).toBe('ready');
  });

  it('non-retryable: an organization non-billing caller gets no panel at all', () => {
    for (const role of ['member'] as const) {
      expect(
        derivePanelView({ isLoading: false, isError: false, data: queryData() }, role, idleMutation)
      ).toEqual({ status: 'hidden' });
      // Even a failed load stays hidden: the caller has nothing to retry.
      expect(
        derivePanelView({ isLoading: false, isError: true, data: undefined }, role, idleMutation)
      ).toEqual({ status: 'hidden' });
    }
  });

  it('renders for every billing role', () => {
    for (const role of ['owner', 'admin', 'billing_manager'] as const) {
      expect(
        derivePanelView({ isLoading: false, isError: false, data: queryData() }, role, idleMutation)
          .status
      ).toBe('ready');
    }
  });

  it('non-retryable: a server refusal says so with no controls and no retry', () => {
    const view = derivePanelView(
      {
        isLoading: false,
        isError: false,
        data: { canManage: false, pushCategoryEnabled: true, pushChannelBlocked: false },
      },
      undefined,
      idleMutation
    );
    expect(view).toEqual({ status: 'forbidden', message: SPEND_ALERTS_FORBIDDEN });
  });

  it('empty: no settings row leaves the switch off and the rules at their defaults', () => {
    const view = derivePanelView(
      {
        isLoading: false,
        isError: false,
        data: { canManage: true, pushCategoryEnabled: true, pushChannelBlocked: false },
      },
      undefined,
      idleMutation
    );

    expect(view.status).toBe('ready');
    if (view.status !== 'ready') return;
    expect(view.draft.enabled).toBe(false);
    expect(view.draft.rules.map(rule => rule.kind)).toEqual(['threshold', 'anomaly']);
    expect(view.draft.rules[0]).toMatchObject({
      enabled: true,
      thresholdUsd: '',
      windowHours: 24,
      emailEnabled: true,
      pushEnabled: false,
    });
    expect(view.draft.rules[1]).toMatchObject({
      enabled: true,
      multiplier: '',
      emailEnabled: true,
      pushEnabled: false,
    });
  });

  it('happy: configured settings become an editable draft', () => {
    const rules: SpendAlertRuleWire[] = [
      {
        kind: 'threshold',
        enabled: true,
        threshold: 12.5,
        windowHours: 168,
        multiplierBasisPoints: null,
        emailEnabled: true,
        pushEnabled: true,
        firing: false,
      },
      {
        kind: 'anomaly',
        enabled: false,
        threshold: null,
        windowHours: null,
        multiplierBasisPoints: 250,
        emailEnabled: false,
        pushEnabled: false,
        firing: true,
      },
    ];

    const view = derivePanelView(
      { isLoading: false, isError: false, data: queryData({ rules }) },
      undefined,
      idleMutation
    );

    expect(view.status).toBe('ready');
    if (view.status !== 'ready') return;
    expect(view.draft.enabled).toBe(true);
    expect(view.draft.rules).toEqual([
      {
        kind: 'threshold',
        enabled: true,
        thresholdUsd: '12.5',
        windowHours: 168,
        multiplier: '',
        emailEnabled: true,
        pushEnabled: true,
      },
      {
        kind: 'anomaly',
        enabled: false,
        thresholdUsd: '',
        windowHours: 24,
        multiplier: '2.5',
        emailEnabled: false,
        pushEnabled: false,
      },
    ]);
    expect(view.save).toEqual({ isPending: false, error: null });
  });

  it('retryable: a failed save keeps the draft and reports a retryable error', () => {
    const view = derivePanelView(
      { isLoading: false, isError: false, data: queryData() },
      undefined,
      { isPending: false, isError: true }
    );

    expect(view.status).toBe('ready');
    if (view.status !== 'ready') return;
    expect(view.save).toEqual({ isPending: false, error: SPEND_ALERTS_SAVE_ERROR });
    expect(view.draft.rules).toHaveLength(2);
  });

  it('reports a pending save so the button can show progress', () => {
    const view = derivePanelView(
      { isLoading: false, isError: false, data: queryData() },
      undefined,
      { isPending: true, isError: false }
    );
    expect(view.status === 'ready' && view.save.isPending).toBe(true);
  });
});

describe('channel agreement note', () => {
  const pushRule = { pushEnabled: true };
  const quietRule = { pushEnabled: false };

  it('renders the effective push state from the viewer category', () => {
    expect(effectivePushFor(true, pushRule)).toBe(true);
    expect(effectivePushFor(false, pushRule)).toBe(false);
    expect(effectivePushFor(true, quietRule)).toBe(false);
  });

  it('offers a browser-resolvable remedy when a rule wants push but the category is off', () => {
    expect(pushChannelNote(false, false, pushRule)).toEqual({
      message: SPEND_ALERTS_OFF_IN_NOTIFICATIONS,
      href: MOBILE_APP_SETUP_HREF,
    });
  });

  it('points at the mobile app on every rule when the viewer has no device', () => {
    for (const rule of [pushRule, quietRule]) {
      expect(pushChannelNote(true, true, rule)).toEqual({
        message: SPEND_ALERTS_PUSH_NEEDS_DEVICE,
        href: MOBILE_APP_SETUP_HREF,
      });
    }
  });

  it('never sends the web panel to the mobile-only app scheme', () => {
    expect(MOBILE_APP_SETUP_HREF.startsWith('https://')).toBe(true);
  });

  it('disables the push control on every rule when the viewer has no device', () => {
    expect(pushControlDisabled(false, true)).toBe(true);
    expect(pushControlDisabled(false, false)).toBe(false);
    // The empty state's read-only rules disable it too.
    expect(pushControlDisabled(true, false)).toBe(true);
    expect(pushControlDisabled(true, true)).toBe(true);
  });

  it('stays silent when push is effective or unwanted', () => {
    expect(pushChannelNote(true, false, pushRule)).toBeNull();
    expect(pushChannelNote(false, false, quietRule)).toBeNull();
    expect(pushChannelNote(true, false, quietRule)).toBeNull();
  });
});

describe('toSaveInput bounds', () => {
  it('accepts a draft inside the bounds and converts to the wire shape', () => {
    const result = toSaveInput(draft());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual({});
    expect(result.input).toEqual({
      enabled: true,
      rules: [
        {
          kind: 'threshold',
          enabled: true,
          threshold: 50,
          windowHours: 24,
          multiplierBasisPoints: null,
          emailEnabled: true,
          pushEnabled: false,
        },
        {
          kind: 'anomaly',
          enabled: true,
          threshold: null,
          windowHours: null,
          multiplierBasisPoints: 300,
          emailEnabled: true,
          pushEnabled: false,
        },
      ],
    });
  });

  it('accepts the exact upper limit', () => {
    const result = toSaveInput(
      draft({
        rules: [
          draftRule({ kind: 'threshold', thresholdUsd: String(MAX_THRESHOLD_USD) }),
          draftRule({ kind: 'anomaly', multiplier: '50' }),
        ],
      })
    );
    expect(result.ok).toBe(true);
  });

  it('accepts one microdollar, the smallest limit the store can represent', () => {
    const result = toSaveInput(
      draft({
        rules: [
          draftRule({ kind: 'threshold', thresholdUsd: '0.000001' }),
          draftRule({ kind: 'anomaly', multiplier: '3' }),
        ],
      })
    );
    expect(result.ok).toBe(true);
  });

  it.each(['0', '-1', '1000000.01', '', 'abc', '0.0000001'])(
    'rejects the limit %p with an inline field error',
    thresholdUsd => {
      const result = toSaveInput(
        draft({
          rules: [
            draftRule({ kind: 'threshold', thresholdUsd }),
            draftRule({ kind: 'anomaly', multiplier: '3' }),
          ],
        })
      );
      expect(result.ok).toBe(false);
      expect(result.input).toBeNull();
      expect(result.errors.threshold).toBe(THRESHOLD_FIELD_ERROR);
      expect(result.errors.multiplier).toBeUndefined();
    }
  );

  it.each(['0.5', '0', '-2', '50.01', '', 'x'])(
    'rejects the spike multiplier %p with an inline field error',
    multiplier => {
      const result = toSaveInput(
        draft({
          rules: [
            draftRule({ kind: 'threshold', thresholdUsd: '10' }),
            draftRule({ kind: 'anomaly', multiplier }),
          ],
        })
      );
      expect(result.ok).toBe(false);
      expect(result.input).toBeNull();
      expect(result.errors.multiplier).toBe(MULTIPLIER_FIELD_ERROR);
      expect(result.errors.threshold).toBeUndefined();
    }
  );

  it('rounds a typed multiplier to basis points', () => {
    const result = toSaveInput(
      draft({
        rules: [
          draftRule({ kind: 'threshold', thresholdUsd: '10' }),
          draftRule({ kind: 'anomaly', multiplier: '2.55' }),
        ],
      })
    );
    expect(result.ok).toBe(true);
    expect(result.input?.rules[1].multiplierBasisPoints).toBe(255);
  });
});

describe('toSaveInput with a rule kind switched off', () => {
  const disabledThreshold = draftRule({ kind: 'threshold', enabled: false, thresholdUsd: '' });
  const disabledAnomaly = draftRule({ kind: 'anomaly', enabled: false, multiplier: '' });

  it('lets Save pass when a switched-off limit is blank, and submits a schema-valid stand-in', () => {
    const result = toSaveInput(
      draft({
        rules: [disabledThreshold, draftRule({ kind: 'anomaly', multiplier: '3' })],
      })
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual({});
    const rule = result.input?.rules.find(candidate => candidate.kind === 'threshold');
    expect(rule?.enabled).toBe(false);
    expect(rule?.threshold).toBeGreaterThan(0);
    expect(rule?.threshold).toBeLessThanOrEqual(MAX_THRESHOLD_USD);
    expect(rule?.windowHours).toBe(24);
  });

  it('lets Save pass when a switched-off multiplier is blank, and submits a schema-valid stand-in', () => {
    const result = toSaveInput(
      draft({
        rules: [draftRule({ kind: 'threshold', thresholdUsd: '10' }), disabledAnomaly],
      })
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual({});
    const rule = result.input?.rules.find(candidate => candidate.kind === 'anomaly');
    expect(rule?.enabled).toBe(false);
    expect(rule?.multiplierBasisPoints).toBeGreaterThanOrEqual(MIN_MULTIPLIER_BASIS_POINTS);
    expect(rule?.multiplierBasisPoints).toBeLessThanOrEqual(MAX_MULTIPLIER_BASIS_POINTS);
  });

  it('does not block Save on out-of-range text in a switched-off field', () => {
    const result = toSaveInput(
      draft({
        rules: [
          draftRule({ kind: 'threshold', enabled: false, thresholdUsd: '0' }),
          draftRule({ kind: 'anomaly', enabled: false, multiplier: 'not a number' }),
        ],
      })
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual({});
  });

  it('keeps a valid typed value on a switched-off rule', () => {
    const result = toSaveInput(
      draft({
        rules: [
          draftRule({ kind: 'threshold', enabled: false, thresholdUsd: '75' }),
          draftRule({ kind: 'anomaly', enabled: false, multiplier: '4' }),
        ],
      })
    );

    expect(result.ok).toBe(true);
    expect(result.input?.rules[0]).toMatchObject({ enabled: false, threshold: 75 });
    expect(result.input?.rules[1]).toMatchObject({ enabled: false, multiplierBasisPoints: 400 });
  });

  it('still reports the error of the rule kind that is switched on', () => {
    const result = toSaveInput(
      draft({
        rules: [disabledThreshold, draftRule({ kind: 'anomaly', multiplier: '' })],
      })
    );

    expect(result.ok).toBe(false);
    expect(result.errors.threshold).toBeUndefined();
    expect(result.errors.multiplier).toBe(MULTIPLIER_FIELD_ERROR);
  });
});

describe('toDraft', () => {
  it('keeps both rule kinds in a stable order when the wire omits one', () => {
    const only = toDraft(
      queryData({
        rules: [
          {
            kind: 'anomaly',
            enabled: true,
            threshold: null,
            windowHours: null,
            multiplierBasisPoints: 150,
            emailEnabled: true,
            pushEnabled: false,
            firing: false,
          },
        ],
      })
    );
    expect(only.rules.map(rule => rule.kind)).toEqual(['threshold', 'anomaly']);
    expect(only.rules[0].thresholdUsd).toBe('');
    expect(only.rules[1].multiplier).toBe('1.5');
  });

  it('falls back to the 24-hour window for an unknown stored window', () => {
    const view = toDraft(
      queryData({
        rules: [
          {
            kind: 'threshold',
            enabled: true,
            threshold: 5,
            windowHours: 99,
            multiplierBasisPoints: null,
            emailEnabled: true,
            pushEnabled: false,
            firing: false,
          },
        ],
      })
    );
    expect(view.rules[0].windowHours).toBe(24);
  });
});

describe('saved settings vs the never-configured empty state', () => {
  const savedRules: SpendAlertRuleWire[] = [
    {
      kind: 'threshold',
      enabled: true,
      threshold: 50,
      windowHours: 24,
      multiplierBasisPoints: null,
      emailEnabled: true,
      pushEnabled: false,
      firing: false,
    },
    {
      kind: 'anomaly',
      enabled: true,
      threshold: null,
      windowHours: null,
      multiplierBasisPoints: 300,
      emailEnabled: true,
      pushEnabled: false,
      firing: false,
    },
  ];

  const savedButOff: SpendAlertsQueryData = {
    canManage: true,
    pushCategoryEnabled: true,
    pushChannelBlocked: false,
    enabled: false,
    rules: savedRules,
  };

  const neverConfigured: SpendAlertsQueryData = {
    canManage: true,
    pushCategoryEnabled: true,
    pushChannelBlocked: false,
  };

  it('reads a scope that has never saved as having no settings row', () => {
    expect(hasSettingsRow(neverConfigured)).toBe(false);
    expect(hasSettingsRow({ ...neverConfigured, enabled: false, rules: [] })).toBe(false);
  });

  it('reads a saved scope from the values a saved row always carries', () => {
    expect(hasSettingsRow(savedButOff)).toBe(true);
  });

  it('marks the ready view with whether the scope has saved settings', () => {
    const empty = derivePanelView(
      { isLoading: false, isError: false, data: neverConfigured },
      undefined,
      idleMutation
    );
    expect(empty.status === 'ready' && empty.hasSettings).toBe(false);

    const saved = derivePanelView(
      { isLoading: false, isError: false, data: savedButOff },
      undefined,
      idleMutation
    );
    expect(saved.status === 'ready' && saved.hasSettings).toBe(true);
  });

  it('keeps the controls live for a saved scope whose switch is off', () => {
    // The repair: with a saved row and the feature off the panel used to hide
    // Save and the rule fields, so `enabled: false` could never be posted and
    // the feature could never be switched off.
    const view = derivePanelView(
      { isLoading: false, isError: false, data: savedButOff },
      undefined,
      idleMutation
    );
    expect(view.status).toBe('ready');
    if (view.status !== 'ready') return;
    expect(view.draft.enabled).toBe(false);
    expect(panelControlsVisible(view.draft, view.hasSettings)).toBe(true);
  });

  it('leaves the never-configured empty state with only its switch', () => {
    expect(panelControlsVisible({ enabled: false }, false)).toBe(false);
    expect(panelControlsVisible({ enabled: true }, false)).toBe(true);
    expect(panelControlsVisible({ enabled: false }, true)).toBe(true);
    expect(panelControlsVisible({ enabled: true }, true)).toBe(true);
  });
});

/**
 * The tallest ready form measured in each band, by CDP probe on the personal
 * and organization spend views with the settings saved and the push channel
 * blocked (the tallest state: every rule carries the "Get the mobile app"
 * note). The form's height is a step function of the card width because its
 * copy wraps, so a band has to cover its whole range's worst case, not the
 * common one.
 *
 * The `>= 580px` row is the reviewed e3/e8 evidence rather than a single
 * measurement: the e3 run reported the loading slot at 752px and the saved,
 * enabled form at 804px on the organization usage-details view at a 1024px
 * viewport, and the e8 sweep recorded 816px for the blocked-push form at
 * 1024-1080px viewports. Both numbers have to fit under one floor because the
 * element query that picks the band can resolve to `>= 580px` for either.
 *
 * The band below a 310px card is deliberately absent: there the form's height
 * grows without bound as the copy wraps one word per line (1101px at a 238px
 * card, 1354px at 138px), so no finite floor closes it. That band keeps the
 * pre-existing 66rem; the narrower spend views are a phone-width web layout
 * this panel does not target for shift-free reservation.
 */
const WORST_READY_FORM_HEIGHT_BY_CARD_WIDTH = [
  { fromPx: 310, toPx: 380, worstPx: 892.5 },
  { fromPx: 380, toPx: 580, worstPx: 871.5 },
  { fromPx: 580, toPx: Number.POSITIVE_INFINITY, worstPx: 816 },
];

type SlotBand = { minCardWidthPx: number; minHeightPx: number };

/** `min-h-[66rem] @min-[310px]:min-h-[58rem] ...` → the bands it reserves. */
function parseSlotBands(classText: string): SlotBand[] {
  const matches = classText.matchAll(/(?:@min-\[(\d+)px\]:)?min-h-\[(\d+)rem\]/g);
  return [...matches].map(match => ({
    minCardWidthPx: match[1] === undefined ? 0 : Number(match[1]),
    minHeightPx: Number(match[2]) * 16,
  }));
}

function reserveAt(bands: SlotBand[], cardWidthPx: number): number {
  const band = bands
    .filter(candidate => candidate.minCardWidthPx <= cardWidthPx)
    .sort((a, b) => a.minCardWidthPx - b.minCardWidthPx)
    .at(-1);
  if (band === undefined) throw new Error(`no slot band covers a ${cardWidthPx}px card`);
  return band.minHeightPx;
}

describe('panel slot reservation', () => {
  const bands = parseSlotBands(SPEND_ALERTS_PANEL_SLOT_CLASS);

  it('reserves from a base band for the narrowest card', () => {
    expect(bands[0]?.minCardWidthPx).toBe(0);
  });

  it('never shrinks the reservation as the card grows', () => {
    for (let index = 1; index < bands.length; index += 1) {
      expect(bands[index]!.minHeightPx).toBeLessThanOrEqual(bands[index - 1]!.minHeightPx);
    }
  });

  it('covers the worst ready-form height in every band', () => {
    for (const band of WORST_READY_FORM_HEIGHT_BY_CARD_WIDTH) {
      // Checked at both edges: a reserved boundary dropped inside a measured
      // band would lower the reservation partway through it.
      const edges = [band.fromPx];
      if (Number.isFinite(band.toPx)) edges.push(band.toPx - 1);
      for (const cardWidthPx of edges) {
        expect(reserveAt(bands, cardWidthPx)).toBeGreaterThanOrEqual(band.worstPx);
      }
    }
  });

  it('covers the e3 form height at every card width that view reported', () => {
    // The e3 probe measured an 804px saved form on the organization
    // usage-details view at a 1024px viewport, with the loading slot at 752px.
    // The card widths that view produces are 370px (with the organization
    // sidebar) and 786px (wide), and whichever band the element query lands on
    // has to be at least as tall as that form.
    expect(reserveAt(bands, 370)).toBeGreaterThanOrEqual(804);
    expect(reserveAt(bands, 786)).toBeGreaterThanOrEqual(804);
  });
});

describe('draft adoption after a save', () => {
  const storedOff = queryData({ enabled: false });

  it('adopts the stored values when the draft is still the one that was posted', () => {
    const submitted = draft();

    expect(draftAfterSave(submitted, submitted, storedOff)).toEqual(toDraft(storedOff));
    expect(draftAfterSave(submitted, submitted, storedOff)?.enabled).toBe(false);
  });

  it('keeps a draft edited while the save was in flight', () => {
    const submitted = draft();
    const edited = draft({
      rules: [draftRule({ kind: 'threshold', thresholdUsd: '99' }), draftRule({ kind: 'anomaly' })],
    });

    expect(draftAfterSave(edited, submitted, storedOff)).toBe(edited);
  });

  it('adopts the response when no draft had been seeded yet', () => {
    expect(draftAfterSave(null, draft(), storedOff)).toEqual(toDraft(storedOff));
  });
});
