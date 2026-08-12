import { z } from "zod";
import { parseCliLimit } from "../lib/cliOptions.ts";
import { applyEntityTextField } from "../lib/contentSize.ts";
import {
  createDocument,
  deleteDocument,
  type FullDocument,
  getDocument,
  type ListedDocument,
  listDocuments,
  type UpdateDocumentInput,
  updateDocument,
} from "../lib/documents.ts";
import { NotFoundError, tryIdempotentDelete, ValidationError } from "../lib/errors.ts";
import { resolveExistingProjectId, resolveProjectId } from "../lib/milestones.ts";
import type { SurfaceOperationContract } from "./contracts.ts";
import { parseSurfaceInput, workspaceArg } from "./schema.ts";

// ── Canonical inputs ────────────────────────────────────────────────────────

export interface DocumentListInput {
  project?: string;
  /** Resolved max rows for listDocuments (∞ when CLI/MCP limit is 0). */
  max: number;
}

export interface DocumentListCliInput {
  opts: {
    project?: string;
    limit?: string;
  };
}

export type DocumentListMcpInput = Record<string, unknown> & {
  project?: string;
  limit?: number;
};

export interface DocumentGetInput {
  id: string;
  fullContent?: boolean;
  contentFile?: string;
}

export interface DocumentGetExecutionResult {
  document: FullDocument;
  content: Record<string, unknown>;
  truncated: boolean;
}

export interface DocumentCreateInput {
  title: string;
  /** Name-or-UUID selector (CLI `--project` / MCP `project`). */
  project?: string;
  /** CLI `--project-id` only — UUID passthrough, no name lookup. */
  projectId?: string;
  /** Issue identifier or UUID for issue-scoped documents (0.0.6). */
  issueId?: string;
  content?: string;
  icon?: string;
  /** Channel-specific NotFoundError hint when project selector misses. */
  projectNotFoundHint?: string;
}

export interface DocumentCreateCliInput {
  title: string;
  opts: {
    project?: string;
    projectId?: string;
    issue?: string;
    icon?: string;
  };
  content?: string;
}

export type DocumentCreateMcpInput = Record<string, unknown> & {
  title: string;
  project?: string;
  issue_id?: string;
  content?: string;
  icon?: string;
};

export interface DocumentUpdateCanonicalInput {
  id: string;
  update: UpdateDocumentInput;
}

export interface DocumentUpdateCliInput {
  id: string;
  opts: {
    title?: string;
    icon?: string;
  };
  content?: string;
}

export type DocumentUpdateMcpInput = Record<string, unknown> & {
  id: string;
  title?: string;
  content?: string;
  icon?: string;
};

export interface DocumentDeleteInput {
  id: string;
  confirmed?: boolean;
}

export interface DocumentDeleteCliInput {
  id: string;
  opts: {
    yes?: boolean;
  };
}

export type DocumentDeleteMcpInput = Record<string, unknown> & {
  id: string;
  confirm?: boolean;
};

// ── Results ─────────────────────────────────────────────────────────────────

export interface DocumentListExecutionResult {
  count: number;
  documents: ListedDocument[];
}

export interface DocumentDeleteExecutionResult {
  id: string;
  status: "deleted" | "already-absent";
  /**
   * Channel-specific success:
   * - CLI: `status === "deleted" && Boolean(mutationResult)`
   * - MCP: `status === "deleted"`
   * Use {@link documentDeleteSuccessForCli} / {@link documentDeleteSuccessForMcp}.
   */
  mutationResult?: boolean;
}

