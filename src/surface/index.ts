import { AGENT_SESSION_SURFACE_OPERATIONS } from "./agent-sessions.ts";
import { ATTACHMENT_SURFACE_OPERATIONS } from "./attachments.ts";
import { AUTH_SURFACE_OPERATIONS } from "./auth.ts";
import { CACHE_SURFACE_OPERATIONS } from "./cache.ts";
import { CLI_ONLY_SURFACE_OPERATIONS } from "./cli-only.ts";
import { COMMENT_SURFACE_OPERATIONS } from "./comments.ts";
import { CYCLES_SURFACE_OPERATIONS } from "./cycles.ts";
import { DOCUMENT_SURFACE_OPERATIONS } from "./documents.ts";
import { INITIATIVE_UPDATE_SURFACE_OPERATIONS } from "./initiative-updates.ts";
import { INITIATIVE_SURFACE_OPERATIONS } from "./initiatives.ts";
import { ISSUE_SURFACE_OPERATIONS } from "./issues.ts";
import { LABELS_SURFACE_OPERATIONS } from "./labels.ts";
import { LINK_SURFACE_OPERATIONS } from "./link.ts";
import { LINT_SURFACE_OPERATIONS } from "./lint.ts";
import { LOOKUPS_SURFACE_OPERATIONS } from "./lookups.ts";
import { MILESTONE_SURFACE_OPERATIONS } from "./milestones.ts";
import { PLAN_SURFACE_OPERATIONS } from "./plan.ts";
import { PROJECT_UPDATE_SURFACE_OPERATIONS } from "./project-updates.ts";
import { PROJECT_SURFACE_OPERATIONS } from "./projects.ts";
import { PUBLISH_SURFACE_OPERATIONS } from "./publish.ts";
import { PULL_SURFACE_OPERATIONS } from "./pull.ts";
import { RAW_SURFACE_OPERATIONS } from "./raw.ts";
import { RELATIONS_SURFACE_OPERATIONS } from "./relations.ts";
import { TEAMS_SURFACE_OPERATIONS } from "./teams.ts";
import { WORKSPACE_SURFACE_OPERATIONS } from "./workspace.ts";

export const SURFACE_OPERATIONS = [
  ...WORKSPACE_SURFACE_OPERATIONS,
  ...ISSUE_SURFACE_OPERATIONS,
  ...PROJECT_SURFACE_OPERATIONS,
  ...MILESTONE_SURFACE_OPERATIONS,
  ...PULL_SURFACE_OPERATIONS,
  ...PUBLISH_SURFACE_OPERATIONS,
  ...PLAN_SURFACE_OPERATIONS,
  ...ATTACHMENT_SURFACE_OPERATIONS,
  ...COMMENT_SURFACE_OPERATIONS,
  ...LABELS_SURFACE_OPERATIONS,
  ...CYCLES_SURFACE_OPERATIONS,
  ...AGENT_SESSION_SURFACE_OPERATIONS,
  ...TEAMS_SURFACE_OPERATIONS,
  ...LOOKUPS_SURFACE_OPERATIONS,
  ...DOCUMENT_SURFACE_OPERATIONS,
  ...PROJECT_UPDATE_SURFACE_OPERATIONS,
  ...INITIATIVE_SURFACE_OPERATIONS,
  ...INITIATIVE_UPDATE_SURFACE_OPERATIONS,
  ...RELATIONS_SURFACE_OPERATIONS,
  ...LINK_SURFACE_OPERATIONS,
  ...CACHE_SURFACE_OPERATIONS,
  ...AUTH_SURFACE_OPERATIONS,
  ...RAW_SURFACE_OPERATIONS,
  ...LINT_SURFACE_OPERATIONS,
  ...CLI_ONLY_SURFACE_OPERATIONS,
] as const;

export * from "./agent-sessions.ts";
export * from "./attachments.ts";
export * from "./auth.ts";
export * from "./cache.ts";
export * from "./cli-only.ts";
export * from "./comments.ts";
export * from "./contracts.ts";
export * from "./cycles.ts";
export * from "./deriveToolSurfaceManifest.ts";
export * from "./documents.ts";
export * from "./initiative-updates.ts";
export * from "./initiatives.ts";
export * from "./issues.ts";
export * from "./labels.ts";
export * from "./link.ts";
export * from "./lint.ts";
export * from "./lookups.ts";
export * from "./milestones.ts";
export * from "./plan.ts";
export * from "./project-updates.ts";
export * from "./projects.ts";
export * from "./publish.ts";
export * from "./pull.ts";
export * from "./raw.ts";
export * from "./relations.ts";
export * from "./teams.ts";
export * from "./workspace.ts";
