// Entries for the existing shared contract matrix; no independent test cases are defined here.

import type {
  AcpGroupMethods,
  DeliveryEvidenceMethods,
  ExecutionCollectionMethods,
  GroupExecutionMethods,
  GroupPlanMethods,
  ReviewExecutionMethods,
} from "@pibot/protocol-base";
import { DEFAULT_EXECUTION_LIMITS } from "@pibot/protocol-base";
import type { MethodParams, MethodResults } from "../../src/aggregate/api.ts";
import type { FileCheckpointMethods, ManagedWorktreeMethods } from "../../src/index.ts";

const id = "00000000-0000-4000-8000-000000000001";
const at = "2026-10-16T00:00:00.000Z";
type Names =
  | keyof typeof AcpGroupMethods
  | keyof typeof GroupPlanMethods
  | keyof typeof GroupExecutionMethods
  | keyof typeof ExecutionCollectionMethods
  | keyof typeof ManagedWorktreeMethods
  | keyof typeof FileCheckpointMethods
  | keyof typeof ReviewExecutionMethods
  | keyof typeof DeliveryEvidenceMethods;
type Case<K extends keyof MethodParams> = {
  params: MethodParams[K];
  result: MethodResults[K];
  badParams: unknown;
  badResult: unknown;
};

const acpGroup = { id, name: "fixture", coordinatorBotId: id, memberBotIds: [id] };
const acpReceipt = {
  groupId: id,
  topicId: id,
  runId: id,
  assistantMessageId: id,
  cycleId: id,
  budgetRootRunId: id,
  runIds: [id],
};
const acpSnapshot = {
  ...acpReceipt,
  state: "completed" as const,
  activeRunIds: [],
  conversationIds: [id],
  taskIds: [],
  workflowRunIds: [],
  complete: true,
  terminal: true,
  drained: true,
  runs: [],
};
export const groupMethodCases = {
  "groups.acp.list": {
    params: {},
    result: [acpGroup],
    badParams: { extra: true },
    badResult: [{}],
  },
  "groups.acp.get": { params: { groupId: id }, result: acpGroup, badParams: {}, badResult: {} },
  "groups.acp.topics.create": {
    params: { groupId: id, selection: { primary: id, readonly: [] } },
    result: { topicId: id },
    badParams: { groupId: id },
    badResult: {},
  },
  "groups.acp.topics.attach": {
    params: { groupId: id, topicId: id, cwd: "/fixture" },
    result: { topicId: id },
    badParams: { groupId: id, topicId: id },
    badResult: {},
  },
  "groups.acp.topics.rebind": {
    params: { groupId: id, topicId: id, selection: { primary: id, readonly: [] } },
    result: null,
    badParams: { groupId: id },
    badResult: {},
  },
  "groups.acp.topics.archive": {
    params: { groupId: id, topicId: id },
    result: null,
    badParams: { groupId: id },
    badResult: {},
  },
  "groups.acp.send": {
    params: { groupId: id, topicId: id, text: "fixture" },
    result: acpReceipt,
    badParams: { groupId: id },
    badResult: {},
  },
  "groups.acp.snapshot": {
    params: acpReceipt,
    result: acpSnapshot,
    badParams: { groupId: id },
    badResult: {},
  },
  "groups.acp.cancel": {
    params: acpReceipt,
    result: acpSnapshot,
    badParams: { groupId: id },
    badResult: {},
  },
  "groups.plan.resolve": {
    params: { groupId: id, messageId: id, decision: "start" },
    result: {
      schemaVersion: 1,
      id,
      groupId: id,
      originRunId: id,
      cycleId: id,
      budgetRootRunId: id,
      status: "pending",
      confirmedByUser: false,
      budgetUsd: 1,
      owners: [{ stepId: "report", botId: id }],
      plan: {
        name: "报告",
        estimatedCostUsd: 0.6,
        steps: [
          {
            id: "report",
            title: "整理报告",
            owner: { botId: id },
            task: "整理资料",
            dependsOn: [],
            inputs: [],
            maxFixRounds: 2,
            deliverables: [{ id: "report", path: "report.md", kind: "md" }],
            acceptance: [{ id: "exists", check: "exists", deliverable: "report" }],
          },
        ],
      },
    },
    badParams: { groupId: id, messageId: id, decision: "execute" },
    badResult: { id, status: "started" },
  },
  "groups.plan.progress": {
    params: { groupId: id, workflowRunId: id },
    result: {
      workflowRunId: id,
      status: "running",
      stoppedReason: null,
      steps: [{ stepId: "report", status: "running", attempt: 1 }],
      passed: 0,
      total: 1,
      costUsd: null,
      budgetUsd: 1,
    },
    badParams: { groupId: id },
    badResult: { workflowRunId: id, status: "stopped" },
  },
  "groups.plan.stop": {
    params: { groupId: id, workflowRunId: id, confirmed: true },
    result: {
      workflowRunId: id,
      status: "failed",
      stoppedReason: "user_stopped",
      steps: [{ stepId: "report", status: "blocked", attempt: 0 }],
      passed: 0,
      total: 1,
      costUsd: 0.12,
      budgetUsd: null,
    },
    badParams: { groupId: id, workflowRunId: id },
    badResult: { workflowRunId: id, status: "failed", stoppedReason: "Stopped!" },
  },
  "groups.plan.choose": {
    params: { groupId: id, workflowRunId: id, choice: "continue", confirmed: true },
    result: {
      workflowRunId: id,
      status: "running",
      stoppedReason: null,
      steps: [{ stepId: "report", status: "ready", attempt: 0 }],
      passed: 0,
      total: 1,
      costUsd: 0.12,
      budgetUsd: null,
    },
    badParams: { groupId: id, workflowRunId: id, choice: "replan", confirmed: true },
    badResult: { workflowRunId: id, status: "waiting", choice: { kind: "later", stepIds: [] } },
  },
  "groups.plan.template": {
    params: { groupId: id, workflowRunId: id },
    result: {
      document: {
        name: "报告",
        description: "从一次全部通过的群计划保存，共 1 步。",
        body: "常用计划",
        params: [],
        contract: {
          inputs: [],
          prechecks: [],
          deliverables: [],
          acceptance: [],
          stop: [],
          maxFixRounds: 2,
          approvals: [],
          planTemplate: { estimatedCostUsd: 0.6 },
          steps: [
            {
              id: "report",
              title: "整理报告",
              owner: { botId: id },
              task: "整理资料",
              dependsOn: [],
              inputs: [],
              maxFixRounds: 2,
              deliverables: [{ id: "report", path: "report.md", kind: "md" }],
              acceptance: [{ id: "exists", check: "exists", deliverable: "report" }],
            },
          ],
        },
      },
    },
    badParams: { groupId: id },
    badResult: { document: { name: "报告", contract: { planTemplate: {} } } },
  },
  "groups.execution.get": {
    params: { groupId: id },
    result: {
      groupId: id,
      mode: "execute",
      limits: DEFAULT_EXECUTION_LIMITS,
      version: 0,
      updatedAt: null,
    },
    badParams: { groupId: "bad" },
    badResult: {
      groupId: id,
      mode: "execute",
      limits: DEFAULT_EXECUTION_LIMITS,
      version: -1,
      updatedAt: null,
    },
  },
  "groups.execution.set": {
    params: { groupId: id, expectedVersion: 0, limits: DEFAULT_EXECUTION_LIMITS },
    result: {
      groupId: id,
      mode: "execute",
      limits: DEFAULT_EXECUTION_LIMITS,
      version: 1,
      updatedAt: at,
    },
    badParams: { groupId: id, expectedVersion: -1, limits: DEFAULT_EXECUTION_LIMITS },
    badResult: { groupId: id, mode: "execute", limits: {}, version: 1, updatedAt: at },
  },
  "groups.execution.usage": {
    params: { groupId: id, conversationId: id },
    result: {
      groupId: id,
      conversationId: id,
      cycleId: null,
      rootCount: 0,
      totals: {
        activeMillis: 0,
        tools: 0,
        requests: 0,
        childTasks: 0,
        activeChildren: 0,
        maxDepth: 0,
        observedTokens: 0,
        knownCostUsd: 0,
        unknownUsageRequests: 0,
        unknownCostRequests: 0,
        exhaustedRoots: 0,
      },
    },
    badParams: { groupId: id },
    badResult: { groupId: id, conversationId: id, cycleId: null, rootCount: -1, totals: {} },
  },
} satisfies Partial<{ [K in Names]: Case<K> }>;

export const groupEventCases = {
  "groups.plan.changed": {
    payload: {
      groupId: id,
      conversationId: id,
      messageId: id,
      card: groupMethodCases["groups.plan.resolve"].result,
      updatedAt: at,
    },
    bad: { groupId: id },
  },
  "groups.execution.changed": {
    payload: {
      groupId: id,
      mode: "execute" as const,
      limits: DEFAULT_EXECUTION_LIMITS,
      version: 1,
      updatedAt: at,
    },
    bad: { groupId: id },
  },
};
