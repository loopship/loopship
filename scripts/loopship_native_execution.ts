import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { digestNativeContract, type JsonValue } from "@cueintent/fastflow";
import {
  acquireCrashSafeFileLock,
  writeJsonExclusively as writeJsonExclusivelyShared,
  writeText,
} from "./loopship_utils.ts";

const LOOPSHIP_RUNTIME_NAMESPACE = ".loopship/runtime";
const NATIVE_EXECUTION_LOCK_WAIT_MS = 5_000;

export type LoopshipNativeExecutionRequest = {
  schemaVersion: "loopship.native-execution-request/v1";
  status: "pending" | "completed";
  questInstanceId: string;
  ordinal: number;
  executionId: string;
  idempotencyKey: string;
  canonicalRequestDigest: string;
  requestDigest: string;
  request: Record<string, unknown>;
};

export function resolveLoopshipNativeExecutionRequest(
  workspaceRoot: string,
  request: Record<string, unknown>,
  options: {
    expectedExecutionId?: string;
    expectedStatus?: "pending" | "completed";
  } = {},
): LoopshipNativeExecutionRequest {
  return withNativeExecutionLock(workspaceRoot, () => {
    const normalized = requestWithoutIdentity(request);
    const path = requestPath(workspaceRoot);
    const existing = existsSync(path)
      ? readLoopshipNativeExecutionRequest(workspaceRoot)
      : null;
    if (options.expectedExecutionId || options.expectedStatus) {
      if (
        !options.expectedExecutionId ||
        !options.expectedStatus ||
        existing?.status !== options.expectedStatus ||
        existing.executionId !== options.expectedExecutionId
      ) {
        throw new Error(
          `Native recovery snapshot ${options.expectedExecutionId || "<missing>"}/${options.expectedStatus || "<missing>"} is no longer the current ledger`,
        );
      }
      if (!requestsMatch(existing.request, normalized)) {
        throw new Error(`Loopship Native execution request conflicts with pending ${path}`);
      }
      if (existing.status === "pending") return existing;
    }
    if (existing?.status === "pending") {
      if (!requestsMatch(existing.request, normalized)) {
        throw new Error(`Loopship Native execution request conflicts with pending ${path}`);
      }
      return existing;
    }
    if (!existing) {
      const tasksPath = resolve(workspaceRoot, LOOPSHIP_RUNTIME_NAMESPACE, "tasks.yaml");
      if (existsSync(tasksPath)) {
        throw legacyExecutionUnsupported(
          `quest state has no Native v1 execution ledger at ${path}; resubmit it as a new Native execution`,
        );
      }
    } else {
      archiveRequest(workspaceRoot, existing);
    }
    const canonicalRequestDigest = digestNativeContract(normalized as unknown as JsonValue);
    const questInstanceId = existing?.questInstanceId ||
      `loopship-quest-${sha256(randomUUID()).slice("sha256:".length)}`;
    const ordinal = (existing?.ordinal || 0) + 1;
    const identity = createExecutionIdentity({
      questInstanceId,
      ordinal,
      canonicalRequestDigest,
    });
    const nativeRequest = { ...normalized, ...identity };
    const envelope: LoopshipNativeExecutionRequest = {
      schemaVersion: "loopship.native-execution-request/v1",
      status: "pending",
      questInstanceId,
      ordinal,
      ...identity,
      canonicalRequestDigest,
      requestDigest: digestNativeContract(nativeRequest as unknown as JsonValue),
      request: nativeRequest,
    };
    writeJsonAtomically(path, envelope);
    return envelope;
  });
}

export function readLoopshipNativeExecutionRequest(
  workspaceRoot: string,
): LoopshipNativeExecutionRequest {
  const path = requestPath(workspaceRoot);
  if (!existsSync(path)) {
    throw legacyExecutionUnsupported(
      `quest state has no Native v1 execution request at ${path}; resubmit it as a new Native execution`,
    );
  }
  const envelope = parseRequest(path);
  const receiptPath = historyPath(workspaceRoot, envelope.executionId);
  if (!existsSync(receiptPath)) {
    if (envelope.status === "completed") {
      throw new Error(
        `Native execution request integrity check failed: completed ledger has no immutable history receipt at ${receiptPath}`,
      );
    }
    return envelope;
  }
  const receipt = parseRequest(receiptPath);
  const completedEnvelope = { ...envelope, status: "completed" as const };
  const expectedReceiptDigest = digestNativeContract(
    completedEnvelope as unknown as JsonValue,
  );
  const receiptDigest = digestNativeContract(receipt as unknown as JsonValue);
  if (receipt.status !== "completed" || receiptDigest !== expectedReceiptDigest) {
    throw new Error(
      `Native execution request integrity check failed: current ledger conflicts with ${receiptPath}`,
    );
  }
  return receipt;
}

export function markLoopshipNativeExecutionCompleted(
  workspaceRoot: string,
  executionId: string,
): void {
  if (!existsSync(requestPath(workspaceRoot))) {
    const tasksPath = resolve(workspaceRoot, LOOPSHIP_RUNTIME_NAMESPACE, "tasks.yaml");
    if (!existsSync(tasksPath)) return;
  }
  withNativeExecutionLock(workspaceRoot, () => {
    const current = readLoopshipNativeExecutionRequest(workspaceRoot);
    if (current.executionId !== executionId) {
      throw new Error(
        `Native execution completion ${executionId} does not match current ${current.executionId}`,
      );
    }
    if (current.status === "completed") return;
    const completed: LoopshipNativeExecutionRequest = {
      ...current,
      status: "completed",
    };
    archiveRequest(workspaceRoot, completed);
    writeJsonAtomically(requestPath(workspaceRoot), completed);
  });
}

