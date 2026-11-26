// Expose the execution adapters and shared host path helpers.
export { agentBridgeSocketPath } from "./agents/agent-bridge-path.ts";
export {
  AGENT_PLACEHOLDER_PATHS,
  cleanupAgentPlaceholders,
} from "./agents/agent-placeholders.ts";
export {
  type ExternalAgentLaunch,
  startExternalAgent,
} from "./agents/external-agent-process.ts";
export {
  type AgentAllowanceInput,
  type AgentBridgeEndpoint,
  externalAgentSandboxConfig,
} from "./agents/external-agent-sandbox.ts";
export type {
  BackgroundDrainEvent,
  BackgroundEndReason,
  BackgroundJob,
  BackgroundProcessRecord,
  CommandPauseState,
} from "./command/background.ts";
export { createExec } from "./command/command.ts";
export { commandPaths, discoverCommandPaths } from "./command/command-paths.ts";
export type { DenialSignal } from "./command/output-notices.ts";
export {
  issueOutsideSandboxPermit,
  type OutsideSandboxPermit,
} from "./command/outside-sandbox.ts";
export { isSafeSecretEnvName, mergeSecretEnv } from "./command/secret-env.ts";
export {
  createSecretOutputMask,
  SECRET_OUTPUT_WITHHELD,
  type SecretOutputValue,
  secretOutputRedactor,
} from "./command/secret-output.ts";
export {
  SKILL_PYTHON_DOMAINS,
  skillPythonPaths,
  skillPythonWriteRoots,
} from "./command/skill-python.ts";
export {
  type ConnectorServerDiagnosis,
  ConnectorStartError,
} from "./connectors/connector-diagnosis.ts";
export type {
  ConnectorServerStream,
  SandboxedServerOptions,
} from "./connectors/connector-server.ts";
export { connectorSandboxConfig, startSandboxedServer } from "./connectors/connector-server.ts";
export {
  startUnisolatedConnectorServer,
  type UnisolatedServerOptions,
} from "./connectors/connector-unisolated.ts";
export * from "./core/file-identity.ts";
export { canonicalPath, owningWriteRoot } from "./core/paths.ts";
export * from "./core/types.ts";
export {
  windowsProgramFiles,
  windowsSystemDrive,
  windowsSystemRoot,
  windowsSystemTrees,
} from "./core/windows-environment.ts";
export {
  type WindowsPathName,
  windowsHostNames,
  windowsPathName,
  windowsReservedRoot,
  windowsWithin,
} from "./core/windows-paths.ts";
export type { DockerConnection, DockerRuntime } from "./docker/docker.ts";
export {
  dockerArguments,
  dockerFailureHint,
  resolveDockerConnection,
  verifyDockerConnection,
} from "./docker/docker.ts";
export {
  BinaryPublicationError,
  binaryRevision,
  readBinaryFile,
  writeBinaryFile,
} from "./files/binary-files.ts";
export { createFileTools } from "./files/file-tools.ts";
export { imageExportFileName, writeImageBinary } from "./files/image-binary.ts";
export {
  type PatchFile,
  PatchFormatError,
  type PatchFormatProblem,
  parsePatch,
} from "./files/patch-format.ts";
export { PatchRecoveryError } from "./files/patch-publish.ts";
export type { TextEdit } from "./files/replace-text.ts";
export { boundDiff as boundFileDiff } from "./files/text-diff.ts";
export type { WorkspacePage, WorkspaceStat } from "./files/workspace-metadata.ts";
export * from "./git/git-config-candidate.ts";
export * from "./git/git-config-facts.ts";
export {
  prepareHooksPathConfiguration,
  verifyHooksPathConfiguration,
} from "./git/git-config-hooks-path.ts";
export * from "./git/git-config-intent.ts";
export {
  knownConfigurationFileMatches,
  knownConfigurationFileRequestMatches,
  prepareKnownGitConfigurationFile,
} from "./git/git-config-known-file.ts";
export * from "./git/git-config-managed-plan.ts";
export {
  GitConfigurationPublicationUnconfirmedError,
  publishGitConfiguration,
} from "./git/git-config-publish.ts";
export type {
  GitConfigurationCallRequirement,
  GitConfigurationPublishInput,
  GitConfigurationPublishReceipt,
} from "./git/git-config-publish-types.ts";
export {
  type GitEntryFactsData,
  type GitEntryInvocation,
  type GitEntryPlan,
  type GitEntryResult,
  type GitEntryTargetInput,
  gitEntryPlanCurrent,
  inspectGitEntries,
} from "./git/git-entry-scan.ts";
export { gitHookEntry, selectedGitHook } from "./git/git-hook-intent.ts";
export { prepareGitHook } from "./git/git-hook-plan.ts";
export type {
  GitHookExecution,
  GitHookFacts,
  GitHookPlan,
  GitHookPrepareInput,
} from "./git/git-hook-types.ts";
export {
  type GitInstallOutcome,
  type GitInstallPlan,
  type GitPackageManager,
  gitInstallPlan,
  gitVersion,
  runGitInstaller,
  waitForGit,
} from "./git/git-install.ts";
export * from "./git/git-network.ts";
export { prepareGitOutput } from "./git/git-output.ts";
export { GitOutputSourceError } from "./git/git-output-error.ts";
export { gitOutputIntent } from "./git/git-output-intent.ts";
export { findGit } from "./git/git-process.ts";
export {
  createGitReader,
  type GitReader,
  type GitReadOperation,
  type GitReadResult,
} from "./git/git-read.ts";
export * from "./git/git-resources.ts";
export { type GitWriteOperation, gitWriteCommand, validGitIdentity } from "./git/git-write.ts";
export { type DirectGitWriteResult, runGitWriteDirect } from "./git/git-write-direct.ts";
export * from "./managed/file-checkpoint.ts";
export * from "./managed/managed-boundary.ts";
export * from "./managed/managed-errors.ts";
export * from "./managed/managed-folder.ts";
export * from "./managed/managed-git.ts";
export * from "./managed/managed-git-target.ts";
export * from "./managed/managed-project.ts";
export { libreOfficeInstalled, probeOfficeConverter } from "./native-apps/office-convert.ts";
export {
  convertOfficeDocument,
  type OfficeConvertSource,
  type OfficeConvertTarget,
  type OfficeLibreOfficeResult,
} from "./native-apps/office-convert-recipe.ts";
export { pingLocalHost, readLocalNetworkState } from "./network/local-network.ts";
export {
  bundledNodePath,
  CHILD_NODE_VERSION,
  type ChildNodeRuntime,
  childNodeRuntime,
  unpackedPath,
} from "./runtime/child-node.ts";
export { aiConfigReadBoundary } from "./sandbox/ai-config-paths.ts";
export { type IsolationRemedy, linuxIsolationRemedy } from "./sandbox/isolation-remedy.ts";
export { sensitiveReadBoundary } from "./sandbox/sensitive-paths.ts";
export { rememberableSystemService } from "./sandbox/system-services.ts";
export { directoryIdentity } from "./sandbox/workspace.ts";
export {
  type HostSshFileCache,
  prepareHostSsh,
  verifyPreparedHostSsh,
} from "./ssh/ssh-config.ts";
export {
  type HostSshAliasList,
  type HostSshAliasStatus,
  listHostSshAliases,
} from "./ssh/ssh-hosts.ts";
export { hostSshIntent } from "./ssh/ssh-intent.ts";
export type { HostSshReason, PreparedHostSsh } from "./ssh/ssh-types.ts";
export { HostSshConfigError, HostSshError } from "./ssh/ssh-types.ts";
export {
  createLocalExecutionTarget,
  type ExecutionTarget,
  type FolderLevel,
  type LocalExecutionTargetOptions,
} from "./target/execution-target.ts";
export { BingError, bingSearch } from "./web/bing.ts";
export { DuckDuckGoError, duckduckgoSearch } from "./web/duckduckgo.ts";
export { createNetworkFetch } from "./web/network-fetch.ts";
export * from "./web/network-proxy.ts";
export { PublicDownloadError, withPublicDownload } from "./web/public-download.ts";
export { searchJson } from "./web/search-http.ts";
export type { BlockedPageReason } from "./web/web.ts";
export { blockedPage, fetchPage } from "./web/web.ts";
export { assertPublicWebTarget } from "./web/web-address.ts";
export { fetchImage } from "./web/web-image.ts";
