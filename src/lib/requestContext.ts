import { AsyncLocalStorage } from "node:async_hooks";

export interface LebopRequestContext {
  workspace?: string;
  team?: string;
}

const requestContext = new AsyncLocalStorage<LebopRequestContext>();

export function runWithRequestContext<T>(context: LebopRequestContext, fn: () => T): T {
  return requestContext.run(context, fn);
}

export function activeWorkspaceOverride(): string | undefined {
  return requestContext.getStore()?.workspace;
}

export function activeTeamOverride(): string | undefined {
  return requestContext.getStore()?.team;
}

export function setRequestOverrides(overrides: LebopRequestContext): void {
  const store = requestContext.getStore();
  if (!store) return;
  if (overrides.workspace !== undefined) store.workspace = overrides.workspace;
  if (overrides.team !== undefined) store.team = overrides.team;
}
