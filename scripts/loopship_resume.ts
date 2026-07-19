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

function exactResponseEnvelope(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error("Native Fastflow resume requires response with exactly one of answer or decision.");
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || (keys[0] !== "answer" && keys[0] !== "decision")) {
    throw new Error("Native Fastflow resume response must contain exactly one of answer or decision.");
  }
  if (keys[0] === "decision" && value.decision !== "ok") {
    throw new Error("Native Fastflow supervisor resume decision must be 'ok'.");
  }
  return { [keys[0]]: value[keys[0]] };
}

export function nativeResumeRequest(
  value: Record<string, unknown>,
): Record<string, unknown> | null {
  if (isPlainObject(value.fastflow) || isPlainObject(value.resume)) {
    throw new Error(
      "Native Fastflow resume compatibility wrappers are unsupported; submit the exact resume args object.",
    );
  }
  const nextCall = objectField(value, "nextCall");
  const nextArgs = objectField(nextCall, "args");
  const source = Object.keys(nextArgs).length ? nextArgs : value;
  const sessionId = String(source.sessionId ?? "").trim();
  if (!sessionId) return null;
  const nonce = String(source.nonce ?? nextArgs.nonce ?? "").trim();
  if (!nonce) {
    throw new Error("Native Fastflow resume requires the current pause nonce.");
  }
  const workspaceRoot = String(
    source.workspaceRoot ?? nextArgs.workspaceRoot ?? "",
  ).trim();
  const response = hasOwn(value, "response")
    ? value.response
    : source !== nextArgs && hasOwn(source, "response")
      ? source.response
      : undefined;
  if (response === undefined) {
    throw new Error("Native Fastflow resume requires a response envelope.");
  }
  return {
    sessionId,
    nonce,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    response: exactResponseEnvelope(response),
  };
}