export interface DocumentProjectNotFoundHints {
  projectNotFoundHint?: string;
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const documentListCanonicalSchema = z
  .object({
    project: z.string().optional(),
    // May be Number.POSITIVE_INFINITY when limit is 0 (CLI/MCP no-limit).
    max: z.number(),
  })
  .strict();

const documentGetCanonicalSchema = z
  .object({
    id: z.string().min(1),
    fullContent: z.boolean().optional(),
    contentFile: z.string().optional(),
  })
  .strict();

const documentCreateCanonicalSchema = z
  .object({
    title: z.string(),
    project: z.string().optional(),
    projectId: z.string().optional(),
    issueId: z.string().optional(),
    content: z.string().optional(),
    icon: z.string().optional(),
    projectNotFoundHint: z.string().optional(),
  })
  .strict();

const documentUpdateCanonicalSchema = z
  .object({
    id: z.string().min(1),
    update: z
      .object({
        title: z.string().optional(),
        content: z.string().optional(),
        icon: z.string().optional(),
      })
      .strict(),
  })
  .strict();

const documentDeleteCanonicalSchema = z.object({ id: z.string().min(1), confirmed: z.boolean().optional() }).strict();

// ── Builders ────────────────────────────────────────────────────────────────

export function buildDocumentListInputFromCli(input: DocumentListCliInput): DocumentListInput {
  const max = parseCliLimit(input.opts.limit, { defaultValue: 50, zeroMeansInfinity: true });
  return parseSurfaceInput("documents.list", documentListCanonicalSchema, {
    project: input.opts.project,
    max,
  });
}

export function buildDocumentListInputFromMcp(input: DocumentListMcpInput): DocumentListInput {
  const limit = input.limit ?? 50;
  const max = limit === 0 ? Number.POSITIVE_INFINITY : limit;
  return parseSurfaceInput("documents.list", documentListCanonicalSchema, {
    project: input.project,
    max,
  });
}

export function buildDocumentGetInput(
  id: string,
  opts?: { fullContent?: boolean; contentFile?: string },
): DocumentGetInput {
  return parseSurfaceInput("documents.get", documentGetCanonicalSchema, {
    id,
    fullContent: opts?.fullContent === true ? true : undefined,
    contentFile:
      typeof opts?.contentFile === "string" && opts.contentFile.trim()
        ? opts.contentFile.trim()
        : undefined,
  });
}

export function buildDocumentCreateInputFromCli(
  input: DocumentCreateCliInput,
): DocumentCreateInput {
  if (input.opts.project && input.opts.projectId) {
    throw new ValidationError(
      "pass exactly one of --project / --project-id, not both",
      "choose one project selector",
    );
  }
  const hasProject = Boolean(input.opts.project || input.opts.projectId);
  const hasIssue = Boolean(input.opts.issue);
  if (hasProject && hasIssue) {
    throw new ValidationError(
      "pass either a project selector or --issue, not both",
      "documents are scoped to one parent (project or issue)",
    );
  }
  if (!hasProject && !hasIssue) {
    throw new ValidationError(
      "either --project / --project-id or --issue is required",
      "create documents on a project or attach them to an issue",
    );
  }
  return parseSurfaceInput("documents.create", documentCreateCanonicalSchema, {
    title: input.title,
    project: input.opts.project,
    projectId: input.opts.projectId,
    issueId: input.opts.issue,
    content: input.content,
    icon: input.opts.icon,
  });
}

export function buildDocumentCreateInputFromMcp(
  input: DocumentCreateMcpInput,
): DocumentCreateInput {
  if (input.project && input.issue_id) {
    throw new ValidationError(
      "create_document accepts either project or issue_id, not both",
      "scope the document to one parent",
    );
  }
  if (!input.project && !input.issue_id) {
    throw new ValidationError(
      "create_document requires project or issue_id",
      "pass project for project-scoped docs, or issue_id for issue-scoped docs",
    );
  }
  return parseSurfaceInput("documents.create", documentCreateCanonicalSchema, {
    title: input.title,
    project: input.project,
    issueId: input.issue_id,
    content: input.content,
    icon: input.icon,
    projectNotFoundHint: DOCUMENT_MCP_PROJECT_NOT_FOUND_HINT,
  });
}

export function buildDocumentUpdateInputFromCli(
  input: DocumentUpdateCliInput,
): DocumentUpdateCanonicalInput {
  const update: UpdateDocumentInput = {};
  if (input.opts.title !== undefined) update.title = input.opts.title;
  if (input.opts.icon !== undefined) update.icon = input.opts.icon;
  if (input.content !== undefined) update.content = input.content;
  if (Object.keys(update).length === 0) {
    throw new ValidationError(
      "nothing to update — pass at least one field",
      "pass --title, --content, --content-file, --stdin, or --icon",
    );
  }
  return parseSurfaceInput("documents.update", documentUpdateCanonicalSchema, {
    id: input.id,
    update,
  });
}

export function buildDocumentUpdateInputFromMcp(
  input: DocumentUpdateMcpInput,
): DocumentUpdateCanonicalInput {
  const update: UpdateDocumentInput = {};
  if (input.title !== undefined) update.title = input.title;
  if (input.content !== undefined) update.content = input.content;
  if (input.icon !== undefined) update.icon = input.icon;
  if (Object.keys(update).length === 0) {
    throw new ValidationError(
      "nothing to update — pass at least one field",
      "pass at least one of the optional update fields",
    );
  }
  return parseSurfaceInput("documents.update", documentUpdateCanonicalSchema, {
    id: input.id,
    update,
  });
}

export function buildDocumentDeleteInputFromCli(
  input: DocumentDeleteCliInput,
): DocumentDeleteInput {
  if (!input.opts.yes) {
    throw new ValidationError(
      `refusing to soft-delete document ${input.id} without --yes`,
      "re-run with --yes to confirm. Soft-deletes (archived_at); not restored by lebop unarchive.",
    );
  }
  return parseSurfaceInput("documents.soft_delete", documentDeleteCanonicalSchema, {
    id: input.id,
    confirmed: true,
  });
}

export function buildDocumentDeleteInputFromMcp(
  input: DocumentDeleteMcpInput,
): DocumentDeleteInput {
  if (input.confirm !== true) {
    throw new ValidationError(
      "soft_delete_document requires confirm:true for destructive execution",
      "pass confirm:true after verifying the soft-delete is intended",
    );
  }
  return parseSurfaceInput("documents.soft_delete", documentDeleteCanonicalSchema, {
    id: input.id,
    confirmed: true,
  });
}

// ── Execute ─────────────────────────────────────────────────────────────────

export async function executeDocumentList(
  input: DocumentListInput,
  channel: DocumentProjectNotFoundHints = {},
): Promise<DocumentListExecutionResult> {
  let projectId: string | undefined;
  if (input.project) {
    const resolved = await resolveExistingProjectId(input.project);
    if (!resolved) {
      throw new NotFoundError(`project not found: ${input.project}`, channel.projectNotFoundHint);
    }
    projectId = resolved;
  }
  const documents = await listDocuments({ projectId, max: input.max });
  return { count: documents.length, documents };
}

export function documentListPayload(result: DocumentListExecutionResult) {
  return { count: result.count, documents: result.documents };
}

export async function executeDocumentGet(
  input: DocumentGetInput,
  hint?: string,
): Promise<DocumentGetExecutionResult> {
  const document = await getDocument(input.id);
  if (!document) {
    throw new NotFoundError(`document not found: ${input.id}`, hint);
  }
  const applied = await applyEntityTextField(
    document as unknown as Record<string, unknown>,
    "content",
    {
      fullContent: input.fullContent === true,
      contentFile: input.contentFile,
    },
  );
  return {
    document: applied.entity as unknown as FullDocument,
    content: applied.content,
    truncated: applied.truncated,
  };
}

export async function executeDocumentCreate(input: DocumentCreateInput): Promise<FullDocument> {
  if (input.issueId) {
    return createDocument({
      title: input.title,
      issueId: input.issueId,
      content: input.content,
      icon: input.icon,
    });
  }
  const projectId = await resolveCreateProjectId(input);
  return createDocument({
    title: input.title,
    projectId,
    content: input.content,
    icon: input.icon,
  });
}

export async function executeDocumentUpdate(
  input: DocumentUpdateCanonicalInput,
): Promise<FullDocument> {
  return updateDocument(input.id, input.update);
}

export async function executeDocumentDelete(
  input: DocumentDeleteInput,
): Promise<DocumentDeleteExecutionResult> {
  if (input.confirmed !== true) {
    throw new ValidationError(
      "refusing to soft-delete document without confirm",
      "pass --yes (CLI) or confirm:true (MCP) after verifying the soft-delete is intended",
    );
  }
  const r = await tryIdempotentDelete(() => deleteDocument(input.id));
  return {
    id: input.id,
    status: r.status,
    mutationResult: r.status === "deleted" ? Boolean(r.result) : undefined,
  };
}

/** CLI delete success (drives exitCode when deleted+!success). */
export function documentDeleteSuccessForCli(result: DocumentDeleteExecutionResult): boolean {
  return result.status === "deleted" && Boolean(result.mutationResult);
}

/** MCP delete success — status-only (pre-migration formula). */
export function documentDeleteSuccessForMcp(result: DocumentDeleteExecutionResult): boolean {
  return result.status === "deleted";
}

// ── Operation contracts ─────────────────────────────────────────────────────

const DOCUMENT_MCP_PROJECT_NOT_FOUND_HINT =
  "pass the project name (case-sensitive) or UUID; run list_projects to discover ids";

const DOCUMENT_MCP_GET_HINT = "verify the document UUID; run list_documents to discover ids";

export const documentListOperation = {
  id: "documents.list",
  domain: "documents",
  resource: "document",
  action: "list",
  title: "List Linear documents",
  description: "Pass project (name or UUID) to filter to one project's docs.",
  cli: {
    command: "document list",
    liveSteps: ["cli:document list --json"],
  },
  mcp: {
    tool: "list_documents",
    title: "List Linear documents",
    description: "Pass project (name or UUID) to filter to one project's docs.",
    annotations: {
      title: "List Linear documents",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: true, destructive: false, idempotent: true, openWorld: true },
  fromCli: buildDocumentListInputFromCli,
  fromMcp: buildDocumentListInputFromMcp,
  execute: executeDocumentList,
} satisfies SurfaceOperationContract<
  DocumentListInput,
  DocumentListExecutionResult,
  DocumentListCliInput,
  DocumentListMcpInput
>;

export const documentGetOperation = {
  id: "documents.get",
  domain: "documents",
  resource: "document",
  action: "get",
  title: "Get one document by UUID (with content)",
  description:
    "Returns one document with content. Dense (64 KiB default); prefer content_file for large bodies. content_file writes host FS.",
  cli: {
    command: "document view",
    liveSteps: ["cli:document view --json"],
  },
  mcp: {
    tool: "get_document",
    title: "Get one document by UUID (with content)",
    description:
      "Returns one document with content. Dense (64 KiB default); prefer content_file for large bodies. content_file writes host FS.",
    annotations: {
      title: "Get one document by UUID (with content)",
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  notes: "Content size policy applied in execute. content_file is a host FS write.",
  execute: (input) => executeDocumentGet(input),
} satisfies SurfaceOperationContract<DocumentGetInput, DocumentGetExecutionResult>;

export const documentCreateOperation = {
  id: "documents.create",
  domain: "documents",
  resource: "document",
  action: "create",
  title: "Create a document",
  description: "Must be attached to a project. NOT retry-wrapped.",
  cli: {
    command: "document create",
    liveSteps: ["cli:document create --content-file --json"],
  },
  mcp: {
    tool: "create_document",
    title: "Create a document",
    description: "Must be attached to a project. NOT retry-wrapped.",
    annotations: {
      title: "Create a document",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  safety: { readOnly: false, destructive: false, idempotent: false, openWorld: true },
  notes:
    "CLI accepts --project (name-or-id via resolveProjectId) or --project-id (UUID passthrough), mutually exclusive. MCP accepts project only via resolveProjectId. Content I/O (--content-file/--stdin) stays in the CLI adapter.",
  fromCli: buildDocumentCreateInputFromCli,
  fromMcp: buildDocumentCreateInputFromMcp,
  execute: executeDocumentCreate,
} satisfies SurfaceOperationContract<
  DocumentCreateInput,
  FullDocument,
  DocumentCreateCliInput,
  DocumentCreateMcpInput
>;

export const documentUpdateOperation = {
  id: "documents.update",
  domain: "documents",
  resource: "document",
  action: "update",
  title: "Update a document",
  description: "Idempotent at the value level — safe to retry.",
  cli: {
    command: "document update",
    liveSteps: ["cli:document update --stdin --json"],
  },
  mcp: {
    tool: "update_document",
    title: "Update a document",
    description: "Idempotent at the value level — safe to retry.",
    annotations: {
      title: "Update a document",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
  notes:
    "Empty-patch validation hints differ by channel (CLI flag list vs MCP field list). Content I/O stays in the CLI adapter.",
  fromCli: buildDocumentUpdateInputFromCli,
  fromMcp: buildDocumentUpdateInputFromMcp,
  execute: executeDocumentUpdate,
} satisfies SurfaceOperationContract<
  DocumentUpdateCanonicalInput,
  FullDocument,
  DocumentUpdateCliInput,
  DocumentUpdateMcpInput
>;

export const documentDeleteOperation = {
  id: "documents.soft_delete",
  domain: "documents",
  resource: "document",
  action: "soft_delete",
  title: "Soft-delete a document",
  description:
    "Delete a document by UUID. Soft delete server-side (sets `archived_at`); not restored by unarchive; soft-delete via archived_at. Idempotent — re-deleting an already-soft-deleted document returns `{status: 'already-absent'}`.",
  cli: {
    command: "document soft-delete",
    liveSteps: ["cli:document soft-delete --json"],
  },
  mcp: {
    tool: "soft_delete_document",
    title: "Soft-delete a document",
    description:
      "Delete a document by UUID. Soft delete server-side (sets `archived_at`); not restored by unarchive; soft-delete via archived_at. Idempotent — re-deleting an already-soft-deleted document returns `{status: 'already-absent'}`.",
    annotations: {
      title: "Soft-delete a document",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  safety: {
    readOnly: false,
    destructive: true,
    idempotent: true,
    openWorld: true,
    confirm: "required",
  },
  fromCli: buildDocumentDeleteInputFromCli,
  fromMcp: buildDocumentDeleteInputFromMcp,
  execute: executeDocumentDelete,
} satisfies SurfaceOperationContract<
  DocumentDeleteInput,
  DocumentDeleteExecutionResult,
  DocumentDeleteCliInput,
  DocumentDeleteMcpInput
>;

export const DOCUMENT_SURFACE_OPERATIONS = [
  documentListOperation,
  documentGetOperation,
  documentCreateOperation,
  documentUpdateOperation,
  documentDeleteOperation,
] as const;

// ── MCP input schemas ───────────────────────────────────────────────────────

export function buildDocumentListMcpInputSchema(workspaceDescription: string) {
  return {
    project: z.string().optional(),
    limit: z.number().int().min(0).optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildDocumentGetMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string(),
    full_content: z
      .boolean()
      .optional()
      .describe("Full document content on the wire (bypass 64 KiB agent size cap)."),
    content_file: z
      .string()
      .optional()
      .describe(
        "Write full content to this host path; wire stays dense. Prefer for large bodies. Side-effect: writes disk.",
      ),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildDocumentCreateMcpInputSchema(workspaceDescription: string) {
  return {
    title: z.string(),
    project: z
      .string()
      .optional()
      .describe("Project name or UUID. Mutually exclusive with issue_id."),
    issue_id: z
      .string()
      .optional()
      .describe(
        "Issue identifier or UUID for issue-scoped documents. Mutually exclusive with project.",
      ),
    content: z.string().optional(),
    icon: z
      .string()
      .optional()
      .describe(
        "Linear internal icon name (PascalCase, e.g. 'BarChart', 'Rocket', 'Target'). Emoji are rejected locally; invalid non-emoji names may be rejected by Linear. Omit if unsure.",
      ),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildDocumentUpdateMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string(),
    title: z.string().optional(),
    content: z.string().optional(),
    icon: z.string().optional(),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

export function buildDocumentDeleteMcpInputSchema(workspaceDescription: string) {
  return {
    id: z.string(),
    confirm: z.boolean().optional().describe("Required true for deletion."),
    workspace: workspaceArg.describe(workspaceDescription),
  };
}

/** MCP channel defaults for not-found hints. */
export { DOCUMENT_MCP_GET_HINT, DOCUMENT_MCP_PROJECT_NOT_FOUND_HINT };

// ── Internals ───────────────────────────────────────────────────────────────

async function resolveCreateProjectId(input: DocumentCreateInput): Promise<string> {
  if (input.projectId) {
    return input.projectId;
  }
  if (!input.project) {
    throw new ValidationError(
      "either --project <name-or-id> or --project-id <uuid> is required",
      "documents must be created inside a project",
    );
  }
  // Both CLI `--project` and MCP `project` use resolveProjectId (UUID passthrough).
  const projectId = await resolveProjectId(input.project);
  if (!projectId) {
    throw new NotFoundError(`project not found: ${input.project}`, input.projectNotFoundHint);
  }
  return projectId;
}
