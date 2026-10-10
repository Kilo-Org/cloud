/* eslint-disable react-native/no-inline-styles -- the Android widget host requires native style objects */
'use no memo';

import { type ReactNode } from 'react';
import { FlexWidget, OverlapWidget, TextWidget } from 'react-native-android-widget';

import { LAUNCHER_NEW_AGENT_URL } from '@/lib/launcher-surfaces';

import { glyph, plusStrokes } from './active-agents-widget-glyphs';
import {
  CARD_PAD,
  estimateWidth,
  type Frame,
  PAD,
  place,
  type Rect,
  textAlign,
} from './active-agents-widget-parts';

/** Android's minimum touch target; a target keeps it wherever the split leaves room. */
const ACTION_TARGET = 48;
/** The visible gap between the Approve control and `+`, on every class. */
const ACTION_GAP = 4;

/** The Small/Medium/Large header's round glyphs: 24dp, their tops on the cards' padding line. */
export const HEADER_GLYPH = { cy: CARD_PAD + 12, r: 12, pad: CARD_PAD } as const;

/** An invisible touch target over an action; it may reach into the padding band. */
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

/** A target's 48dp-tall band (the cell's height when shorter) centred on `cy`, kept in the cell. */
function band(f: Frame, cy: number) {
  const height = Math.min(ACTION_TARGET, f.height);
  return { y: Math.min(Math.max(0, cy - height / 2), f.height - height), height };
}

/**
 * The trailing action slots for a `+` glyph of radius `r`: `+` ends on the
 * class's padding line and the Approve control ends 4dp before it. The two
 * targets split at the middle of that gap, so they never overlap: `+` owns the
 * rest of the trailing edge, Approve the room before the split.
 */
function slots(f: Frame, r: number, pad: number) {
  const plusX = f.width - pad - 2 * r;
  return { plusX, approveEnd: plusX - ACTION_GAP, split: plusX - ACTION_GAP / 2 };
}

/** What the Approve slot shows: nothing, a ready Approve, or the in-flight state. */
function approveSlot(f: Frame): 'approve' | 'approving' | null {
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
 * Where the round actions of radius `r` begin: the Approve slot when it draws,
 * else `+`. Content ends a gap before it.
 */
export function actionsStart(f: Frame, r: number): number {
  const { plusX, approveEnd } = slots(f, r, PAD);
  return approveSlot(f) === null ? plusX : approveEnd - 2 * r;
}

/**
 * Approve then `+`, round glyphs of radius `r` at the trailing edge, centred on
 * `cy`, inside a `pad` band (14dp unless given). A hidden action leaves its
 * slot empty, so `+` never moves.
 */
export function roundActions(
  f: Frame,
  spec: { cy: number; r: number; create: boolean; pad?: number }
) {
  const { cy, r } = spec;
  const { plusX, approveEnd, split } = slots(f, r, spec.pad ?? PAD);
  const { y, height } = band(f, cy);
  const slot = approveSlot(f);
  const nodes: ReactNode[] = [];
  if (slot !== null) {
    nodes.push(glyph(f, slot, { cx: approveEnd - r, cy, r }));
  }
  if (slot === 'approve') {
    const width = Math.max(ACTION_TARGET, 2 * r + ACTION_GAP / 2);
    nodes.push(target(f, 'approve', { x: split - width, y, width, height }));
  }
  if (spec.create) {
    nodes.push(
      glyph(f, 'create', { cx: plusX + r, cy, r }),
      target(f, 'create', { x: split, y, width: f.width - split, height })
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

/** Medium/Large: the Approve pill (86x24, wider for long copy) ends 4dp before the header `+`. */
export function pillActions(f: Frame, create: boolean) {
  const { cy, r, pad } = HEADER_GLYPH;
  const { plusX, approveEnd, split } = slots(f, r, pad);
  const { y, height } = band(f, cy);
  const slot = approveSlot(f);
  const nodes: ReactNode[] = [];
  if (slot !== null) {
    const value = slot === 'approve' ? f.props.actions.approveLabel : (f.copy.actionLine ?? '');
    const natural = Math.ceil(estimateWidth(value, 12, true)) + 28;
    // Never into "Kilo": the brand ends at 80dp.
    const width = Math.min(approveEnd - 80, Math.max(slot === 'approve' ? 86 : 96, natural));
    const x = approveEnd - width;
    nodes.push(
      pill(f, 'approve-pill', {
        x,
        y: cy - r,
        width,
        height: 2 * r,
        value,
        fill: slot === 'approve' ? 'primary' : 'secondary',
      })
    );
    if (slot === 'approve') {
      nodes.push(target(f, 'approve', { x, y, width: split - x, height }));
    }
  }
  if (create) {
    nodes.push(
      glyph(f, 'create', { cx: plusX + r, cy, r }),
      target(f, 'create', { x: split, y, width: f.width - split, height })
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
  const width = Math.min(f.width - 2 * CARD_PAD, Math.max(spec.centred ? 120 : 104, natural));
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
    target(f, 'create', { x, width, ...band(f, spec.y + spec.height / 2) }),
  ];
}
