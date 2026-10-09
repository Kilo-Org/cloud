/* eslint-disable react-native/no-inline-styles -- the Android widget host requires native style objects */
'use no memo';

import { type ReactNode } from 'react';
import { FlexWidget, OverlapWidget, TextWidget } from 'react-native-android-widget';

import { LAUNCHER_NEW_AGENT_URL } from '@/lib/launcher-surfaces';

import { glyph, plusStrokes } from './active-agents-widget-glyphs';
import {
  estimateWidth,
  type Frame,
  place,
  type Rect,
  textAlign,
} from './active-agents-widget-parts';

/** Every action keeps a 48dp touch target, whatever size its glyph draws at. */
const ACTION_TARGET = 48;

/** An invisible 48dp-or-wider touch target over an action, placed apart from its glyph. */
function target(f: Frame, key: 'create' | 'approve', rect: Rect) {
  const approvalKey = f.props.home?.approvalKey ?? null;
  return (
    <FlexWidget
      key={`${key}-target`}
      {...(key === 'create'
        ? { clickAction: 'OPEN_URI', clickActionData: { uri: LAUNCHER_NEW_AGENT_URL } }
        : { clickAction: 'approve', clickActionData: { approvalKey } })}
      accessibilityLabel={
        key === 'create' ? f.props.actions.newAgentLabel : f.props.actions.approveLabel
      }
      style={place(f, rect)}
    />
  );
}

/** What the Approve slot shows: nothing, a ready Approve, or the in-flight state. */
export function approveSlot(f: Frame): 'approve' | 'approving' | null {
  if (f.copy.statusKind !== 'content') {
    return null;
  }
  if (f.props.actionFeedback === 'approving') {
    return 'approving';
  }
  const ready = f.props.home?.canApprove === true && (f.props.home.approvalKey ?? null) !== null;
  return ready ? 'approve' : null;
}

export function canCreate(f: Frame): boolean {
  const live = f.copy.statusKind === 'content' || f.copy.statusKind === 'empty';
  return live && (f.props.home?.canCreate ?? f.props.actions.newAgent);
}

/**
 * Approve then `+`, round glyphs at the trailing edge. Each owns a fixed 48dp
 * target: `+` at `plusTarget`, Approve immediately before it. A hidden action
 * leaves its slot empty, so `+` never moves.
 */
export function roundActions(
  f: Frame,
  spec: {
    cy: number;
    r: number;
    plus: number;
    approve: number;
    plusTarget: number;
    create: boolean;
  }
) {
  const y = Math.min(Math.max(0, spec.cy - ACTION_TARGET / 2), f.height - ACTION_TARGET);
  const slot = approveSlot(f);
  const nodes: ReactNode[] = [];
  if (slot !== null) {
    nodes.push(glyph(f, slot, { cx: spec.approve, cy: spec.cy, r: spec.r }));
  }
  if (slot === 'approve') {
    const x = spec.plusTarget - ACTION_TARGET;
    nodes.push(target(f, 'approve', { x, y, width: ACTION_TARGET, height: ACTION_TARGET }));
  }
  if (spec.create) {
    nodes.push(
      glyph(f, 'create', { cx: spec.plus, cy: spec.cy, r: spec.r }),
      target(f, 'create', { x: spec.plusTarget, y, width: ACTION_TARGET, height: ACTION_TARGET })
    );
  }
  return nodes;
}

/** A filled pill with one centred label. */
function pill(
  f: Frame,
  key: string,
  spec: Rect & { value: string; fill: 'primary' | 'secondary' }
) {
  const ink = spec.fill === 'primary' ? 'primaryForeground' : 'muted';
  return (
    <FlexWidget
      key={key}
      style={{
        ...place(f, spec),
        borderRadius: spec.height / 2,
        backgroundColor: f.paint.palette[spec.fill],
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 8,
      }}
    >
      <TextWidget
        text={spec.value}
        maxLines={1}
        truncate="END"
        allowFontScaling={false}
        style={{
          fontSize: 12,
          fontWeight: '600',
          color: f.paint.palette[ink],
          textAlign: 'center',
        }}
      />
    </FlexWidget>
  );
}

/** Medium/Large: the Approve pill (86x24, wider for long copy) ends where `+`'s target begins. */
export function pillActions(f: Frame, create: boolean) {
  const slot = approveSlot(f);
  const nodes: ReactNode[] = [];
  const end = f.width - ACTION_TARGET;
  if (slot !== null) {
    const value = slot === 'approve' ? f.props.actions.approveLabel : (f.copy.actionLine ?? '');
    const natural = Math.ceil(estimateWidth(value, 12, true)) + 28;
    // Never into "Kilo": the brand ends at 78dp.
    const width = Math.min(end - 78, Math.max(slot === 'approve' ? 86 : 96, natural));
    const x = end - width;
    nodes.push(
      pill(f, 'approve-pill', {
        x,
        y: 12,
        width,
        height: 24,
        value,
        fill: slot === 'approve' ? 'primary' : 'secondary',
      })
    );
    if (slot === 'approve') {
      nodes.push(target(f, 'approve', { x, y: 0, width, height: ACTION_TARGET }));
    }
  }
  if (create) {
    nodes.push(
      glyph(f, 'create', { cx: f.width - 28, cy: 24, r: 12 }),
      target(f, 'create', { x: end, y: 0, width: ACTION_TARGET, height: ACTION_TARGET })
    );
  }
  return nodes;
}

/** The secondary "New agent" pill that replaces the header `+` on an empty Medium/Large cell. */
export function newAgentPill(
  f: Frame,
  spec: { x: number; y: number; height: number; size: number; arm: number; centred: boolean }
) {
  const value = f.props.actions.newAgentLabel;
  const lead = spec.height;
  const natural = Math.ceil(estimateWidth(value, spec.size, true)) + lead + 12;
  const width = Math.min(f.width - 32, Math.max(spec.centred ? 120 : 104, natural));
  const x = spec.centred ? (f.width - width) / 2 : spec.x;
  const children = [
    <OverlapWidget key="glyph" style={{ width: lead, height: spec.height }}>
      {plusStrokes('new', {
        size: spec.height,
        arm: spec.arm,
        color: f.paint.palette.foreground,
        width: 2,
      })}
    </OverlapWidget>,
    <FlexWidget key="label" style={{ width: 0, flex: 1 }}>
      <TextWidget
        text={value}
        maxLines={1}
        truncate="END"
        allowFontScaling={false}
        style={{
          width: 'match_parent',
          fontSize: spec.size,
          fontWeight: '600',
          color: f.paint.palette.foreground,
          textAlign: textAlign(f, 'start'),
        }}
      />
    </FlexWidget>,
  ];
  return [
    <FlexWidget
      key="new-agent-pill"
      style={{
        ...place(f, { x, y: spec.y, width, height: spec.height }),
        borderRadius: spec.height / 2,
        backgroundColor: f.paint.palette.secondary,
        flexDirection: 'row',
        alignItems: 'center',
      }}
    >
      {f.paint.rtl ? children.toReversed() : children}
    </FlexWidget>,
    target(f, 'create', {
      x,
      y: Math.max(0, spec.y + spec.height / 2 - ACTION_TARGET / 2),
      width,
      height: ACTION_TARGET,
    }),
  ];
}
