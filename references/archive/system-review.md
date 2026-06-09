# Loopo Universal System Kernel Review

## Final Model

Loopo uses a small universal semantic root plus full industry-profile canonical YAML docs.

- `.loopo/system.yaml` is the first-read semantic frontier.
- `.loopo/signature.yaml` is the mechanical signature and audit sidecar.
- `.loopo/docs/**/*.yaml` contains full canonical documents when detail earns a file.
- `.loopo/packs/**/*.yaml` is reserved for rare scale-out record shards.
- `schemas/docs/*.yaml` gives each canonical document a concrete industry-profile contract.

The root keeps four mental models:

- `objects[]`: semantic things agents reason about.
- `assertions[]`: rules, behaviours, claims, assumptions, and limitations.
- `resources[]`: locatable, schema-bound, signable, citable, or loadable things.
- `memories[]`: small non-binding preferences, learnings, or observations.

There is no root `relations[]` block. Records use relation-keyed typed links:

```yaml
links:
  about:
    - object:swe-flow
  supported_by:
    - resource:software-architecture#/runtime/scenarios/swe-lifecycle
```

## Concrete Docs

Loopo does not use a generic section/profile schema as the canonical document model. Canonical docs use concrete full-profile schemas:

- `schemas/docs/software-architecture.yaml`
- `schemas/docs/decision-records.yaml`
- `schemas/docs/workflow-spec.yaml`
- `schemas/docs/knowledge-report.yaml`
- `schemas/docs/dataset-datasheet.yaml`
- `schemas/docs/model-card.yaml`
- `schemas/docs/agent-system-card.yaml`
- `schemas/docs/business-architecture.yaml`
- `schemas/docs/artifact-bom.yaml`

Every concrete canonical document requires `standard_alignment` as a keyed multiline prose map. That field explains which professional standard or practice the document shape follows, for example arc42/C4, ADR, BPMN/process specification, IMRaD, Datasheets for Datasets, Model Cards, NIST AI RMF, TOGAF, SPDX, or CycloneDX.

Concrete industry docs are section-shaped document models. Schema fields are the document sections, prose blocks carry coherent content, and keyed maps provide local anchors for named subtopics. They must not be modeled as arrays of tiny `id`/`text` records.

Use multiline YAML block scalars for named prose fields and keyed prose-map values. Use normal `- item` bullets for string arrays; array bullets should not use block scalars unless the item genuinely needs paragraph structure.

## Required Docs By Kind

Required docs are satisfied by canonical resources whose `schema_ref` equals the required concrete schema URI.

| System Kind | Required Schema Refs |
| --- | --- |
| `software` | `loopo://schemas/docs/software-architecture.yaml`, `loopo://schemas/docs/decision-records.yaml` |
| `workflow` | `loopo://schemas/docs/workflow-spec.yaml` |
| `knowledge` | `loopo://schemas/docs/knowledge-report.yaml` |
| `data` | `loopo://schemas/docs/dataset-datasheet.yaml` |
| `model` | `loopo://schemas/docs/model-card.yaml` |
| `agent` | `loopo://schemas/docs/agent-system-card.yaml` |
| `organization` | `loopo://schemas/docs/business-architecture.yaml` |
| `artifact` | `loopo://schemas/docs/artifact-bom.yaml` |

Loopo currently has `kinds: [software, workflow, agent]`, so it requires:

- `.loopo/docs/software/architecture.yaml`
- `.loopo/docs/decisions/records.yaml`
- `.loopo/docs/workflow/spec.yaml`
- `.loopo/docs/agent/system-card.yaml`

These four documents are full YAML sources. Generated Markdown may render them into longer human-facing architecture, ADR, workflow, or agent-card documents.

## Decision Records

Decisions are not root objects. They live in canonical decision-record documents:

```yaml
schema_version: 2
id: decisions
title: Decision Records
text: |-
  Architecture-significant decision records
  for the system.
standard_alignment:
  adr: |-
    Aligns with ADR practice by preserving context, drivers, options,
    selected decision, rationale, consequences, and durable decision state.
decisions:
  minimal-system-kernel:
    state: accepted
    date: 2026-06-08
    title: Minimal universal system kernel
    context: |-
      ...
      ...
    drivers:
      - Driver bullet written as a normal single-line YAML array item.
    options:
      four-record-blocks:
        text: |-
          ...
          ...
        tradeoffs:
          - Tradeoff bullet written as a normal single-line YAML array item.
    decision: |-
      ...
      ...
    rationale: |-
      ...
      ...
    consequences:
      - Consequence bullet written as a normal single-line YAML array item.
```

Generated decision summaries are derived from decision records. They are not a separate root object or separate canonical schema.

## Signature

`.loopo/signature.yaml` signs deterministic canonical YAML data after parsing and canonical JSON normalization. The file contains manifest-style audit fields because it covers root data, schema files, and canonical resource files:

- root path/schema/digest
- canonical entries with path/schema/role/digest
- receipt head
- previous receipt head
- Ed25519 signature

The semantic root does not contain digests, write policy, generated policy, or signature state.

## Resource Rules

Canonical docs are declared as resources:

```yaml
resources:
  - id: software-architecture
    kind: document
    role: canonical
    location: .loopo/docs/software/architecture.yaml
    schema_ref: loopo://schemas/docs/software-architecture.yaml
    text: |-
      Full software architecture source using arc42 and C4-aligned concerns
      for runtime, structure, interfaces, quality, risks, and diagrams.
```

Do not use abstract slot declarations or schema-resource indirection for canonical docs. Schema files are part of the Loopo schema library and are covered by `.loopo/signature.yaml`.

## Anti-Shell Rules

Concrete schemas prevent shell docs mechanically:

- Software architecture requires goals, stakeholders, constraints, context, solution strategy, structure, runtime, deployment, interfaces, data, quality, risks, technical debt, diagrams, decisions, and glossary.
- Decision records require state, date, title, context, drivers, options, decision, rationale, and consequences.
- Workflow specs require purpose, participants, triggers, inputs, outputs, processes, data objects, invariants, exceptions, monitoring, and diagrams.
- Knowledge reports require abstract, background, research questions, methods, sources, claims, evidence, results, discussion, limitations, reproducibility, and references.
- Dataset datasheets require identity, motivation, composition, collection, preprocessing, labeling, splits, quality, uses, distribution, maintenance, ethics/privacy, and provenance.
- Model cards require model details, intended use, factors, training data, evaluation data, metrics, quantitative analyses, ethical considerations, caveats/recommendations, deployment, monitoring, and security.
- Agent system cards require purpose, actors, responsibilities, autonomy, tools, memory, inputs/outputs, safety, oversight, evaluation, monitoring, incident response, and handoffs.
- Business architecture requires mission, stakeholders, capabilities, value streams, organization, information, products/services, policies, initiatives, metrics, processes, systems, governance, and risks.
- Artifact BOMs require identity, composition, dependencies, build, provenance, licenses, security, distribution, verification, and lifecycle.

If there is no meaningful content for the concrete schema, the doc should not exist.

Canonical prose fields must also be multiline. Schema validation requires newline-bearing strings for prose fields such as `text`, `context`, `decision`, `rationale`, `mitigation`, `meaning`, and prose arrays such as `consequences[]` and `tradeoffs[]`. The semantic verifier requires those fields to be written as YAML block scalars in canonical root and doc files.

Root links may cite precise canonical document sections using resource refs with JSON Pointer fragments:

```yaml
links:
  supported_by:
    - resource:software-architecture#/constraints
    - resource:decisions#/decisions/minimal-system-kernel
```

Fragments are allowed in links, not in `schema_ref`.

## Removed Terms

Do not reintroduce:

- root `relations[]`
- root `records[]`
- legacy architecture-document root families such as domains, behaviours, ADRs, artifacts, or registries
- ADR-shaped or perspective-shaped object kinds
- generic section/profile docs as the canonical doc shape
- abstract document-category lists
- the old root manifest filename
- the old perspective-doc documentation folder

## Final Principle

Root is universal. Canonical docs are specific. Schemas carry industry shape. Resources connect root to docs. Generated Markdown may render full human documents from canonical YAML, but generated docs are not source of truth.