export function loopshipNativeResultIsTerminal(
  result: Record<string, unknown>,
  executionId?: string,
): boolean {
  const workflowArtifact =
    result.schemaVersion === "fastflow/workflow-run-artifact/v1" &&
    result.kind === "workflow_result" &&
    (result.status === "completed" || result.status === "failed");
  const recoveredTerminal =
    Boolean(executionId) &&
    result.executionId === executionId &&
    result.ok === false &&
    (result.status === "failed" || result.status === "cancelled");
  return workflowArtifact || recoveredTerminal;
}

function createExecutionIdentity(input: {
  questInstanceId: string;
  ordinal: number;
  canonicalRequestDigest: string;
}): { executionId: string; idempotencyKey: string } {
  const identity = sha256(JSON.stringify({
    schemaVersion: "loopship.native-execution-identity/v1",
    ...input,
  })).slice("sha256:".length);
  const executionId = `loopship-${identity}`;
  return { executionId, idempotencyKey: executionId };
}

function requestPath(workspaceRoot: string): string {
  return resolve(workspaceRoot, LOOPSHIP_RUNTIME_NAMESPACE, "native-execution.json");
}

function historyPath(workspaceRoot: string, executionId: string): string {
  return resolve(
    workspaceRoot,
    LOOPSHIP_RUNTIME_NAMESPACE,
    "native-executions",
    `${executionId}.json`,
  );
}

function lockPath(workspaceRoot: string): string {
  return resolve(workspaceRoot, LOOPSHIP_RUNTIME_NAMESPACE, "native-execution.lock.sqlite");
}

function requestWithoutIdentity(request: Record<string, unknown>): Record<string, unknown> {
  const normalized = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
  delete normalized.executionId;
  delete normalized.idempotencyKey;
  return normalized;
}

function requestsMatch(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return (
    digestNativeContract(requestWithoutIdentity(left) as unknown as JsonValue) ===
    digestNativeContract(requestWithoutIdentity(right) as unknown as JsonValue)
  );
}

function withNativeExecutionLock<T>(workspaceRoot: string, operation: () => T): T {
  const path = lockPath(workspaceRoot);
  let release: (() => void) | null = null;
  try {
    release = acquireCrashSafeFileLock(path, NATIVE_EXECUTION_LOCK_WAIT_MS);
  } catch (error) {
    if ((error as { code?: string }).code === "loopship_file_lock_busy") {
      throw new Error(`Loopship Native execution request update already in progress: ${path}`);
    }
    throw error;
  }
  try {
    return operation();
  } finally {
    release();
  }
}

function archiveRequest(
  workspaceRoot: string,
  envelope: LoopshipNativeExecutionRequest,
): void {
  if (envelope.status !== "completed") return;
  const path = historyPath(workspaceRoot, envelope.executionId);
  if (writeJsonExclusively(path, envelope)) return;
  const existing = parseRequest(path);
  if (existing.requestDigest !== envelope.requestDigest || existing.status !== "completed") {
    throw new Error(`Loopship Native execution history conflicts with ${path}`);
  }
}

function parseRequest(path: string): LoopshipNativeExecutionRequest {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isPlainObject(parsed) ||
    parsed.schemaVersion !== "loopship.native-execution-request/v1" ||
    !["pending", "completed"].includes(String(parsed.status)) ||
    !Number.isInteger(parsed.ordinal) ||
    !isPlainObject(parsed.request)
  ) {
    throw legacyExecutionUnsupported(
      `unsupported Native execution request at ${path}; resubmit it as a new Native execution`,
    );
  }
  const envelope = parsed as LoopshipNativeExecutionRequest;
  const requestDigest = digestNativeContract(envelope.request as unknown as JsonValue);
  const canonicalRequestDigest = digestNativeContract(
    requestWithoutIdentity(envelope.request) as unknown as JsonValue,
  );
  const expectedIdentity = createExecutionIdentity({
    questInstanceId: envelope.questInstanceId,
    ordinal: envelope.ordinal,
    canonicalRequestDigest,
  });
  if (
    !/^loopship-quest-[0-9a-f]{64}$/u.test(String(envelope.questInstanceId)) ||
    envelope.ordinal < 1 ||
    !/^loopship-[0-9a-f]{64}$/u.test(String(envelope.executionId)) ||
    envelope.executionId !== expectedIdentity.executionId ||
    envelope.idempotencyKey !== expectedIdentity.idempotencyKey ||
    envelope.idempotencyKey !== envelope.executionId ||
    requireString(envelope.executionId, "native executionId") !==
      requireString(envelope.request.executionId, "native request.executionId") ||
    requireString(envelope.idempotencyKey, "native idempotencyKey") !==
      requireString(envelope.request.idempotencyKey, "native request.idempotencyKey") ||
    envelope.canonicalRequestDigest !== canonicalRequestDigest ||
    envelope.requestDigest !== requestDigest
  ) {
    throw new Error(`Native execution request integrity check failed: ${path}`);
  }
  return envelope;
}

function writeJsonAtomically(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value)}\n`);
}

function writeJsonExclusively(path: string, value: unknown): boolean {
  return writeJsonExclusivelyShared(path, value);
}

function legacyExecutionUnsupported(message: string): Error {
  return Object.assign(
    new Error(`legacy_execution_unsupported: ${message}`),
    { code: "legacy_execution_unsupported" },
  );
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
