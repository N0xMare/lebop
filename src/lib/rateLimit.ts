import { AsyncLocalStorage } from "node:async_hooks";

export interface LinearRateLimitWindow {
  limit?: number;
  remaining?: number;
  reset_epoch_ms?: number;
  reset_at?: string;
}

export interface LinearEndpointRateLimitWindow extends LinearRateLimitWindow {
  name?: string;
}

export interface LinearComplexityLimitWindow extends LinearRateLimitWindow {
  used?: number;
}

export interface LinearRateLimitDetails {
  observed: boolean;
  request_budget?: LinearRateLimitWindow;
  endpoint_budget?: LinearEndpointRateLimitWindow;
  complexity_budget?: LinearComplexityLimitWindow;
  retry_after_seconds?: number;
  source?: "headers" | "sdk_error";
}

export interface LinearRateLimitTelemetry extends LinearRateLimitDetails {
  requests_made: number;
  workspaces: string[];
  last_observed_at?: string;
}

export interface LinearApiEnvelopeMeta {
  request_count: number;
  workspaces: string[];
  observed_at?: string;
  rate_limit: {
    requests?: LinearRateLimitWindow;
    endpoint?: LinearEndpointRateLimitWindow;
    complexity?: LinearComplexityLimitWindow;
  };
}

type HeaderBag =
  | Headers
  | { get(name: string): string | null | undefined }
  | Record<string, unknown>
  | undefined
  | null;

interface OperationContext {
  requestsMade: number;
  workspaces: Set<string>;
  lastObservedAt?: string;
  lastDetails?: LinearRateLimitDetails;
}

const operationContext = new AsyncLocalStorage<OperationContext>();

export async function collectLinearRateLimitTelemetry<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; telemetry: LinearRateLimitTelemetry }> {
  const context: OperationContext = {
    requestsMade: 0,
    workspaces: new Set<string>(),
  };
  const value = await operationContext.run(context, fn);
  return { value, telemetry: summarizeOperationContext(context) };
}

export function recordLinearApiAttempt(workspace: string): void {
  const context = operationContext.getStore();
  if (!context) return;
  context.requestsMade += 1;
  context.workspaces.add(workspace);
}

export function observeLinearRateLimitHeaders(workspace: string, headers: HeaderBag): void {
  const details = linearRateLimitDetailsFromHeaders(headers);
  if (!details) return;
  observeLinearRateLimitDetails(workspace, details);
}

export function observeLinearRateLimitError(workspace: string, err: unknown): void {
  const details = linearRateLimitDetailsFromError(err);
  if (!details) return;
  observeLinearRateLimitDetails(workspace, details);
}

export function linearApiEnvelopeMeta(
  telemetry: LinearRateLimitTelemetry,
): { linear_api: LinearApiEnvelopeMeta } | undefined {
  if (!telemetry.observed) return undefined;
  return {
    linear_api: {
      request_count: telemetry.requests_made,
      workspaces: telemetry.workspaces,
      ...(telemetry.last_observed_at ? { observed_at: telemetry.last_observed_at } : {}),
      rate_limit: {
        ...(telemetry.request_budget ? { requests: telemetry.request_budget } : {}),
        ...(telemetry.endpoint_budget ? { endpoint: telemetry.endpoint_budget } : {}),
        ...(telemetry.complexity_budget ? { complexity: telemetry.complexity_budget } : {}),
      },
    },
  };
}

export function linearRateLimitDetailsFromError(err: unknown): LinearRateLimitDetails | null {
  if (typeof err !== "object" || err === null) return null;
  const headers = extractHeadersFromError(err);
  const fromHeaders = linearRateLimitDetailsFromHeaders(headers);
  if (fromHeaders) return { ...fromHeaders, source: "headers" };

  const obj = err as Record<string, unknown>;
  const requestBudget = pickWindow({
    limit: numberField(obj, "requestsLimit"),
    remaining: numberField(obj, "requestsRemaining"),
    reset: numberField(obj, "requestsResetAt"),
  });
  const complexityBudget = pickWindow({
    limit: numberField(obj, "complexityLimit"),
    remaining: numberField(obj, "complexityRemaining"),
    reset: numberField(obj, "complexityResetAt"),
  });
  const retryAfter = numberField(obj, "retryAfter");
  if (!requestBudget && !complexityBudget && retryAfter === undefined) return null;
  return cleanDetails({
    observed: true,
    request_budget: requestBudget,
    complexity_budget: complexityBudget,
    retry_after_seconds: retryAfter,
    source: "sdk_error",
  });
}

