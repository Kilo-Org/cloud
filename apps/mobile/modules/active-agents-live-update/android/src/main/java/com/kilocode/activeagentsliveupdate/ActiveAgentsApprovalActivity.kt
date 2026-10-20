package com.kilocode.activeagentsliveupdate

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.view.WindowManager

/**
 * The Approve action's target, and the gate between the tap and the headless
 * approval.
 *
 * It draws nothing and keeps no history: it either starts the approval because
 * the device is already unlocked, or asks the keyguard to dismiss itself and
 * starts the approval once it has been unlocked. A cancelled or failed unlock
 * finishes without starting the approval and leaves the request in place for an
 * unlocked tap.
 *
 * API 24-25 have no `requestDismissKeyguard` and no authentication flag on an
 * action, so the approval waits for an unlocked tap there. Android 12+ holds the
 * action itself until the device is unlocked (`ApprovalGate.action`), so this
 * activity usually starts after the unlock and answers immediately.
 *
 * Android-only by capability: iOS answers the same ask inside the app's
 * process, where the device is unlocked already, through
 * `src/glanceable-ios/interaction.ts` and the shared
 * `src/lib/glanceable/approve-ask.ts`.
 */
class ActiveAgentsApprovalActivity : Activity() {
  /** The activity is gone; a callback landing after this must not answer. */
  private var closed = false

  /** One answer per activity: a second start is `KEEP`ed by the work order too. */
  private var answered = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // The activity is translucent and draws nothing, so showing it over the
    // keyguard reveals no content; it only lets the dismissal request come from
    // a visible activity.
    if (Build.VERSION.SDK_INT >= 27) {
      setShowWhenLocked(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
    }
    if (!ApprovalGate.isDeviceLocked(this)) {
      approveAndFinish()
      return
    }
    if (Build.VERSION.SDK_INT < 26) {
      finish()
      return
    }
    keyguard().requestDismissKeyguard(
      this,
      object : KeyguardManager.KeyguardDismissCallback() {
        override fun onDismissSucceeded() = approveAndFinish()

        override fun onDismissCancelled() = finish()

        override fun onDismissError() = finish()
      }
    )
  }

  override fun onDestroy() {
    closed = true
    super.onDestroy()
  }

  private fun approveAndFinish() {
    if (closed || answered || isFinishing) {
      return
    }
    answered = true
    ApprovalGate.enqueue(this, intent)
    finishAndRemoveTask()
  }

  private fun keyguard(): KeyguardManager =
    getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
}
