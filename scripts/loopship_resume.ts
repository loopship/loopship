const SUPERVISOR_DECISIONS = new Set(["ok", "rerun_step", "rerun_full"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOwn(source: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function objectField(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = source[key];
  return isPlainObject(value) ? value : {};
}

function templateLike(value: unknown): boolean {
  if (typeof value === "string") return value.includes("{{");
  if (Array.isArray(value)) return value.some((entry) => templateLike(entry));
  if (!isPlainObject(value)) return false;
  return Object.values(value).some((entry) => templateLike(entry));
}

function normalizeResponseEnvelope(value: unknown): {
  decision?: unknown;
  hasDecision: boolean;
  supervisorDecision?: string;
} {
  if (!isPlainObject(value)) {
    return { decision: value, hasDecision: true };
  }
  const response = isPlainObject(value.response) ? value.response : value;
  const normalized: {
    decision?: unknown;
    hasDecision: boolean;
    supervisorDecision?: string;
  } = { hasDecision: false };
  if (hasOwn(response, "answer")) {
    normalized.decision = response.answer;
    normalized.hasDecision = true;
  }
  if (hasOwn(response, "decision")) {
    if (typeof response.decision === "string" && SUPERVISOR_DECISIONS.has(response.decision)) {
      normalized.supervisorDecision = response.decision;
    } else if (!normalized.hasDecision) {
      normalized.decision = response.decision;
      normalized.hasDecision = true;
    }
  }
  if (!normalized.hasDecision && !normalized.supervisorDecision) {
    normalized.decision = response;
    normalized.hasDecision = true;
  }
  return normalized;
}

function applyResponseEnvelope(
  request: Record<string, unknown>,
  response: unknown,
): void {
  const normalized = normalizeResponseEnvelope(response);
  if (normalized.supervisorDecision) {
    request.supervisorDecision = normalized.supervisorDecision;
  }
  if (normalized.hasDecision) {
    request.response = { answer: normalized.decision };
  }
}

function applyLegacyDecision(
  request: Record<string, unknown>,
  decision: unknown,
): void {
  if (typeof decision === "string" && SUPERVISOR_DECISIONS.has(decision)) {
    request.supervisorDecision = decision;
    return;
  }
  request.response = { answer: decision };
}

export function nativeResumeRequest(
  value: Record<string, unknown>,
): Record<string, unknown> | null {
  const nextCall = objectField(value, "nextCall");
  const nextArgs = objectField(nextCall, "args");
  const source =
    isPlainObject(value.fastflow)
      ? value.fastflow
      : isPlainObject(value.resume)
        ? value.resume
        : Object.keys(nextArgs).length
          ? nextArgs
          : value;
  const sessionId = String(source.sessionId ?? source.session_id ?? "").trim();
  if (!sessionId) return null;
  const request: Record<string, unknown> = { sessionId };
  for (const field of ["nonce", "workspaceRoot", "executionName", "progressMode"]) {
    const fieldValue = source[field] ?? nextArgs[field];
    if (typeof fieldValue === "string" && fieldValue.trim()) {
      request[field] = fieldValue.trim();
    }
  }
  const supervisorDecision = source.supervisorDecision ?? value.supervisorDecision;
  if (supervisorDecision !== undefined) {
    request.supervisorDecision = supervisorDecision;
  }

  if (hasOwn(value, "response")) {
    applyResponseEnvelope(request, value.response);
    return request;
  }
  if (hasOwn(source, "response") && !templateLike(source.response)) {
    applyResponseEnvelope(request, source.response);
    return request;
  }
  if (hasOwn(value, "answer")) {
    request.response = { answer: value.answer };
    return request;
  }
  if (hasOwn(source, "answer")) {
    request.response = { answer: source.answer };
    return request;
  }
  const decision = hasOwn(value, "decision") ? value.decision : source.decision;
  if (decision !== undefined) {
    applyLegacyDecision(request, decision);
  }
  return request;
}
