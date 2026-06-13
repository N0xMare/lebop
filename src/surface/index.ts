import { ISSUE_SURFACE_OPERATIONS } from "./issues.ts";
import { PROJECT_SURFACE_OPERATIONS } from "./projects.ts";
import { PUBLISH_SURFACE_OPERATIONS } from "./publish.ts";
import { PULL_SURFACE_OPERATIONS } from "./pull.ts";
import { WORKSPACE_SURFACE_OPERATIONS } from "./workspace.ts";

export const SURFACE_OPERATIONS = [
  ...WORKSPACE_SURFACE_OPERATIONS,
  ...ISSUE_SURFACE_OPERATIONS,
  ...PROJECT_SURFACE_OPERATIONS,
  ...PULL_SURFACE_OPERATIONS,
  ...PUBLISH_SURFACE_OPERATIONS,
] as const;

export * from "./contracts.ts";
export * from "./issues.ts";
export * from "./projects.ts";
export * from "./publish.ts";
export * from "./pull.ts";
export * from "./workspace.ts";
