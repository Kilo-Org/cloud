package com.kilocode.activeagentsliveupdate

import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import java.util.UUID

/** One OS-owned widget deadline; an old delivery never changes a newer snapshot. */
class ActiveAgentsDeadlineReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> restoreWidgetDeadline(context)
      else -> expire(context, intent)
    }
  }

  companion object {
    private const val STORE = "active-agents-deadlines"
    private const val SNAPSHOT = "widget-snapshot"
    private const val WIDGET = "widget-expiry"
    private const val NOTIFICATION = "notification-expiry"
    private const val GENERATION = "generation"
    private const val DEADLINE = "deadline"
    internal const val NOTIFICATION_ID = 1001

    @Synchronized
    fun setWidgetSnapshot(context: Context, snapshot: String, expiresAt: Long) {
      replace(context, WIDGET, expiresAt, snapshot)
    }

    fun getWidgetSnapshot(context: Context): String? =
      context.getSharedPreferences(STORE, Context.MODE_PRIVATE).getString(SNAPSHOT, null)

    /** Notification.Builder.setTimeoutAfter is unavailable on supported API 24–25. */
    @Synchronized
    fun setLegacyNotificationTimeout(context: Context, timeoutMs: Long) {
      val deadline = if (timeoutMs > 0) System.currentTimeMillis() + timeoutMs else 0
      replace(context, NOTIFICATION, deadline)
    }

    private fun replace(context: Context, action: String, deadline: Long, snapshot: String? = null) {
      val generation = UUID.randomUUID().toString()
      val preferences = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
      val editor = preferences.edit()
        .putLong(action, deadline)
        .putString("$action-$GENERATION", generation)
      if (snapshot != null) editor.putString(SNAPSHOT, snapshot)
      // Commit before returning across the bridge so process exit cannot lose a blank.
      check(editor.commit()) { "Cannot persist the active agents deadline" }

      val intent = Intent(context, ActiveAgentsDeadlineReceiver::class.java)
        .setAction(action)
        .putExtra(DEADLINE, deadline)
        .putExtra(GENERATION, generation)
      val operation = PendingIntent.getBroadcast(
        context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      alarms.cancel(operation)
      if (deadline <= System.currentTimeMillis()) {
        operation.cancel()
        return
      }
      if (Build.VERSION.SDK_INT >= 31) {
        // No exact-alarm permission: Android can defer delivery while idle.
        alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, deadline, operation)
      } else {
        alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, deadline, operation)
      }
    }

    @Synchronized
    private fun restoreWidgetDeadline(context: Context) {
      val preferences = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
      val deadline = preferences.getLong(WIDGET, 0)
      // Privacy and signed-out snapshots persist a zero deadline in the same commit.
      if (deadline <= 0) return
      // Keep the original expiry and snapshot; replace only the alarm generation.
      replace(context, WIDGET, deadline)
      // Also handle an expiry that passed while down or during alarm restoration.
      expire(context, Intent(WIDGET)
        .putExtra(DEADLINE, deadline)
        .putExtra(GENERATION, preferences.getString("$WIDGET-$GENERATION", null)))
    }

    @Synchronized
    private fun expire(context: Context, intent: Intent) {
      val action = intent.action ?: return
      if (action != WIDGET && action != NOTIFICATION) return
      val preferences = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
      val deadline = preferences.getLong(action, 0)
      if (deadline <= 0 || deadline > System.currentTimeMillis() ||
        deadline != intent.getLongExtra(DEADLINE, 0) ||
        preferences.getString("$action-$GENERATION", null) != intent.getStringExtra(GENERATION)
      ) return

      check(preferences.edit().remove(action).remove("$action-$GENERATION").commit()) {
        "Cannot consume the active agents deadline"
      }
      if (action == NOTIFICATION) {
        val notifications = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notifications.cancel(NOTIFICATION_ID)
        return
      }

      // The installed widget provider starts its durable headless worker for each instance.
      // That handler re-reads the stored snapshot, including any intervening privacy blank.
      val provider = ComponentName(context.packageName, "${context.packageName}.widget.ActiveAgentsWidget")
      val ids = AppWidgetManager.getInstance(context).getAppWidgetIds(provider)
      if (ids.isEmpty()) return
      context.sendBroadcast(
        Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
          .setComponent(provider)
          .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
      )
    }
  }
}
