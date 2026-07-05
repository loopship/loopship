export type StepperPlanPayload = {
  classification: "greenfield_app";
  scope: string;
  summary: string;
  high_impact_unknowns?: string[];
  defaulted_unknowns?: string[];
  assumptions?: string[];
  constraints?: string[];
  questions?: Array<{
    id: string;
    question: string;
    impact: string;
    default?: string;
    options?: Array<{
      label: string;
      description: string;
    }>;
  }>;
  system_context?: Record<string, unknown>;
  verification_targets: string[];
  tasks: Array<Record<string, unknown>>;
};

const EMPTY_SYSTEM_CONTEXT = {
  relevant_object_refs: [],
  relevant_assertion_refs: [],
  relevant_resource_refs: [],
  relevant_memory_refs: [],
  durable_implications: [],
};

export type StepperProductQuestScenario = {
  id: string;
  initial_plan: StepperPlanPayload;
  resolved_plan: StepperPlanPayload | null;
  answers: Array<{
    question_id: string;
    answer: string;
  }>;
  validation_checks: Array<{
    name: string;
    status: "passed";
  }>;
  system_summary: string;
  landing_summary: string;
  expect_question_round: boolean;
};

export type StepperQuestLikeState = Partial<{
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    dependencies: string[];
    scope_files: string[];
    child_wtree: string;
    acceptance: string;
  }>;
}>;

const CHILD_DONE_STATUSES = new Set([
  "child_archived",
  "child_merged",
  "done",
  "merged",
]);

function normalizedRequest(request: string): string {
  return request.replace(/^loopship:\s*/i, "").trim().toLowerCase();
}

function isConcretePythonCliRequest(request: string): boolean {
  const normalized = normalizedRequest(request);
  return (
    normalized.includes("tiny python cli") &&
    normalized.includes("argparse") &&
    normalized.includes("--name") &&
    normalized.includes("pytest")
  );
}

function isConcreteReactHabitTrackerRequest(request: string): boolean {
  const normalized = normalizedRequest(request);
  return (
    normalized.includes("react") &&
    normalized.includes("habit") &&
    (normalized.includes("typescript") || normalized.includes("ts"))
  );
}

export const CONCRETE_PYTHON_CLI_REQUEST =
  "loopship: build a tiny python cli named greet using argparse. Accept a required --name flag, print exactly 'hello, <name>!', add one pytest test, keep files minimal, and finish the full lifecycle without asking questions unless a safety-critical ambiguity blocks progress.";

export const CONCRETE_REACT_HABIT_TRACKER_REQUEST =
  "loopship: build a sample React habit tracker using React with TypeScript, keep it single-user and local-first, no auth, responsive UI, and basic tests";

