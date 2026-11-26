import { useState } from "react";
import { Text, View } from "react-native";
import { useRuntime, useSharedText, useText } from "../../../runtime/context.tsx";
import { useColors } from "../../../theme/use-theme.ts";
import { Button, Segmented, Separator, StateTag, Switch } from "../../../ui/controls.tsx";
import { IconButton } from "../../../ui/headers.tsx";
import { OptionRow } from "../../../ui/sheet.tsx";
import { useToast } from "../../../ui/toast.tsx";
import { useRemoteValue } from "../../chat/controls/use-remote-value.ts";
import { readSkill } from "../calls.ts";
import { Group, Note, SettingsPage } from "../fields.tsx";
import type { BotSettingsState } from "../use-bot-settings.ts";

type Props = { state: BotSettingsState };

/** Delete needs a second tap: the trash mark arms it, the red pill confirms. */
export function RemoveButton({ disabled, onRemove }: { disabled: boolean; onRemove: () => void }) {
  const t = useText(),
    colors = useColors();
  const [armed, setArmed] = useState(false);
  if (!armed)
    return (
      <IconButton
        icon="trash"
        size={18}
        color={colors.danger}
        label={t("remove")}
        disabled={disabled}
        onPress={() => setArmed(true)}
      />
    );
  return (
    <Button
      variant="danger"
      title={t("confirmRemove")}
      disabled={disabled}
      onPress={() => {
        setArmed(false);
        onRemove();
      }}
    />
  );
}
export function MemoryPage({ state }: Props) {
  const t = useText(),
    shared = useSharedText(),
    colors = useColors();
  const bot = state.bot;
  const memories = state.data?.profile.memories ?? [];
  const mode = bot?.memoryMode ?? "auto";
  const dream = state.data?.dream;
  return (
    <SettingsPage title={t("memory")} state={state}>
      {bot && (
        <>
          {dream && !!(dream.merged || dream.retired || dream.proposed) && (
            <Group title={shared("memorySettings.dream.title")}>
              <Note
                text={shared("memorySettings.dream.summary", {
                  merged: dream.merged,
                  retired: dream.retired,
                  proposed: dream.proposed,
                })}
              />
            </Group>
          )}
          <Group title={t("memoryMode")}>
            <View style={{ paddingVertical: 10, paddingHorizontal: 16, gap: 10 }}>
              <Text style={{ fontSize: 12.5, lineHeight: 18, color: colors.text2 }}>
                {t(mode === "auto" ? "memoryAutoHint" : "memoryAskHint")}
              </Text>
              <Segmented
                options={[
                  { value: "auto" as const, label: t("memoryAuto") },
                  { value: "ask" as const, label: t("memoryAsk") },
                ]}
                value={mode}
                disabled={!state.editable}
                onChange={(value) => void state.update({ memoryMode: value })}
              />
            </View>
          </Group>
          <Group title={t("memory")}>
            {memories.length ? (
              memories.map((memory, index) => (
                <View key={memory.id}>
                  {index > 0 && <Separator />}
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                      minHeight: 56,
                      paddingVertical: 6,
                      paddingLeft: 16,
                      paddingRight: 6,
                    }}
                  >
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <Text style={{ fontSize: 15, lineHeight: 21, color: colors.text }}>
                        {memory.text}
                      </Text>
                      {memory.category && (
                        <Text style={{ fontSize: 12, color: colors.text2 }}>
                          {shared(`workspace.category.${memory.category}`)}
                        </Text>
                      )}
                    </View>
                    <RemoveButton
                      disabled={!state.editable}
                      onRemove={() => void state.removeMemory(memory.id)}
                    />
                  </View>
                </View>
              ))
            ) : (
              <Note text={t("noMemories")} />
            )}
          </Group>
        </>
      )}
    </SettingsPage>
  );
}
export function SkillsPage({ state, open }: Props & { open: (skillId: string) => void }) {
  const t = useText();
  const skills = state.data?.skills;
  return (
    <SettingsPage title={t("skills")} state={state} footer={t("skillsNote")}>
      {state.data && (
        <Group>
          {!skills ? (
            <Note text={t("sectionUnavailable")} />
          ) : skills.length ? (
            skills.map((skill, index) => (
              <View key={skill.id}>
                {index > 0 && <Separator />}
                <OptionRow
                  strong
                  title={skill.name}
                  subtitle={skill.description}
                  onPress={() => open(skill.id)}
                  right={
                    <Switch
                      label={skill.name}
                      value={skill.enabled}
                      disabled={!state.editable}
                      onValueChange={(enabled) => void state.setSkill(skill.id, enabled)}
                    />
                  }
                />
              </View>
            ))
          ) : (
            <Note text={t("noSkills")} />
          )}
        </Group>
      )}
    </SettingsPage>
  );
}
/** One skill, read-only: editing the body stays on the computer. */
export function SkillPage({ state, skillId }: Props & { skillId?: string }) {
  const t = useText(),
    colors = useColors(),
    runtime = useRuntime();
  const detail = useRemoteValue(
    skillId ? `skill:${skillId}` : undefined,
    (signal) => readSkill(runtime, skillId as string, signal),
    ["skills.changed"],
  );
  const skill = state.data?.skills?.find((item) => item.id === skillId);
  return (
    <SettingsPage title={skill?.name ?? t("skills")} state={state} footer={t("skillsNote")}>
      {skill && (
        <Group>
          <OptionRow
            strong
            title={skill.name}
            subtitle={skill.description}
            right={
              <Switch
                label={skill.name}
                value={skill.enabled}
                disabled={!state.editable}
                onValueChange={(enabled) => void state.setSkill(skill.id, enabled)}
              />
            }
          />
          {detail.value && (
            <>
              <Separator />
              <Text
                selectable
                style={{ padding: 16, fontSize: 14, lineHeight: 21, color: colors.text }}
              >
                {detail.value.document.body}
              </Text>
            </>
          )}
        </Group>
      )}
    </SettingsPage>
  );
}
export function RoutinesPage({ state }: Props) {
  const t = useText(),
    toast = useToast();
  const routines = state.data?.routines;
  return (
    <SettingsPage title={t("routines")} state={state} footer={t("routinesNote")}>
      {state.data && (
        <Group>
          {!routines ? (
            <Note text={t("sectionUnavailable")} />
          ) : routines.length ? (
            routines.map((routine, index) => (
              <View key={routine.id}>
                {index > 0 && <Separator />}
                <OptionRow
                  strong
                  title={routine.name}
                  subtitle={routine.instructions.replace(/\s+/g, " ").slice(0, 120)}
                  right={
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      {routine.pausedReason && (
                        <StateTag kind="paused" label={t("routinePaused")} />
                      )}
                      <Button
                        size="small"
                        title={t("runNow")}
                        disabled={!state.editable}
                        onPress={() =>
                          void state.runRoutine(routine.id).then((run) => {
                            if (run) toast(t("ranNow"));
                          })
                        }
                      />
                      <Switch
                        label={routine.name}
                        value={routine.enabled}
                        disabled={!state.editable}
                        onValueChange={(enabled) => void state.setRoutine(routine.id, enabled)}
                      />
                    </View>
                  }
                />
              </View>
            ))
          ) : (
            <Note text={t("noRoutines")} />
          )}
        </Group>
      )}
    </SettingsPage>
  );
}
