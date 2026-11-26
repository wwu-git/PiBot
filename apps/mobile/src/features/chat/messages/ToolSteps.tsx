import { toolGroupSummary, toolNameKey, toolSummaryLabel, toolTarget } from "@pibot/client-core";
import type { Message } from "@pibot/protocol";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useSharedText, useText } from "../../../runtime/context.tsx";
import { mono, type } from "../../../theme/scale.ts";
import { useColors } from "../../../theme/use-theme.ts";
import { Icon } from "../../../ui/icons.tsx";

type Tool = NonNullable<Message["tools"]>[number];
function Step({ tool }: { tool: Tool }) {
  const colors = useColors(),
    t = useText(),
    shared = useSharedText();
  const summaryLabel = toolSummaryLabel(tool);
  const target = summaryLabel ? undefined : toolTarget(tool.tool, tool.summary);
  const running = tool.status === "pending" || tool.status === "running";
  const done = tool.status === "done";
  return (
    <View
      style={[
        { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 30, paddingVertical: 2 },
        // The step in progress gets the desktop's 2pt blue line on its left.
        running
          ? { borderLeftWidth: 2, borderLeftColor: colors.accent, paddingLeft: 8, marginLeft: 6 }
          : { paddingHorizontal: 4 },
      ]}
    >
      {running ? (
        <ActivityIndicator size="small" color={colors.accent} style={{ width: 14, height: 14 }} />
      ) : (
        <Icon
          name={done ? "check" : "close"}
          color={done ? colors.ok : colors.danger}
          size={14}
          strokeWidth={2}
        />
      )}
      <Text style={[type.tool, { flex: 1, minWidth: 0, color: colors.text }]}>
        {summaryLabel ?? shared(toolNameKey(tool.tool))}
        {!!target && <Text style={mono(12.5)}> {target}</Text>}
      </Text>
      {running && (
        <Text style={[type.small, { color: colors.text2, flexShrink: 0 }]}>{t("liveNow")}</Text>
      )}
    </View>
  );
}
/**
 * Tool activity of a reply as flat rows, never a bubble (desktop tool group): one summary line
 * that folds the finished steps; a step in progress stays visible while folded.
 */
export function ToolSteps({ tools }: { tools: NonNullable<Message["tools"]> }) {
  const colors = useColors(),
    shared = useSharedText();
  const [open, setOpen] = useState(false);
  const summary = toolGroupSummary(tools, shared);
  const running = tools.filter((tool) => tool.status === "pending" || tool.status === "running");
  const finished = tools.filter((tool) => !running.includes(tool));
  return (
    <View style={{ alignSelf: "stretch" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: 36,
          padding: 6,
          borderRadius: 6,
          backgroundColor: pressed ? colors.hover : "transparent",
        })}
      >
        <Icon name="audit" color={colors.text2} size={16} />
        <Text style={[type.tool, { color: colors.text2, flexShrink: 1 }]}>{summary}</Text>
        <Icon name={open ? "chevron" : "chevronRight"} color={colors.text2} size={15} />
      </Pressable>
      {open && finished.length > 0 && (
        <View
          style={{
            marginVertical: 2,
            marginLeft: 6,
            paddingVertical: 2,
            paddingLeft: 12,
            borderLeftWidth: 2,
            borderLeftColor: colors.b1,
            gap: 2,
          }}
        >
          {finished.map((tool) => (
            <Step key={tool.toolCallId} tool={tool} />
          ))}
        </View>
      )}
      {running.map((tool) => (
        <Step key={tool.toolCallId} tool={tool} />
      ))}
    </View>
  );
}
