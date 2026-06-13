export interface BehaviorContractError {
  contract: string;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

export function validatePublishPayloadContract(payload: unknown): BehaviorContractError[] {
  if (!isRecord(payload)) return [];
  const errors: BehaviorContractError[] = [];
  const summary = isRecord(payload.summary) ? payload.summary : null;
  const ready = summary?.ready;
  const status = payload.status;

  if (status === "verified" && ready === false) {
    errors.push({
      contract: "publish.no_verified_when_not_ready",
      message: "publish result cannot be status=verified when summary.ready=false",
    });
  }
  if (status === "published_unverified" && ready === false) {
    errors.push({
      contract: "publish.no_unverified_success_when_not_ready",
      message: "publish result cannot be status=published_unverified when summary.ready=false",
    });
  }
  if (status === "blocked" && ready === true) {
    errors.push({
      contract: "publish.blocked_requires_not_ready",
      message: "publish result cannot be status=blocked when summary.ready=true",
    });
  }
  if ((status === "verified" || status === "published_unverified") && payload.result === null) {
    errors.push({
      contract: "publish.success_requires_result",
      message: "successful publish statuses must include a non-null result payload",
    });
  }
  return errors;
}

export function validateExplorePayloadContract(payload: unknown): BehaviorContractError[] {
  if (!isRecord(payload)) return [];
  const errors: BehaviorContractError[] = [];
  const page = isRecord(payload.page) ? payload.page : null;
  const bounded = isRecord(page?.bounded) ? page.bounded : null;

  if (bounded?.may_have_more === true && payload.truncated !== true) {
    errors.push({
      contract: "explore.capped_results_are_truncated",
      message: "bounded explore results with may_have_more=true must set truncated=true",
    });
  }
  if (bounded?.may_have_more === true && bounded.continuation !== "cursor") {
    if (bounded.continuation !== "not_available") {
      errors.push({
        contract: "explore.truncation_continuation_marker",
        message: "bounded non-cursor explore truncation must declare continuation=not_available",
      });
    }
  }
  if (payload.has_more === true && typeof payload.next_cursor !== "string") {
    errors.push({
      contract: "explore.has_more_requires_cursor",
      message: "cursor-backed explore results must return next_cursor when has_more=true",
    });
  }
  return errors;
}

export function validateFetchPayloadContract(payload: unknown): BehaviorContractError[] {
  if (!isRecord(payload)) return [];
  const errors: BehaviorContractError[] = [];
  const completeness = isRecord(payload.completeness) ? payload.completeness : {};
  const continuations = Array.isArray(payload.continuations) ? payload.continuations : [];

  for (const [key, value] of Object.entries(completeness)) {
    if (!isRecord(value) || value.truncated !== true) continue;
    const hasContinuation = continuations.some((continuation) => {
      if (!isRecord(continuation)) return false;
      const args = isRecord(continuation.args) ? continuation.args : {};
      return (
        typeof continuation.reason === "string" &&
        continuation.reason.includes(key) &&
        (typeof args.path === "string" || typeof args.target === "string")
      );
    });
    const reason = typeof value.reason === "string" ? value.reason : "";
    const unavailable = reason.includes("not_available") || reason.includes("may_have_more");
    if (!hasContinuation && !unavailable) {
      errors.push({
        contract: "fetch.truncation_requires_continuation",
        message: `fetch completeness entry ${key} is truncated without an actionable continuation or unavailable marker`,
      });
    }
  }
  return errors;
}

export function validateJsonErrorEnvelopeContract(payload: unknown): BehaviorContractError[] {
  if (!isRecord(payload) || payload.ok !== false) return [];
  const errors: BehaviorContractError[] = [];
  const error = isRecord(payload.error) ? payload.error : null;
  if (payload.schema_version !== 1 || !error || typeof error.code !== "string") {
    errors.push({
      contract: "cli_json_errors.use_envelope",
      message: "--json failures must emit {ok:false,schema_version:1,error:{code,message}}",
    });
  }
  return errors;
}

export function validateDestructiveMcpArgsContract(
  toolName: string,
  args: unknown,
  confirmRequiredTools: readonly string[],
): BehaviorContractError[] {
  if (!confirmRequiredTools.includes(toolName)) return [];
  if (isRecord(args) && args.confirm === true) return [];
  return [
    {
      contract: "mcp_destructive.confirm_true_required",
      message: `${toolName} requires confirm:true for destructive execution`,
    },
  ];
}

export function validateLebopPayloadContracts(
  kind: string,
  payload: unknown,
): BehaviorContractError[] {
  if (kind === "publish") return validatePublishPayloadContract(payload);
  if (kind === "explore") return validateExplorePayloadContract(payload);
  if (kind === "fetch") return validateFetchPayloadContract(payload);
  if (kind === "json_error") return validateJsonErrorEnvelopeContract(payload);
  return [];
}

export function semanticProofs(labels: string[]): string[] {
  return [...new Set(labels.filter((label) => label.trim() !== ""))];
}

export function assertSemanticProofs(name: string, proofs: unknown): void {
  if (!hasNonEmptyArray(proofs)) {
    throw new Error(`${name} did not record semantic assertions`);
  }
}
