/**
 * Mechanical extract from workspaceFetch — kind context.
 */

import { getDocument } from "../documents.ts";
import { NotFoundError } from "../errors.ts";
import { type ContextFile, writeWorkspaceContext } from "../workspaceContextWriter.ts";
import { safeSegment } from "../workspacePaths.ts";
import {
  markComplete,
  omitDocumentContent,
  recommendedList,
  recommendedReads,
  renderEntityMarkdown,
} from "./fetchShared.ts";
import type {
  FetchCompletenessEntry,
  FetchLinearWorkspaceResult,
  FetchSelection,
} from "./fetchTypes.ts";

export async function fetchDocumentContext(input: {
  target: string;
  documentId: string;
  config: { repoHash: string };
  include: Set<string>;
  selection: FetchSelection;
  to?: string;
}): Promise<FetchLinearWorkspaceResult> {
  const document = await getDocument(input.documentId);
  if (!document)
    throw new NotFoundError(`document not found: ${input.documentId}`, "verify the document UUID");

  const includeContent = input.include.has("content");
  const documentForOutput = includeContent ? document : omitDocumentContent(document);
  const files: ContextFile[] = [
    {
      relative: `documents/${safeSegment(document.id)}/document.md`,
      content: renderEntityMarkdown("Document", document.title, documentForOutput),
    },
  ];
  const counts: Record<string, number> = { documents: 1 };
  const completeness: Record<string, FetchCompletenessEntry> = {};
  const omitted: string[] = [];
  markComplete(completeness, "documents", 1);
  if (!input.include.has("content")) omitted.push("content");

  const summary = {
    target: input.target,
    kind: "document",
    ...input.selection,
    document: documentForOutput,
    counts,
    completeness,
    omitted,
    truncated: false,
    continuations: [],
  };
  const reads = recommendedReads([`documents/${safeSegment(document.id)}/document.md`]);
  const index = [
    `# Linear document context: ${document.title}`,
    "",
    `Target: ${input.target}`,
    `Document: ${document.id}`,
    `URL: ${document.url}`,
    "",
    "## Recommended files",
    "",
    ...recommendedList(reads),
    "",
  ].join("\n");
  const written = await writeWorkspaceContext({
    repoHash: input.config.repoHash,
    target: document.id,
    kind: "document",
    index,
    summary,
    manifest: summary,
    files,
    recommendedReads: reads,
    to: input.to,
  });

  return {
    target: input.target,
    kind: "document",
    ...input.selection,
    counts,
    completeness,
    omitted,
    truncated: false,
    continuations: [],
    ...written,
  };
}
