import { ValidationError } from "./errors.ts";

export function requireMutationSuccess(mutationName: string, payload: { success?: boolean }): void {
  if (payload.success !== true) {
    throw new ValidationError(
      `${mutationName} failed`,
      `Linear returned success:false for ${mutationName}`,
    );
  }
}

export function requireMutationEntity<T>(
  mutationName: string,
  payload: { success?: boolean } & Record<string, unknown>,
  entityKey: string,
): T {
  requireMutationSuccess(mutationName, payload);
  const entity = payload[entityKey];
  if (entity === null || entity === undefined) {
    throw new ValidationError(
      `${mutationName} did not return ${entityKey}`,
      `Linear returned success:true without ${entityKey}; retry after checking Linear state`,
    );
  }
  return entity as T;
}
