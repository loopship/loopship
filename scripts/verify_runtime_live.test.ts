import { describe, expect, it } from "bun:test";
import {
  cliInvocation,
  exitCodeForResults,
  matchProcessSkipReason,
  matchSkipReason,
} from "./verify_runtime_live.ts";

describe("verify_runtime_live", () => {
  it("classifies quota, auth, and unhealthy runtime output as skipped", () => {
    expect(matchSkipReason("HTTP 429 too many requests")).toBe(
      "quota_or_rate_limit",
    );
    expect(matchSkipReason("please sign in before continuing")).toBe(
      "authentication_required",
    );
    expect(matchSkipReason("service unavailable due to capacity limits")).toBe(
      "runtime_unhealthy",
    );
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
            primary_slug: null,
            latest_slug: null,
            stage: null,
            child_count: 0,
            merged_child_count: 0,
            unmerged_child_ids: [],
            plans: 0,
            validations: 0,
            reviews: 0,
            handoffs: 0,
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
          status: "failed",
          reason: "model_not_supported",
          duration_ms: 1,
          repo: "",
          log_path: "",
          quest: {
            primary_slug: null,
            latest_slug: null,
            stage: null,
            child_count: 0,
            merged_child_count: 0,
            unmerged_child_ids: [],
            plans: 0,
            validations: 0,
            reviews: 0,
            handoffs: 0,
            commit_count: 0,
            python_files: [],
          },
        },
      ]),
    ).toBe(1);
  });
});
