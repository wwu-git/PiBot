import { ProfileBrowser } from "@pibot/browser/ui";
import type { ChatPeer } from "@pibot/client-core";
import { ProfileComputer } from "@pibot/computer-use/ui";
import type { Bot } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { useWorkplaces } from "../../chat/topics/useWorkplaces.ts";
import { SandboxRemembered } from "../../settings/permissions/sandbox-remembered.tsx";
import { usePermissions } from "../../settings/permissions/use-permissions.ts";
import { PermissionActivity, PermissionsContent } from "./PermissionsContent.tsx";
import { ProfileConnections } from "./ProfileConnections.tsx";
import { ProfileGrants } from "./ProfileGrants.tsx";

export function ProfilePermissions({ bot }: { bot: Bot }) {
  const t = useT();
  const state = usePermissions(bot.id);
  const { peer } = useRpc();
  const image = bot.category === "image";
  return (
    <PermissionsContent
      state={state}
      description={image ? t("panel.imageOnly", { name: bot.name }) : t("panel.permissionsNote")}
      imageOnly={image}
      piManager={bot.isMain}
      computer={<ProfileComputer key={bot.id} botId={bot.id} permissions={state} />}
      grants={
        <>
          {!image && <ProfileConnections botId={bot.id} />}
          {!image && peer && (
            <BotSandboxPermissions
              peer={peer}
              botId={bot.id}
              disabled={state.busy || !state.connected}
            />
          )}
          <ProfileGrants botId={bot.id} />
        </>
      }
      browser={<ProfileBrowser key={bot.id} bot={bot} />}
      activity={<PermissionActivity botId={bot.id} />}
    />
  );
}

function BotSandboxPermissions({
  peer,
  botId,
  disabled,
}: {
  peer: ChatPeer;
  botId: string;
  disabled: boolean;
}) {
  const workplaces = useWorkplaces(peer, botId);
  const t = useT();
  if (!workplaces.data)
    return (
      <p role={workplaces.error ? "alert" : "status"}>
        {t(workplaces.error ? "permissions.error" : "common.loading")}
      </p>
    );
  return (
    <SandboxRemembered
      disabled={disabled}
      folders={
        workplaces.data ? [workplaces.data.home, ...workplaces.data.folders.map((f) => f.path)] : []
      }
    />
  );
}
