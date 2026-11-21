package com.kilocode.activeagentsliveupdate

import android.app.AlarmManager
import android.app.PendingIntent
import android.os.Build

/**
 * The one home of the API 31 alarm-arming fork.
 */
internal fun alarmWhileIdle(alarms: AlarmManager, triggerAt: Long, operation: PendingIntent) {
  if (Build.VERSION.SDK_INT >= 31) {
    // No exact-alarm permission: Android can defer delivery while idle.
    alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, operation)
  } else {
    alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, operation)
  }
}