export function linearRateLimitDetailsFromHeaders(
  headers: HeaderBag,
): LinearRateLimitDetails | null {
  if (!headers) return null;
  const requestBudget = pickWindow({
    limit: numberHeader(headers, "x-ratelimit-requests-limit"),
    remaining: numberHeader(headers, "x-ratelimit-requests-remaining"),
    reset: numberHeader(headers, "x-ratelimit-requests-reset"),
  });
  const endpointBudget = pickWindow({
    limit: numberHeader(headers, "x-ratelimit-endpoint-requests-limit"),
    remaining: numberHeader(headers, "x-ratelimit-endpoint-requests-remaining"),
    reset: numberHeader(headers, "x-ratelimit-endpoint-requests-reset"),
    name: stringHeader(headers, "x-ratelimit-endpoint-name"),
  });
  const complexityBudget = pickWindow({
    limit: numberHeader(headers, "x-ratelimit-complexity-limit"),
    remaining: numberHeader(headers, "x-ratelimit-complexity-remaining"),
    reset: numberHeader(headers, "x-ratelimit-complexity-reset"),
    used: numberHeader(headers, "x-complexity"),
  });
  const retryAfter = numberHeader(headers, "retry-after");
  if (!requestBudget && !endpointBudget && !complexityBudget && retryAfter === undefined) {
    return null;
  }
  return cleanDetails({
    observed: true,
    request_budget: requestBudget,
    endpoint_budget: endpointBudget,
    complexity_budget: complexityBudget,
    retry_after_seconds: retryAfter,
    source: "headers",
  });
}

export function rateLimitHint(details?: LinearRateLimitDetails): string {
  const resetAt =
    details?.request_budget?.reset_at ??
    details?.endpoint_budget?.reset_at ??
    details?.complexity_budget?.reset_at;
  const retryAfter = details?.retry_after_seconds;
  if (retryAfter !== undefined && resetAt) {
    return `retry after ${retryAfter}s or after ${resetAt}; reduce workspace scope, page size, or concurrency`;
  }
  if (retryAfter !== undefined) {
    return `retry after ${retryAfter}s; reduce workspace scope, page size, or concurrency`;
  }
  if (resetAt) {
    return `retry after ${resetAt}; reduce workspace scope, page size, or concurrency`;
  }
  return "wait a few seconds and retry, or reduce workspace scope, page size, or concurrency";
}

export function rateLimitRetryDelayMs(
  details: LinearRateLimitDetails | undefined,
  nowMs = Date.now(),
): number | undefined {
  if (!details) return undefined;
  if (details.retry_after_seconds !== undefined) {
    return Math.max(0, Math.ceil(details.retry_after_seconds * 1000));
  }

  const resetTimes = [
    resetDelayWhenExhausted(details.endpoint_budget, nowMs),
    resetDelayWhenExhausted(details.request_budget, nowMs),
    resetDelayWhenExhausted(details.complexity_budget, nowMs),
  ].filter((value): value is number => value !== undefined);
  if (resetTimes.length === 0) return undefined;
  return Math.max(...resetTimes);
}

function observeLinearRateLimitDetails(workspace: string, details: LinearRateLimitDetails): void {
  const observedAt = new Date().toISOString();
  const context = operationContext.getStore();
  if (context) {
    context.workspaces.add(workspace);
    context.lastObservedAt = observedAt;
    context.lastDetails = mergeDetails(context.lastDetails, details);
  }
}

