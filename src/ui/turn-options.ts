import type { WorkspaceResourceToggles } from "../settings/settings";
import type {
  PermissionMode,
  ReasoningEffort,
  ServiceTierChoice,
  UiMode
} from "../types/app-server";

export interface TurnOptions {
  cwd?: string;
  providerSettingsId: string;
  model: string;
  developerInstructions?: string;
  ephemeral?: boolean;
  reasoning: ReasoningEffort;
  serviceTier: ServiceTierChoice;
  permission: PermissionMode;
  mode: UiMode;
  mcpEnabled: boolean;
  persistExtendedHistory?: boolean;
  requestTimeoutMs?: number;
  writableRoots?: string[];
  workspaceResources?: WorkspaceResourceToggles;
  externalResources?: "disabled";
}
