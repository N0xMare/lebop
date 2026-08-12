/**
 * Issue surface barrel — re-exports domain modules.
 * Prefer importing domain modules directly for new code when the boundary is clear.
 */
export * from "./issue-list.ts";
export * from "./issue-get.ts";
export * from "./issue-write.ts";
export * from "./issue-lifecycle.ts";

import { issueGetOperation } from "./issue-get.ts";
import {
  issueArchiveOperation,
  issueBulkUpdateOperation,
  issueUnarchiveOperation,
} from "./issue-lifecycle.ts";
import { issueListOperation, issueMineOperation } from "./issue-list.ts";
import { issueCreateOperation, issueUpdateOperation } from "./issue-write.ts";

export const ISSUE_SURFACE_OPERATIONS = [
  issueListOperation,
  issueMineOperation,
  issueGetOperation,
  issueCreateOperation,
  issueUpdateOperation,

  issueArchiveOperation,
  issueUnarchiveOperation,
  issueBulkUpdateOperation,
] as const;