function summarizeOperationContext(context: OperationContext): LinearRateLimitTelemetry {
  return {
    observed: context.lastDetails?.observed === true,
    requests_made: context.requestsMade,
    workspaces: Array.from(context.workspaces).sort(),
    ...(context.lastObservedAt ? { last_observed_at: context.lastObservedAt } : {}),
    ...(context.lastDetails?.request_budget
      ? { request_budget: context.lastDetails.request_budget }
      : {}),
    ...(context.lastDetails?.endpoint_budget
      ? { endpoint_budget: context.lastDetails.endpoint_budget }
      : {}),
    ...(context.lastDetails?.complexity_budget
      ? { complexity_budget: context.lastDetails.complexity_budget }
      : {}),
    ...(context.lastDetails?.retry_after_seconds !== undefined
      ? { retry_after_seconds: context.lastDetails.retry_after_seconds }
      : {}),
  };
}

function mergeDetails(
  previous: LinearRateLimitDetails | LinearRateLimitTelemetry | undefined,
  next: LinearRateLimitDetails,
): LinearRateLimitDetails {
  return cleanDetails({
    observed: previous?.observed === true || next.observed === true,
    request_budget: next.request_budget ?? previous?.request_budget,
    endpoint_budget: next.endpoint_budget ?? previous?.endpoint_budget,
    complexity_budget: next.complexity_budget ?? previous?.complexity_budget,
    retry_after_seconds: next.retry_after_seconds ?? previous?.retry_after_seconds,
    source: next.source ?? previous?.source,
  });
}

function cleanDetails(details: LinearRateLimitDetails): LinearRateLimitDetails {
  return {
    observed: details.observed,
    ...(details.request_budget ? { request_budget: details.request_budget } : {}),
    ...(details.endpoint_budget ? { endpoint_budget: details.endpoint_budget } : {}),
    ...(details.complexity_budget ? { complexity_budget: details.complexity_budget } : {}),
    ...(details.retry_after_seconds !== undefined
      ? { retry_after_seconds: details.retry_after_seconds }
      : {}),
    ...(details.source ? { source: details.source } : {}),
  };
}

function pickWindow(input: {
  limit?: number;
  remaining?: number;
  reset?: number;
  name?: string;
  used?: number;
}): (LinearRateLimitWindow & { name?: string; used?: number }) | undefined {
  if (
    input.limit === undefined &&
    input.remaining === undefined &&
    input.reset === undefined &&
    input.name === undefined &&
    input.used === undefined
  ) {
    return undefined;
  }
  return {
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.remaining !== undefined ? { remaining: input.remaining } : {}),
    ...(input.reset !== undefined
      ? { reset_epoch_ms: input.reset, reset_at: new Date(input.reset).toISOString() }
      : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.used !== undefined ? { used: input.used } : {}),
  };
}

function extractHeadersFromError(err: unknown): HeaderBag {
  if (typeof err !== "object" || err === null) return null;
  const obj = err as Record<string, unknown>;
  const response = obj.response as Record<string, unknown> | undefined;
  if (response?.headers) return response.headers as HeaderBag;
  const raw = obj.raw as Record<string, unknown> | undefined;
  const rawResponse = raw?.response as Record<string, unknown> | undefined;
  if (rawResponse?.headers) return rawResponse.headers as HeaderBag;
  if (obj.headers) return obj.headers as HeaderBag;
  return null;
}

function numberField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return parseNumber(value);
  return undefined;
}

function numberHeader(headers: HeaderBag, name: string): number | undefined {
  const value = stringHeader(headers, name);
  return value === undefined ? undefined : parseNumber(value);
}

function stringHeader(headers: HeaderBag, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(name: string): string | null | undefined }).get(name);
    return value === null || value === undefined || value === "" ? undefined : value;
  }

  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== lower) continue;
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function parseNumber(value: string): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function resetDelayWhenExhausted(
  window: LinearRateLimitWindow | undefined,
  nowMs: number,
): number | undefined {
  if (!window?.reset_epoch_ms) return undefined;
  if (window.remaining !== undefined && window.remaining > 0) return undefined;
  return Math.max(0, window.reset_epoch_ms - nowMs + 250);
}
