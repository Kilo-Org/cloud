'use client';

import React, { useState } from 'react';
import { getOrgTrialStatusFromDays } from '@/lib/organizations/trial-utils';
import type { OrgTrialStatus } from '@/lib/organizations/organization-types';

type TrialStateSliderProps = {
  children: (props: {
    daysRemaining: number;
    state: OrgTrialStatus;
    isOwner: boolean;
  }) => React.ReactNode;
  minDays?: number;
  maxDays?: number;
  defaultDays?: number;
  defaultRole?: 'owner' | 'member';
  showRoleToggle?: boolean;
};

export function TrialStateSlider({
  children,
  minDays = -10,
  maxDays = 30,
  defaultDays = 15,
  defaultRole = 'owner',
  showRoleToggle = true,
}: TrialStateSliderProps) {
  const [daysRemaining, setDaysRemaining] = useState(defaultDays);
  const [isOwner, setIsOwner] = useState(defaultRole === 'owner');

  const state = getOrgTrialStatusFromDays(daysRemaining);

  return (
    <div className="space-y-4">
      <div className="flex w-full items-center gap-4 rounded border p-3">
        <div className="flex w-full flex-auto gap-2">
          <label className="text-sm whitespace-nowrap">Remaining Days</label>
          <input
            type="range"
            min={minDays}
            max={maxDays}
            step={1}
            value={maxDays + minDays - daysRemaining}
            onChange={e => setDaysRemaining(maxDays + minDays - Number(e.target.value))}
            className="w-full"
          />
        </div>
        <div className="flex w-full min-w-72 flex-1 justify-end gap-1 overflow-hidden">
          <span className="w-12 text-right font-mono text-sm">
            {daysRemaining > 0 ? `+${daysRemaining}` : daysRemaining}
          </span>
          <span className="text-sm">({state})</span>
          {showRoleToggle && (
            <div className="flex gap-2">
              <button
                onClick={() => setIsOwner(true)}
                className={`rounded px-2 py-1 text-xs ${isOwner ? 'bg-blue-600 text-white' : 'bg-gray-700'}`}
              >
                Owner
              </button>
              <button
                onClick={() => setIsOwner(false)}
                className={`rounded px-2 py-1 text-xs ${!isOwner ? 'bg-blue-600 text-white' : 'bg-gray-700'}`}
              >
                Member
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="contained relative transform-[translate3d(0,0,0)]">
        {children({ daysRemaining, state, isOwner })}
      </div>
    </div>
  );
}