export function selectStepperProductQuestScenario(
  request: string,
): StepperProductQuestScenario {
  if (isConcretePythonCliRequest(request)) {
    return {
      id: "concrete-python-cli",
      initial_plan: {
        classification: "greenfield_app",
        scope:
          "Build a tiny Python CLI named greet that accepts a required --name flag and prints exactly `hello, <name>!` with one pytest check.",
        summary:
          "The request is already concrete, so the MVP can be delivered in one bounded implementation task without a clarification round.",
        defaulted_unknowns: [
          "Use a flat minimal layout with one CLI module and one pytest file.",
        ],
        assumptions: [
          "The requested greeting output is the full product contract for the MVP.",
        ],
        constraints: [
          "Use Python and argparse.",
          "Accept a required --name flag.",
          "Print exactly `hello, <name>!`.",
          "Add one pytest test.",
          "Keep files minimal.",
        ],
        system_context: EMPTY_SYSTEM_CONTEXT,
        verification_targets: [
          "Running the CLI with --name prints the exact greeting.",
          "One pytest test passes.",
          "The lifecycle reaches archive without a clarification round.",
        ],
        tasks: [
          {
            id: "T001",
            title: "Build the tiny greet CLI and its pytest coverage",
            type: "coding",
            acceptance: [
              "The greet CLI accepts --name and prints the exact greeting.",
              "One pytest test covers the CLI behavior.",
            ],
            scope_files: ["greet.py", "tests/test_greet.py", "README.md"],
          },
        ],
      },
      resolved_plan: null,
      answers: [],
      validation_checks: [
        { name: "simulated-pytest", status: "passed" },
        { name: "simulated-cli-smoke", status: "passed" },
      ],
      system_summary: "simulated tiny Python CLI lifecycle completed end to end",
      landing_summary: "simulated tiny Python CLI landed the quest",
      expect_question_round: false,
    };
  }

  if (isConcreteReactHabitTrackerRequest(request)) {
    return {
      id: "concrete-react-habit-tracker",
      initial_plan: {
        classification: "greenfield_app",
        scope:
          "Build a single-user local-first React + TypeScript habit tracker with a responsive UI and basic tests.",
        summary:
          "The request already constrains the product surface, so the simulator should default the remaining low-risk UX details and decompose directly.",
        defaulted_unknowns: [
          "Default the MVP to simple daily checkoffs with lightweight streak summaries.",
          "Persist state in browser localStorage for the local-first MVP.",
        ],
        assumptions: [
          "A single-page browser UI is sufficient for the first version.",
        ],
        constraints: [
          "Use React with TypeScript.",
          "Keep it single-user and local-first.",
          "Do not add auth.",
          "Ship a responsive UI.",
          "Include basic tests.",
        ],
        system_context: EMPTY_SYSTEM_CONTEXT,
        verification_targets: [
          "The React habit tracker renders as a responsive single-page UI.",
          "Habit data persists locally across reloads.",
          "Basic test coverage validates the core habit flow.",
          "The lifecycle reaches archive without a clarification round.",
        ],
        tasks: [
          {
            id: "T001",
            title: "Build the React habit tracker MVP",
            type: "coding",
            acceptance: [
              "Users can create and complete habits in a responsive single-page UI.",
              "Habit state persists locally for repeat visits.",
              "Basic automated tests cover the core habit flow.",
            ],
            scope_files: ["package.json", "src/**", "README.md"],
          },
        ],
      },
      resolved_plan: null,
      answers: [],
      validation_checks: [
        { name: "simulated-vitest", status: "passed" },
        { name: "simulated-react-smoke", status: "passed" },
      ],
      system_summary:
        "simulated React habit tracker lifecycle completed end to end",
      landing_summary: "simulated React habit tracker landed the quest",
      expect_question_round: false,
    };
  }

  return {
    id: "generic-greenfield",
    initial_plan: {
      classification: "greenfield_app",
      scope:
        "Generic greenfield product request that requires clarification before decomposition.",
      summary:
        "Ask one grouped clarification round before turning the request into a concrete MVP plan.",
      high_impact_unknowns: [
        "primary app purpose",
        "delivery surface",
        "core persistence model",
      ],
      questions: [
        {
          id: "app_purpose",
          question: "What is the primary purpose of the app?",
          impact: "Changes the domain model and the MVP acceptance target.",
          default: "Task tracker",
          options: [
            {
              label: "Task tracker",
              description: "Small-team task tracking with CRUD workflows.",
            },
            {
              label: "Dashboard",
              description: "Operational dashboard with summary views.",
            },
            {
              label: "Internal tool",
              description: "Workflow-specific tool with custom actions.",
            },
          ],
        },
      ],
      assumptions: [
        "The prompt is still product-defining and does not settle the MVP surface.",
      ],
      system_context: EMPTY_SYSTEM_CONTEXT,
      verification_targets: [
        "The first clarification round resolves the missing product definition.",
      ],
      tasks: [],
    },
    resolved_plan: {
      classification: "greenfield_app",
      scope:
        "Build a full-stack task tracker for small teams with a React frontend, an Express backend, and SQLite persistence.",
      summary: "Implement the MVP task tracker in one bounded child task.",
      defaulted_unknowns: ["No auth for MVP", "Simple list UI"],
      assumptions: ["All team members share the same permissions."],
      constraints: ["Use React, Express, and SQLite."],
      system_context: EMPTY_SYSTEM_CONTEXT,
      verification_targets: ["Production build succeeds."],
      tasks: [
        {
          id: "T001",
          title: "Build the MVP task tracker",
          type: "coding",
          acceptance: ["The MVP app builds successfully."],
          scope_files: ["client/**", "server/**"],
        },
      ],
    },
    answers: [
      {
        question_id: "app_purpose",
        answer: "Build a task tracker for small teams.",
      },
    ],
    validation_checks: [{ name: "simulated-build", status: "passed" }],
    system_summary: "simulated generic greenfield lifecycle completed end to end",
    landing_summary: "simulated generic greenfield quest landed successfully",
    expect_question_round: true,
  };
}

