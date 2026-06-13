import { type ZodType, z } from "zod";
import { ValidationError } from "../lib/errors.ts";

export const workspaceArg = z.string().optional();
export const teamArg = z.string().optional();
export const repoRootArg = z.string().optional();

export function boundedInt(max: number) {
  return z.number().int().min(1).max(max).optional();
}

export function parseSurfaceInput<T>(operationId: string, schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;

  const summary = parsed.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  throw new ValidationError(
    `invalid ${operationId} input${summary ? `: ${summary}` : ""}`,
    "check the command/tool arguments and retry with values that match the operation contract",
  );
}
