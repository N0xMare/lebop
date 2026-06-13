export type SurfaceDomain =
  | "workspace"
  | "issues"
  | "projects"
  | "pull"
  | "publish"
  | "cache"
  | "plan"
  | "auth"
  | "other";

export type SurfaceOperationAction =
  | "explore"
  | "fetch"
  | "list"
  | "get"
  | "create"
  | "update"
  | "delete"
  | "publish"
  | "review"
  | "other";

export type SurfaceSafety = {
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
  confirm?: "required" | "required_when_mutating" | "not_required";
};

export type SurfaceConfirmPolicy = NonNullable<SurfaceSafety["confirm"]>;

export type SurfaceCliMapping = {
  command: string;
  liveSteps?: readonly string[];
};

export type SurfaceMcpAnnotationHints = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type SurfaceMcpMapping = {
  tool: string;
  title?: string;
  description?: string;
  annotations?: SurfaceMcpAnnotationHints;
  inputSchemaKeys?: readonly string[];
  liveSemantics?: "required" | "optional";
};

export interface SurfaceOperationContract<
  CanonicalInput,
  Result,
  CliInput = unknown,
  McpInput = unknown,
> {
  id: string;
  domain: SurfaceDomain;
  resource?: string;
  action?: SurfaceOperationAction;
  aliasOf?: string;
  title?: string;
  description?: string;
  cli?: SurfaceCliMapping;
  mcp?: SurfaceMcpMapping;
  safety: SurfaceSafety;
  behaviorContractKind?: "explore" | "fetch" | "publish" | "json_error";
  fromCli?: (input: CliInput) => CanonicalInput;
  fromMcp?: (input: McpInput, deps?: unknown) => CanonicalInput;
  execute?: (input: CanonicalInput) => Promise<Result>;
}

export interface SurfaceOperationMetadata {
  id: string;
  domain: SurfaceDomain;
  resource?: string;
  action?: SurfaceOperationAction;
  aliasOf?: string;
  title?: string;
  description?: string;
  cli?: SurfaceCliMapping;
  mcp?: SurfaceMcpMapping;
  safety: SurfaceSafety;
  behaviorContractKind?: "explore" | "fetch" | "publish" | "json_error";
}

export interface SurfaceCliManifestExpectation {
  operationId: string;
  command: string;
  mcpTools: readonly string[];
}

export interface SurfaceMcpManifestExpectation {
  tool: string;
  operationIds: readonly string[];
  cliCommands: readonly string[];
  confirm: SurfaceConfirmPolicy;
  liveSemantics?: "required" | "optional";
}

export interface SurfaceMcpAnnotationExpectation {
  title?: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export function surfaceConfirmPolicy(
  operation: Pick<SurfaceOperationMetadata, "safety">,
): SurfaceConfirmPolicy {
  return operation.safety.confirm ?? (operation.safety.destructive ? "required" : "not_required");
}

export function surfaceMcpAnnotationExpectation(
  operation: Pick<SurfaceOperationMetadata, "mcp" | "safety" | "title">,
): SurfaceMcpAnnotationExpectation {
  const annotations = operation.mcp?.annotations;
  return {
    title: annotations?.title ?? operation.mcp?.title ?? operation.title,
    readOnlyHint: annotations?.readOnlyHint ?? operation.safety.readOnly,
    destructiveHint: annotations?.destructiveHint ?? operation.safety.destructive,
    idempotentHint: annotations?.idempotentHint ?? operation.safety.idempotent,
    openWorldHint: annotations?.openWorldHint ?? operation.safety.openWorld,
  };
}

export function deriveSurfaceCliManifestExpectations(
  operations: readonly SurfaceOperationMetadata[],
): SurfaceCliManifestExpectation[] {
  const toolsByCommand = new Map<string, string[]>();
  for (const operation of operations) {
    if (!operation.cli || !operation.mcp) continue;
    const tools = toolsByCommand.get(operation.cli.command) ?? [];
    tools.push(operation.mcp.tool);
    toolsByCommand.set(operation.cli.command, tools);
  }

  return operations.flatMap((operation) => {
    if (!operation.cli || !operation.mcp) return [];
    return [
      {
        operationId: operation.id,
        command: operation.cli.command,
        mcpTools: uniqueSorted(toolsByCommand.get(operation.cli.command) ?? []),
      },
    ];
  });
}

export function deriveSurfaceMcpManifestExpectations(
  operations: readonly SurfaceOperationMetadata[],
): SurfaceMcpManifestExpectation[] {
  const byTool = new Map<
    string,
    {
      tool: string;
      operationIds: string[];
      cliCommands: string[];
      confirm: SurfaceConfirmPolicy;
      liveSemantics?: "required" | "optional";
    }
  >();

  for (const operation of operations) {
    if (!operation.mcp) continue;

    const existing = byTool.get(operation.mcp.tool) ?? {
      tool: operation.mcp.tool,
      operationIds: [],
      cliCommands: [],
      confirm: "not_required" as SurfaceConfirmPolicy,
      liveSemantics: undefined,
    };

    existing.operationIds.push(operation.id);
    if (operation.cli) existing.cliCommands.push(operation.cli.command);
    existing.confirm = strongestConfirmPolicy(existing.confirm, surfaceConfirmPolicy(operation));
    existing.liveSemantics = strongestLiveSemantics(
      existing.liveSemantics,
      operation.mcp.liveSemantics,
    );
    byTool.set(operation.mcp.tool, existing);
  }

  return [...byTool.values()].map((entry) => ({
    ...entry,
    operationIds: uniqueSorted(entry.operationIds),
    cliCommands: uniqueSorted(entry.cliCommands),
  }));
}

export function deriveSurfaceRequiredMcpConfirmTools(
  operations: readonly SurfaceOperationMetadata[],
): string[] {
  return uniqueSorted(
    operations.flatMap((operation) =>
      operation.mcp && surfaceConfirmPolicy(operation) === "required" ? [operation.mcp.tool] : [],
    ),
  );
}

function strongestConfirmPolicy(
  current: SurfaceConfirmPolicy,
  next: SurfaceConfirmPolicy,
): SurfaceConfirmPolicy {
  if (current === "required" || next === "required") return "required";
  if (current === "required_when_mutating" || next === "required_when_mutating") {
    return "required_when_mutating";
  }
  return "not_required";
}

function strongestLiveSemantics(
  current: "required" | "optional" | undefined,
  next: "required" | "optional" | undefined,
): "required" | "optional" | undefined {
  if (current === "required" || next === "required") return "required";
  return current ?? next;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted();
}