function scenarioPlanPayload(plan: StepperPlanPayload): Record<string, unknown> {
  return {
    classification: plan.classification,
    scope: plan.scope,
    summary: plan.summary,
    ...(plan.high_impact_unknowns?.length
      ? { high_impact_unknowns: plan.high_impact_unknowns }
      : {}),
    ...(plan.defaulted_unknowns?.length
      ? { defaulted_unknowns: plan.defaulted_unknowns }
      : {}),
    ...(plan.assumptions?.length ? { assumptions: plan.assumptions } : {}),
    ...(plan.constraints?.length ? { constraints: plan.constraints } : {}),
    ...(plan.questions?.length ? { questions: plan.questions } : {}),
    system_context: plan.system_context ?? EMPTY_SYSTEM_CONTEXT,
    verification_targets: plan.verification_targets,
    ...(plan.questions?.length ? {} : { task_graph: { tasks: plan.tasks } }),
  };
}

function readyTask(quest: StepperQuestLikeState) {
  const tasks = Array.isArray(quest.tasks) ? quest.tasks : [];
  const done = new Set(
    tasks
      .filter((task) => CHILD_DONE_STATUSES.has(String(task.status ?? "")))
      .map((task) => String(task.id)),
  );
  return (
    tasks.find((task) => {
      const status = String(task.status ?? "child_received");
      if (!["child_received", "pending", "ready"].includes(status)) {
        return false;
      }
      const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
      return deps.every((dep) => done.has(String(dep)));
    }) ?? null
  );
}

export function scenarioPayloadForStep(input: {
  request: string;
  step: string;
  quest: StepperQuestLikeState;
  planRound: number;
  landingRound: number;
}): Record<string, unknown> {
  const scenario = selectStepperProductQuestScenario(input.request);
  switch (input.step) {
    case "plan":
      return scenarioPlanPayload(
        input.planRound === 0 || !scenario.resolved_plan
          ? scenario.initial_plan
          : scenario.resolved_plan,
      );
    case "questions":
      if (!scenario.answers.length) {
        throw new Error(`scenario ${scenario.id} has no recorded answers`);
      }
      return {
        answers: scenario.answers,
      };
    case "task_graph":
      return { approved: true };
    case "executing": {
      const task = readyTask(input.quest);
      if (!task) {
        throw new Error(`scenario ${scenario.id} has no ready task to report`);
      }
      return {
        children: [
          {
            task_id: task.id,
            title: task.title,
            child_wtree: task.child_wtree,
            branch_ref: task.branch_ref,
            worktree_path: task.worktree_path,
            acceptance: task.acceptance,
          },
        ],
      };
    }
    case "child_result": {
      const task = readyTask(input.quest);
      if (!task) {
        throw new Error(`scenario ${scenario.id} has no ready task to report`);
      }
      return {
        task_id: task.id,
        child_wtree: task.child_wtree,
        status: "passed",
        evidence: [
          {
            type: "summary",
            ref: task.scope_files[0] || `${task.id}.txt`,
            summary: `${task.title} simulated successfully`,
          },
        ],
        merge_commit: `stepper-${String(task.id).toLowerCase()}`,
      };
    }
    case "validation":
      return {
        status: "passed",
        checks: scenario.validation_checks,
      };
    case "verification":
      return {
        status: "passed",
        acceptance_trace: (Array.isArray(input.quest.tasks)
          ? input.quest.tasks
          : []
        ).map((task) => ({
          acceptance: task.acceptance || task.title || task.id,
          status: "passed",
        })),
        risks: [],
      };
    case "system_update":
      return {
        system_update: {
          schema_version: 1,
          mode: "no_change",
          summary: scenario.system_summary,
        },
      };
    case "landing":
      if (input.landingRound === 0) {
        return {
          status: "blocked",
          summary: "waiting for simulated final merge",
        };
      }
      return {
        status: "landed",
        summary: scenario.landing_summary,
      };
    default:
      throw new Error(`unsupported simulated callback step: ${input.step || "(empty)"}`);
  }
}
