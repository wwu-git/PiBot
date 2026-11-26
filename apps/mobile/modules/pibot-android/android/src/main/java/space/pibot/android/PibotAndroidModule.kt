package space.pibot.android

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import java.io.FileInputStream
import java.security.MessageDigest
import androidx.core.content.FileProvider
import androidx.core.content.ContextCompat
import androidx.core.os.BundleCompat
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailabilityLight
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Narrowed 2026-10-22: SMS verification codes for the computer's Bots.
 *
 * - SMS User Consent API: started per request; when a matching SMS arrives the system shows a
 *   one-message consent sheet and only that message is handed over. No SMS permission.
 * - Optional fallback (READ_SMS, declared only when the config plugin enables it, granted only
 *   when the owner turns the switch on): the inbox of the last 10 minutes at most.
 *
 * Only the extracted code (and the sender's last four digits when known) reaches JavaScript.
 * Message text is never stored, logged or returned. Error codes match the phone-data contract.
 */
class PibotAndroidModule : Module() {
  private class Wait(
    val promise: Promise,
    val hint: String?,
    val receiver: BroadcastReceiver,
    val timeout: Runnable,
  ) {
    var consent: Intent? = null
  }

  private val main = Handler(Looper.getMainLooper())
  private var wait: Wait? = null

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("phone_offline")

  override fun definition() = ModuleDefinition {
    Name("PibotAndroid")
    Events("linkTick")
    AsyncFunction("sha256File") { uri: String ->
      val path = Uri.parse(uri).path ?: throw IllegalArgumentException("update_file_invalid")
      val digest = MessageDigest.getInstance("SHA-256")
      FileInputStream(java.io.File(path)).use { input ->
        val buffer = ByteArray(1024 * 1024)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          digest.update(buffer, 0, count)
        }
      }
      digest.digest().joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }.runOnQueue(Queues.DEFAULT)
    AsyncFunction("installApk") { uri: String ->
      val ctx = context
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ctx.packageManager.canRequestPackageInstalls()) {
        "unknown_sources"
      } else {
        val source = Uri.parse(uri)
        val path = source.path ?: throw IllegalArgumentException("update_file_invalid")
        val content = FileProvider.getUriForFile(ctx, "${ctx.packageName}.pibot.files", java.io.File(path))
        val intent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(content, "application/vnd.android.package-archive")
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        ctx.startActivity(intent)
        "started"
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("openInstallSettings") {
      val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }.runOnQueue(Queues.MAIN)
    OnCreate { RemoteLinkService.onTick = { sendEvent("linkTick", emptyMap<String, Any>()) } }
    AsyncFunction("readPagePermission") { kind: String -> PhoneReadPages.permission(context, kind) }
    AsyncFunction("beginPhonePage") { PhoneReadPages.begin() }
    AsyncFunction("cancelPhonePage") { id: String -> PhoneReadPages.cancel(id) }.runOnQueue(Queues.MAIN)
    AsyncFunction("readPhonePage") { requestId: String, kind: String, beforeTime: Double, beforeId: String, limit: Int ->
      PhoneReadPages.read(context, requestId, kind, beforeTime.toLong(), beforeId, limit)
    }
    AsyncFunction("requestCallHistory") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(appContext.permissions, promise, Manifest.permission.READ_CALL_LOG)
    }
    AsyncFunction("openNotificationAccess") {
      context.startActivity(Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }.runOnQueue(Queues.MAIN)

    // Remote-control link (added 2026-11-11): see RemoteLinkService.
    AsyncFunction("startLinkService") { title: String, body: String, channel: String ->
      try {
        ContextCompat.startForegroundService(context, RemoteLinkService.intent(context, title, body, channel))
        true
      } catch (_: RuntimeException) {
        // Android 12+ refuses a start from the background; the caller keeps the background grace.
        false
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("updateLinkService") { title: String, body: String, channel: String ->
      RemoteLinkService.update(context, title, body, channel)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("stopLinkService") {
      context.stopService(Intent(context, RemoteLinkService::class.java))
      Unit
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("googleServicesAvailable") {
      GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
    }
    AsyncFunction("linkServiceRunning") { RemoteLinkService.running }
    // Any VPN network, also one that is not the default (a Clash-style TUN under Wi-Fi): expo-network
    // reports such a phone as plain Wi-Fi, so the LAN direct failure got no VPN hint.
    AsyncFunction("vpnActive") {
      val cm = context.getSystemService(ConnectivityManager::class.java)
      @Suppress("DEPRECATION")
      cm?.allNetworks?.any {
        cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
      } == true
    }
    // "Restricted" battery (background restriction) freezes the app as soon as it leaves the
    // screen; "optimized" lets Doze and vendor sleep lists cut it later.
    AsyncFunction("backgroundLimits") {
      val ctx = context
      val restricted =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
          ctx.getSystemService(ActivityManager::class.java)?.isBackgroundRestricted == true
      val optimized =
        ctx.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(ctx.packageName) == false
      mapOf("restricted" to restricted, "optimized" to optimized)
    }
    // App details, where the battery choice lives (Unrestricted / Optimized / Restricted). Not
    // ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS: it needs a permission Google Play restricts.
    AsyncFunction("openBatterySettings") {
      val ctx = context
      val details =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null))
      val list = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
      val activity = appContext.currentActivity
      val open = { target: Intent ->
        if (activity != null) activity.startActivity(target)
        else ctx.startActivity(target.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
      // resolveActivity is subject to package visibility; just try the details page first.
      try {
        open(details)
      } catch (_: android.content.ActivityNotFoundException) {
        open(list)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("smsCapabilities") {
      val ctx = context
      val consent =
        GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(ctx) ==
          ConnectionResult.SUCCESS
      val readSms =
        when {
          !declaresReadSms(ctx) -> "undeclared"
          ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_SMS) ==
            PackageManager.PERMISSION_GRANTED -> "granted"
          else -> "denied"
        }
      mapOf("consent" to consent, "readSms" to readSms)
    }

    // Shows the system permission prompt; resolves with Expo's permission response.
    AsyncFunction("requestReadSms") { promise: Promise ->
      if (!declaresReadSms(context)) {
        promise.reject("unsupported_platform", "unsupported_platform", null)
        return@AsyncFunction
      }
      Permissions.askForPermissionsWithPermissionsManager(
        appContext.permissions,
        promise,
        Manifest.permission.READ_SMS,
      )
    }

    AsyncFunction("waitForConsentCode") { senderHint: String?, waitMs: Int, promise: Promise ->
      if (wait != null) {
        promise.reject("phone_busy", "phone_busy", null)
        return@AsyncFunction
      }
      startConsent(senderHint, waitMs.coerceIn(5_000, 300_000).toLong(), promise)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("cancelConsentCode") { finish(null, "phone_sms_timeout") }.runOnQueue(Queues.MAIN)

    // Fallback scan: newest code since `sinceMs` (the JS side never asks beyond 10 minutes).
    AsyncFunction("readRecentCode") { senderHint: String?, sinceMs: Double ->
      readRecent(senderHint, maxOf(sinceMs.toLong(), System.currentTimeMillis() - 10 * 60_000L))
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != CONSENT_REQUEST) return@OnActivityResult
      val current = wait ?: return@OnActivityResult
      if (payload.resultCode != Activity.RESULT_OK) {
        finish(null, "phone_consent_denied")
        return@OnActivityResult
      }
      val code = SmsCodes.extract(payload.data?.getStringExtra(SmsRetriever.EXTRA_SMS_MESSAGE))
      if (code == null) {
        // The allowed message held no code (another SMS from the same sender): listen again.
        current.consent = null
        SmsRetriever.getClient(context).startSmsUserConsent(SmsCodes.phoneHint(current.hint))
        return@OnActivityResult
      }
      finish(
        mapOf(
          "code" to code,
          "senderLast4" to SmsCodes.last4(SmsCodes.phoneHint(current.hint)),
        ),
        null,
      )
    }

    // The consent sheet could not open while the app was in the background: open it on return.
    OnActivityEntersForeground { main.post { wait?.consent?.let { launch(it) } } }

    OnDestroy {
      RemoteLinkService.onTick = null
      PhoneReadPages.dispose()
      main.post { finish(null, "phone_offline") }
      // The JS link that the service kept alive is gone with this context.
      appContext.reactContext?.let { it.stopService(Intent(it, RemoteLinkService::class.java)) }
    }
  }

  private fun declaresReadSms(ctx: Context): Boolean =
    appContext.permissions?.isPermissionPresentInManifest(Manifest.permission.READ_SMS)
      ?: false

  private fun startConsent(hint: String?, waitMs: Long, promise: Promise) {
    val ctx = context
    val receiver =
      object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
          if (intent.action != SmsRetriever.SMS_RETRIEVED_ACTION) return
          val extras = intent.extras ?: return
          val status = BundleCompat.getParcelable(extras, SmsRetriever.EXTRA_STATUS, Status::class.java)
          when (status?.statusCode) {
            CommonStatusCodes.SUCCESS -> {
              val consent =
                BundleCompat.getParcelable(extras, SmsRetriever.EXTRA_CONSENT_INTENT, Intent::class.java)
                  ?: return
              // Intent redirection guard: only Google Play services' own sheet, no URI grants.
              val target = consent.resolveActivity(c.packageManager)
              val grants = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
              if (target?.packageName != "com.google.android.gms" || (consent.flags and grants) != 0) return
              wait?.consent = consent
              launch(consent)
            }
            CommonStatusCodes.TIMEOUT -> finish(null, "phone_sms_timeout")
          }
        }
      }
    val timeout = Runnable { finish(null, "phone_sms_timeout") }
    wait = Wait(promise, hint, receiver, timeout)
    ContextCompat.registerReceiver(
      ctx,
      receiver,
      IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION),
      SmsRetriever.SEND_PERMISSION,
      null,
      ContextCompat.RECEIVER_EXPORTED,
    )
    main.postDelayed(timeout, waitMs)
    SmsRetriever.getClient(ctx)
      .startSmsUserConsent(SmsCodes.phoneHint(hint))
      .addOnFailureListener { main.post { finish(null, "unsupported_platform") } }
  }

  private fun launch(consent: Intent) {
    val activity = appContext.currentActivity ?: return
    try {
      activity.startActivityForResult(consent, CONSENT_REQUEST)
      wait?.consent = null
    } catch (_: Exception) {
      // Kept in `wait.consent`; OnActivityEntersForeground tries again.
    }
  }

  /** Settles the current wait exactly once and releases its receiver and timer. */
  private fun finish(result: Map<String, Any?>?, error: String?) {
    val current = wait ?: return
    wait = null
    main.removeCallbacks(current.timeout)
    try {
      context.unregisterReceiver(current.receiver)
    } catch (_: Exception) {
      // Already unregistered with the context being torn down; nothing else holds it.
    }
    if (result != null) current.promise.resolve(result)
    else current.promise.reject(error ?: "phone_failed", error ?: "phone_failed", null)
  }

  private fun readRecent(hint: String?, since: Long): Map<String, Any?>? {
    val ctx = context
    if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_SMS) !=
      PackageManager.PERMISSION_GRANTED
    ) throw IllegalStateException("phone_permission_denied")
    ctx.contentResolver
      .query(
        Uri.parse("content://sms/inbox"),
        arrayOf("address", "body", "date"),
        "date >= ?",
        arrayOf(since.toString()),
        "date DESC",
      )
      ?.use { cursor ->
        var seen = 0
        while (cursor.moveToNext() && seen++ < 30) {
          val address = cursor.getString(0)
          val body = cursor.getString(1) ?: continue
          if (!SmsCodes.matches(hint, address, body)) continue
          val code = SmsCodes.extract(body) ?: continue
          return mapOf("code" to code, "senderLast4" to SmsCodes.last4(address))
        }
      }
    return null
  }

  private companion object {
    const val CONSENT_REQUEST = 0x5d1c
  }
}
