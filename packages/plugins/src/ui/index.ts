/**
 * Connectors, UI entry: the connected-apps page with its setup, import and secrets pages, and
 * the pieces other pages embed (connector details and feedback, the operation and page hooks). It
 * uses the app shell only through `@pibot/renderer-kit`.
 */

export { ConnectorDetails } from "./page/ConnectorDetails.tsx";
export {
  ConnectorFeedback,
  ConnectorPagination,
  OperationStatus,
} from "./page/ConnectorFeedback.tsx";
export { ConnectorsPage } from "./page/ConnectorsPage.tsx";
export { useConnectionChoices } from "./page/connection-choices.ts";
export { FacePicker } from "./page/connections/Faces.tsx";
export { PendingImportedSkills } from "./page/PendingImportedSkills.tsx";
export { TargetConnections } from "./page/TargetConnections.tsx";
export { ImportPlugin } from "./setup/ImportPlugin.tsx";
export { useConnectorOperations } from "./shell/operations.ts";
export { type ConnectorsUiPorts, ConnectorsUiProvider } from "./shell/ports.tsx";
export { useConnectorAction, useConnectorPage } from "./shell/remote.ts";
