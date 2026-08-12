/**
 * Coverage surfaces barrel (search, history, views, custom fields).
 * Domain implementations live in dedicated modules; this re-exports for
 * CLI/MCP adapters that historically imported from coverage.ts.
 */

export * from "./custom-fields.ts";
export * from "./history.ts";
export * from "./search.ts";
export * from "./views.ts";

import {
  customFieldGetIssueOperation,
  customFieldListOperation,
  customFieldSetIssueOperation,
} from "./custom-fields.ts";
import { issueHistoryListOperation } from "./history.ts";
import { searchLinearOperation } from "./search.ts";
import {
  viewCreateOperation,
  viewDeleteOperation,
  viewGetOperation,
  viewListOperation,
  viewMaterializeOperation,
  viewUpdateOperation,
} from "./views.ts";

export const COVERAGE_SURFACE_OPERATIONS = [
  searchLinearOperation,
  issueHistoryListOperation,
  viewListOperation,
  viewGetOperation,
  viewCreateOperation,
  viewUpdateOperation,
  viewDeleteOperation,
  viewMaterializeOperation,
  customFieldListOperation,
  customFieldGetIssueOperation,
  customFieldSetIssueOperation,
] as const;
