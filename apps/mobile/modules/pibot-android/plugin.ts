import { AndroidConfig, type ConfigPlugin, withAndroidManifest } from "expo/config-plugins";

const NOTIFICATIONS_SERVICE = "space.pibot.android.PhoneNotifications";
const LINK_SERVICE = "space.pibot.android.RemoteLinkService";
const FILE_PROVIDER = "androidx.core.content.FileProvider";

/**
 * Config plugin of the Android local module. The module's own manifest declares nothing;
 * READ_SMS (the opt-in fallback for phones without Google services) is added here only when
 * `readSms` is true. A Google Play build passes false: Play restricts SMS permissions to default
 * SMS apps, and even an unused declaration needs a policy exception. `expo prebuild` regenerates
 * the native project from this, so nothing is edited by hand.
 * READ_CALL_LOG (also Play-restricted) and the notification listener service share the same
 * sideload-only boundary; without them the phone reports both capabilities unsupported.
 * Amendment (2026-11-11): the remote-control foreground service (type connectedDevice) is
 * declared in every build. Play accepts the type with a Console declaration (a link to the user's
 * own paired computer); its prerequisite CHANGE_WIFI_MULTICAST_STATE is in app.config.ts.
 */
export const withPibotAndroid: ConfigPlugin<{ readSms: boolean }> = (config, { readSms }) =>
  withAndroidManifest(config, (next) => {
    const manifest = next.modResults;
    const permissions = ["android.permission.READ_SMS", "android.permission.READ_CALL_LOG"];
    for (const permission of [
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE",
      "android.permission.WAKE_LOCK",
      "android.permission.REQUEST_INSTALL_PACKAGES",
    ])
      AndroidConfig.Permissions.addPermission(manifest, permission);
    if (readSms)
      for (const permission of permissions)
        AndroidConfig.Permissions.addPermission(manifest, permission);
    else AndroidConfig.Permissions.removePermissions(manifest, permissions);
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    const services = (app.service ?? []).filter(
      (service) =>
        service.$["android:name"] !== NOTIFICATIONS_SERVICE &&
        service.$["android:name"] !== LINK_SERVICE,
    );
    services.push({
      $: {
        "android:name": LINK_SERVICE,
        "android:exported": "false",
        "android:foregroundServiceType": "connectedDevice",
        "android:stopWithTask": "true",
      },
    } as (typeof services)[number]);
    // BIND_NOTIFICATION_LISTENER_SERVICE guards the binding (only the system holds it); it is not a
    // permission the app requests. Access is granted by the owner in system Settings.
    if (readSms)
      services.push({
        $: {
          "android:name": NOTIFICATIONS_SERVICE,
          "android:permission": "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE",
          "android:exported": "true",
        },
        "intent-filter": [
          {
            action: [
              { $: { "android:name": "android.service.notification.NotificationListenerService" } },
            ],
          },
        ],
      });
    app.service = services;
    const application = app as typeof app & {
      provider?: Array<Record<string, unknown>>;
    };
    application.provider = (application.provider ?? []).filter((provider) => {
      const attributes = provider.$ as Record<string, string> | undefined;
      return attributes?.["android:name"] !== FILE_PROVIDER;
    });
    application.provider.push({
      $: {
        "android:name": FILE_PROVIDER,
        "android:authorities": `\${applicationId}.pibot.files`,
        "android:exported": "false",
        "android:grantUriPermissions": "true",
      },
      "meta-data": [
        {
          $: {
            "android:name": "android.support.FILE_PROVIDER_PATHS",
            "android:resource": "@xml/pibot_file_paths",
          },
        },
      ],
    });
    return next;
  });
