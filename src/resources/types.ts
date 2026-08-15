export type EchoInkResourceKind = "skill" | "mcp-server" | "tool-bundle";
export type EchoInkResourceSource = "echoink-local" | "manual";
export type EchoInkResourceBridgeMode = "prompt-only" | "native-mcp" | "structured-tools" | "plugin-tool";

export type ResourcePlane = "echoink-builtin" | "echoink-vault" | "agent-native" | "imported-copy";

export interface ResourceRef {
  plane: ResourcePlane;
  backendId?: string;
  resourceId: string;
}

export interface ResourceSelectionSnapshot {
  selected: ResourceRef[];
  resolvedAt: number;
  warnings: string[];
}

export interface EchoInkMcpStdioConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface EchoInkMcpHttpConfig {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
}

export type EchoInkMcpConnectionConfig = EchoInkMcpStdioConfig | EchoInkMcpHttpConfig;

export type EchoInkMcpCredentialPurpose = "mcp_header" | "mcp_env";

/**
 * A display-safe reference to a SecretStorage value. The secret itself never
 * enters settings, MCP discovery, Pi Session data, Tool Results, or Receipts.
 */
export interface EchoInkMcpCredentialBinding {
  credentialRef: string;
  purpose: EchoInkMcpCredentialPurpose;
  targetName: string;
  prefix?: string;
  endpointRevision: number;
}

export interface EchoInkMcpToolReadbackAssertion {
  resultPath: string;
  argumentKey: string;
}

/** A server-declared, namespaced query contract used only after one write. */
export interface EchoInkMcpToolReadbackContract {
  toolName: string;
  argumentMap: Record<string, string>;
  assertions: EchoInkMcpToolReadbackAssertion[];
}

export interface EchoInkMcpDiscoveredTool {
  name: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  inputSchema: Record<string, unknown>;
  readback?: EchoInkMcpToolReadbackContract;
}

export interface EchoInkMcpToolPolicy {
  enabled: boolean;
  trusted: boolean;
}

export type EchoInkMcpDiagnosticCode =
  | "connection_failed"
  | "authentication_failed"
  | "schema_invalid"
  | "disconnected"
  | "timeout"
  | "call_failed";

export interface EchoInkMcpDiagnostic {
  code: EchoInkMcpDiagnosticCode;
  message: string;
  occurredAt: number;
}

export type EchoInkMcpConnectionRecord = EchoInkMcpConnectionConfig & {
  /** Server trust admits tools; it never bypasses approval for side effects. */
  trusted: boolean;
  /** One explicit policy per discovered Tool. */
  toolPolicies: Record<string, EchoInkMcpToolPolicy>;
  credential?: EchoInkMcpCredentialBinding;
  tools: EchoInkMcpDiscoveredTool[];
  toolsFingerprint?: string;
  discoveredAt?: number;
  diagnostic?: EchoInkMcpDiagnostic;
  verifiedAt?: number;
  lastError?: string;
};

export type EchoInkMcpConnectionRecords = Record<string, EchoInkMcpConnectionRecord>;

export interface EchoInkCallableMcpTool {
  name: string;
  resourceId: string;
  resourceName: string;
  toolName: string;
  description: string;
  /** Pi Chat only admits an MCP Tool that declares this protocol guarantee. */
  readOnly: boolean;
  destructive: boolean;
  inputSchema: Record<string, unknown>;
  readback?: EchoInkMcpToolReadbackContract;
}

export interface EchoInkCallableMcpToolCatalog {
  tools: EchoInkCallableMcpTool[];
  warnings: string[];
}

export interface EchoInkResource {
  id: string;
  kind: EchoInkResourceKind;
  source: EchoInkResourceSource;
  name: string;
  description: string;
  enabled: boolean;
  bridgeMode: EchoInkResourceBridgeMode;
  configPath?: string;
  contentPath?: string;
  metadata?: Record<string, unknown>;
}

export type EchoInkSkillResource = EchoInkResource & { kind: "skill" };

export interface EchoInkResourceSettings {
  catalog: EchoInkResource[];
  /** v47 scope decisions waiting for the same resource to be rediscovered. */
  legacyEnabledOverrides?: Record<string, boolean>;
  importedFrom: Partial<Record<EchoInkResourceSource, number>>;
  mcpConnections: EchoInkMcpConnectionRecords;
  lastScannedAt: number;
  lastError: string;
}
