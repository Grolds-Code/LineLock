# LineLock

**Effectivity-Aware Verification of Engineering Evidence for Jira (Atlassian Forge Vertical Slice)**

> **Scope Boundary:** LineLock verifies the completeness and applicability of recorded engineering evidence against effective bill-of-materials (BOM) configurations, explicit operating envelopes, and human-authorized carry-forward rules. It does **not** guarantee physical product safety or statutory regulatory certification.

## Repository Structure

```text
LineLock/
├── manifest.yml                      # Minimal Forge manifest (Issue Panel, Workflow Validator, SQL, Triggers, Queue)
├── package.json                      # Strict TypeScript + Vitest + Forge SDK dependencies
├── tsconfig.json                     # strict: true, noUncheckedIndexedAccess: true
├── vitest.config.ts                  # Automated test configuration
├── src/
│   ├── core/                         # Pure deterministic verification kernel (zero @forge/* imports)
│   │   ├── types.ts                  # Domain model, closed-world partitions, K3 predicates, two-phase receipts
│   │   ├── canonical.ts              # RFC 8785 canonical JSON & SHA-256 snapshot / issue-state hashing
│   │   ├── predicates.ts             # Exact BigInt scaled decimal arithmetic & Strong Kleene K3 evaluator
│   │   ├── intervals.ts              # Elementary serial-interval decomposition & inverse change ops
│   │   ├── remediation.ts            # Exact branch-and-bound set cover (<= 16x20) + greedy fallback
│   │   ├── verifier.ts               # Closed-world footprint, carry-forward, ABA generation & gate state machine
│   │   └── baselines.ts              # Baselines B0 (timestamp), B1 (suspect graph), B2 (version + envelope)
│   ├── scenarios/
│   │   ├── heliosBatteryPack.ts      # Reference EV traction battery pack scenario (VAR_400V, VAR_800V)
│   │   └── counterexamples.ts        # Adversarial counterexamples CE-01..CE-11b & 16-scenario benchmark corpus
│   ├── forge/                        # Minimal Atlassian Forge backend integration
│   │   ├── ports.ts                  # Explicit SQL provisioning states, workspace schema, typed errors
│   │   ├── provisioning.ts           # Async DDL schema migration manager via @forge/sql MigrationRunner
│   │   ├── sqlStore.ts               # Conditional CAS store on @forge/sql (affectedRows === 1) + TiDB simulator
│   │   ├── jiraGateway.ts            # Live @forge/api REST gateway & connectivity probe
│   │   ├── service.ts                # LineLockService (ABA generation increments + 2-phase workflow gate)
│   │   └── index.ts                  # Forge resolver, workflowValidator, trigger & queue consumer exports
│   └── frontend/
│       └── index.tsx                 # Minimal UI Kit 2 diagnostic & connectivity harness
├── tests/
│   ├── verification.test.ts          # Adversarial, ABA, CAS, SQL provisioning & workflow consistency tests
│   └── jira-gateway.test.ts          # @forge/api REST contract tests
└── scripts/
    └── run-benchmark.ts              # Reproducible benchmark against B0, B1, and strengthened B2
```

## Initial Vertical-Slice Implementation Tasks

1. **Closed-World Dependency & Operating-Condition Partitions (`src/core/types.ts`, `src/core/verifier.ts`):** Require every leaf BOM slot and variant envelope key to be classified as governed or explicitly excluded with approved justification; block partial `testedSlotBinding` records (`INDETERMINATE_INCOMPLETE_EVIDENCE_FOOTPRINT`) and unexamined new dependencies (`INDETERMINATE_UNEXAMINED_DEPENDENCY`).
2. **ABA State-Restoration Protection (`src/core/types.ts`, `src/forge/service.ts`):** Bind every `RoleAttestation` to `(snapshotSha256, approvalGeneration, policyVersion)` and increment `approvalGeneration` monotonically on every committed edit (including `H1 -> H2 -> H1` reverts).
3. **Bounded Two-Phase Jira Transition Consistency (`src/forge/service.ts`):** Record only a bounded-TTL `PendingTransitionIntent` in `jira:workflowValidator`, promoting to `FinalizedReleaseReceipt` on `avi:jira:updated:issue` iff Jira reaches `Done` while live `(snapshotSha256, approvalGeneration, policyVersion)` and gate checks still hold; flag `UNVALIDATED_RELEASE_DRIFT` on bypasses or mid-transition TOCTOU races.
4. **Verified Conditional CAS on `@forge/sql` (`src/forge/sqlStore.ts`):** Enforce atomic optimistic concurrency via `UPDATE ... WHERE eco_issue_id = ? AND revision_seq = ?` (`UpdateQueryResponse.affectedRows === 1`).
5. **Exact Applicability vs. Rule-Authorized Carry-Forward (`src/core/verifier.ts`, `src/scenarios/counterexamples.ts`):** Separate `SUPPORTED_AS_TESTED` from `SUPPORTED_BY_APPROVED_RULE` across both component revisions and environmental shifts (`CE-11a` cold soak `-40 degC`, `CE-11b` `salt_fog_exposure`, `SC-15` warm `58 degC`).
6. **Competent Version + Envelope Baseline (`src/core/baselines.ts`, `scripts/run-benchmark.ts`):** Evaluate LineLock against `B0`, `B1`, and strengthened `B2` (`evaluateB2CompetentVersionAndEnvelope`).
7. **Asynchronous Forge SQL Provisioning & Recovery (`src/forge/provisioning.ts`):** Run DDL strictly through `@forge/sql` `MigrationRunner` (`/api/v1/execute/ddl`) with explicit `UNPROVISIONED`, `PROVISIONING_IN_PROGRESS` (`APP_NOT_ENABLED`), `READY`, and `PROVISIONING_FAILED` states.

## Local Verification Commands

```bash
npm install
npm run verify      # Runs tsc --noEmit, vitest run, and scripts/run-benchmark.ts
npx forge lint      # Validates manifest.yml and handler bindings against Forge CLI
```

## Live Atlassian Cloud Deployment Steps (Requires Developer Credentials)

```bash
export FORGE_EMAIL="your-atlassian-email@example.com"
export FORGE_API_TOKEN="your-atlassian-api-token"

npx forge register  # Assigns real Atlassian app ARI in manifest.yml
npx forge deploy -e development
npx forge install --product jira --site your-site.atlassian.net --non-interactive
```

After installation, attach **LineLock Effectivity-Aware Evidence Gate** (`jira:workflowValidator`) to the release transition(s) of your ECO workflow in Jira Project Settings -> Workflows.
