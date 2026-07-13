import { describe, expect, it } from "bun:test";
import {
  cliInvocation,
  exitCodeForResults,
  matchProcessSkipReason,
  matchSkipReason,
} from "./verify_runtime_live.ts";
import { nativeInitWtree, parseJsonObject } from "./runtime_supervisor.ts";

describe("verify_runtime_live", () => {
  it("rejects array output where a runtime object is required", () => {
    expect(() => parseJsonObject("[]", "runtime output")).toThrow(
      "expected JSON for runtime output",
    );
  });

  it("derives native init worktrees without a legacy new_quest command", () => {
    expect(
      nativeInitWtree(
        {
          nextCall: {
            args: {
              workspaceRoot: "/tmp/repo/worktrees/native-quest",
            },
          },
        },
        "/tmp/repo",
      ),
    ).toBe("native-quest");
    expect(() =>
      nativeInitWtree(
        {
          nextCall: {
            args: {
              workspaceRoot: "/tmp/escaped",
            },
          },
        },
        "/tmp/repo",
      ),
    ).toThrow("native init returned a non-canonical worktree");
  });

  it("classifies quota, auth, unhealthy runtimes, and unsupported models as skipped", () => {
    expect(matchSkipReason("HTTP 429 too many requests")).toBe(
      "quota_or_rate_limit",
    );
    expect(matchSkipReason("please sign in before continuing")).toBe(
      "authentication_required",
    );
    expect(matchSkipReason("service unavailable due to capacity limits")).toBe(
      "runtime_unhealthy",
    );
    expect(
      matchSkipReason("The requested model is not supported."),
    ).toBe("model_not_supported");
  });

  it("classifies timed out cli turns as skipped", () => {
    const error = Object.assign(new Error("spawnSync timed out"), {
      code: "ETIMEDOUT",
    });
    expect(
      matchProcessSkipReason({
        status: null,
        signal: "SIGTERM",
        error,
      }),
    ).toBe("runtime_timeout");
  });

  it("does not pin a model for copilot", () => {
    const invocation = cliInvocation(
      {
        root: "/tmp/root",
        repo: "/tmp/repo",
        env: {},
        runtime: "copilot",
      },
      "hello",
    );
    expect(invocation.cmd).toBe("copilot");
    expect(invocation.args).not.toContain("--model");
  });

  it("treats all-skipped live runs as non-failing", () => {
    expect(
      exitCodeForResults([
        {
          runtime: "codex",
          status: "skipped",
          reason: "quota_or_rate_limit",
          duration_ms: 1,
          repo: "",
          log_path: "",
          quest: {
            wtree: null,
            stage: null,
            child_count: 0,
            merged_child_count: 0,
            unmerged_child_ids: [],
            plan_events: 0,
            validation_events: 0,
            verification_events: 0,
            hook_decisions: 0,
            commit_count: 0,
            python_files: [],
          },
        },
      ]),
    ).toBe(0);
    expect(
      exitCodeForResults([
        {
          runtime: "gemini",
          status: "skipped",
          reason: "model_not_supported",
          duration_ms: 1,
          repo: "",
          log_path: "",
          quest: {
            wtree: null,
            stage: null,
            child_count: 0,
            merged_child_count: 0,
            unmerged_child_ids: [],
            plan_events: 0,
            validation_events: 0,
            verification_events: 0,
            hook_decisions: 0,
            commit_count: 0,
            python_files: [],
          },
        },
      ]),
    ).toBe(0);
  });
});
