/** Composes the app runtime and the root navigation stack. */

import { Stack, useRootNavigationState, useRouter } from "expo-router";
import { ShareIntentProvider } from "expo-share-intent";
import { useEffect } from "react";
import { StatusBar } from "react-native";
import { ApprovalsProvider } from "../src/features/approvals/approvals-context.tsx";
import { ConversationsProvider } from "../src/features/conversations/conversations-context.tsx";
import { RecordsProvider } from "../src/features/records/records-context.tsx";
import { ShareIntentGate } from "../src/features/share/ShareIntentGate.tsx";
import { BackgroundSync } from "../src/features/sync/BackgroundSync.tsx";
import { TasksProvider } from "../src/features/tasks/tasks-context.tsx";
import { TodosProvider } from "../src/features/todos/todos-context.tsx";
import { AndroidUpdateProvider } from "../src/features/updates/AndroidUpdateProvider.tsx";
import { OfflineProvider } from "../src/offline/OfflineProvider.tsx";
import { NotificationsProvider } from "../src/push/NotificationsProvider.tsx";
import { MobileProvider, useMobileSelector } from "../src/runtime/context.tsx";
import { DisplayProvider, useDisplay } from "../src/theme/display.tsx";
import { useColors } from "../src/theme/use-theme.ts";
import { LinkSheetProvider } from "../src/ui/link-sheet.tsx";
import { ToastProvider } from "../src/ui/toast.tsx";

function Routes() {
  const colors = useColors(),
    { scheme } = useDisplay(),
    mobile = useMobileSelector((s) => ({ ready: s.ready, devices: s.devices })),
    router = useRouter(),
    navigation = useRootNavigationState();
  // After unpairing the last computer, go back to pairing, once the navigator can navigate.
  // The pages under it go first: a replace alone kept the tabs below, so Android back took an
  // unpaired phone to tabs with no way to pair, while the iOS swipe on pairing is off for it.
  useEffect(() => {
    if (!navigation?.key || !mobile.ready || mobile.devices.length) return;
    if (router.canDismiss()) router.dismissAll();
    router.replace("/pair");
  }, [navigation?.key, mobile.ready, mobile.devices.length, router]);
  return (
    <>
      <BackgroundSync />
      <ShareIntentGate />
      <StatusBar barStyle={scheme === "dark" ? "light-content" : "dark-content"} />
      {/* Every page draws its own bar (NavBar); the iOS edge swipe stays on regardless, since
          react-native-screens owns that gesture and lets it win over horizontal scrollers. */}
      <Stack
        screenOptions={{
          headerShown: false,
          gestureEnabled: true,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="pair" options={{ gestureEnabled: mobile.devices.length > 0 }} />
        <Stack.Screen name="conversation/[kind]/[id]" />
        <Stack.Screen name="approval/[id]" />
        <Stack.Screen name="file" />
        <Stack.Screen name="changes/[runId]" />
        <Stack.Screen name="diff" />
        <Stack.Screen name="task/[kind]/[id]" />
        <Stack.Screen name="browser/[botId]" />
        <Stack.Screen name="phone-data" />
        <Stack.Screen name="offline" />
        <Stack.Screen name="endpoint-capabilities" />
        <Stack.Screen name="share" />
        <Stack.Screen name="records" />
        <Stack.Screen name="record" />
        <Stack.Screen name="run-log" />
      </Stack>
    </>
  );
}
export default function Layout() {
  return (
    // Language and appearance wrap everything, the runtime's loading screen included.
    // Share intent before the other providers, as expo-share-intent requires; a switch
    // to another app keeps the pending share until it is sent or cancelled.
    <DisplayProvider>
      <ShareIntentProvider options={{ resetOnBackground: false }}>
        <MobileProvider>
          <OfflineProvider>
            <ToastProvider>
              <LinkSheetProvider>
                <ApprovalsProvider>
                  <ConversationsProvider>
                    <TasksProvider>
                      <TodosProvider>
                        <RecordsProvider>
                          <NotificationsProvider>
                            <AndroidUpdateProvider>
                              <Routes />
                            </AndroidUpdateProvider>
                          </NotificationsProvider>
                        </RecordsProvider>
                      </TodosProvider>
                    </TasksProvider>
                  </ConversationsProvider>
                </ApprovalsProvider>
              </LinkSheetProvider>
            </ToastProvider>
          </OfflineProvider>
        </MobileProvider>
      </ShareIntentProvider>
    </DisplayProvider>
  );
}
