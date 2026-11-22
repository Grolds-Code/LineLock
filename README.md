# LineLock

**Effectivity-Aware Verification of Engineering Evidence for Jira on Atlassian Forge**

> **Runs on Atlassian Eligible** · **Zero External Egress** · **Strong Kleene ($K_3$) Deterministic Kernel** · **Forge SQL TiDB Conditional CAS** · **Two-Phase Jira Workflow Gate** · **Read-Only Rovo Counterfactual Analyst**

> **Scope & Safety Boundary:** LineLock verifies the completeness, integrity, and applicability of recorded engineering qualification evidence against effective bill-of-materials (BOM) configurations, explicit operating envelopes, and human-authorized carry-forward rules. It does **not** certify physical product safety or statutory regulatory compliance.

---

## Why LineLock Exists

Traditional PLM/ALM traceability tools and Jira dependency plugins fail on hardware Engineering Change Orders (ECOs) in two opposite ways:
1. **Unsafe False-Pass:** Timestamp gates and naive version checks silently approve changes when an unexamined BOM component is added, when environmental bounds shift non-monotonically (e.g., cold-soak `-40 degC` vs. tested `-20 degC`), or when a linked Jira test ticket's parameters are edited after sign-off.
2. **Costly False-Block:** Untyped "suspect link" graphs invalidate *every* serial unit and product variant whenever a component revision changes—even for pre-cutover serial ranges `[SN 1000..5000)` or variants covered by an approved engineering carry-forward rule.

LineLock solves this directly inside Jira Cloud:
- **Elementary Serial-Interval & Variant Decomposition:** Partitions `[serialFrom, serialTo)` effectivity edges across product variants (`VAR_400V`, `VAR_800V`) and enforces structural cycle/overlap diagnostics.
- **Closed-World Dependency & Envelope Partitions:** Every obligation declares `governedSlotPaths` $\sqcup$ justified `excludedSlots` and `governedEnvelopeKeys` $\sqcup$ justified `excludedEnvelopeKeys`. Missing governed test bindings (`INDETERMINATE_INCOMPLETE_EVIDENCE_FOOTPRINT`) or unclassified new components (`INDETERMINATE_UNEXAMINED_DEPENDENCY`) block fail-closed.
- **Strong Kleene ($K_3$) Scaled-Decimal Carry-Forward:** Evaluates `TRUE | FALSE | UNKNOWN` predicates using exact `BigInt` scaled arithmetic (`mantissa * 10^scale`) and mandatory canonical units—preventing IEEE-754 rounding errors and ensuring `!UNKNOWN == UNKNOWN` never silently passes missing data.
- **ABA-Resistant Human Governance:** Every `RoleAttestation` binds `(snapshotSha256, approvalGeneration, policyVersion)` and enforces live Jira Project Role membership plus bipartite separation-of-duties. Even an `H1 -> H2 -> H1` revert increments `approvalGeneration` (`1 -> 2 -> 3`) and invalidates prior signatures.
- **Honest Two-Phase Jira Workflow Enforcement:** `jira:workflowValidator` writes a TTL-bounded `PendingTransitionIntent` via Forge SQL CAS (`affectedRows === 1`) before Jira commits, and `avi:jira:updated:issue` promotes it to `FinalizedReleaseReceipt` iff Jira reaches `Done` while live `(snapshotSha256, approvalGeneration, policyVersion)` and gate checks still hold—otherwise flagging `UNVALIDATED_RELEASE_DRIFT`.
- **Read-Only Rovo Counterfactual Analyst:** Exposes three strictly `GET` read-only actions (`ll-act-inspect-eco`, `ll-act-sim-cutover`, `ll-act-baselines`) so engineers can ask Rovo Chat *"What if we scope Cap Rev C to 400V packs from serial 5000?"* without AI ever mutating state or bypassing deterministic verification.

---

## Repository Structure

```text
LineLock/
├── manifest.yml                      # Native Forge manifest (Issue Panel, Workflow Validator, Rovo Agent, SQL, Queue)
├── package.json                      # TypeScript strict + Vitest + Forge SDKs
├── tsconfig.json                     # Forge bundler TypeScript config (strict + noUncheckedIndexedAccess)
├── tsconfig.typecheck.json           # Full repository typecheck config (src + tests + scripts)
├── src/
│   ├── core/                         # Pure deterministic verification kernel (zero @forge/* or network imports)
│   │   ├── types.ts                  # Domain types, closed-world partitions, K3 AST, two-phase receipts
│   │   ├── canonical.ts              # RFC 8785 canonical JSON & SHA-256 snapshot / Jira issue-state hashing
│   │   ├── predicates.ts             # Exact BigInt scaled quantities & Strong Kleene K3 evaluator
│   │   ├── intervals.ts              # Elementary serial-interval slicer & inverse change operations
│   │   ├── remediation.ts            # Exact branch-and-bound set cover (<= 16x20) + greedy fallback
│   │   ├── verifier.ts               # Footprint checker, carry-forward engine, ABA & gate state machine
│   │   └── baselines.ts              # Baselines B0 (timestamp), B1 (suspect graph), B2 (version + envelope)
│   ├── scenarios/
│   │   ├── heliosBatteryPack.ts      # Reference EV traction battery pack catalog (VAR_400V, VAR_800V)
│   │   └── counterexamples.ts        # Adversarial counterexamples CE-01..CE-11b & 16-scenario benchmark corpus
│   ├── forge/                        # Atlassian Forge platform integration layer
│   │   ├── ports.ts                  # Explicit SQL provisioning states, workspace schema, counterfactual types
│   │   ├── provisioning.ts           # Async DDL schema migration manager (@forge/sql MigrationRunner)
│   │   ├── sqlStore.ts               # Conditional CAS store on @forge/sql (affectedRows === 1) + TiDB simulator
│   │   ├── jiraGateway.ts            # Live @forge/api REST v3 gateway & 6-ticket qualification provisioner
│   │   ├── service.ts                # LineLockService (live provisioning, counterfactuals, ABA & 2-phase gate)
│   │   ├── rovo.ts                   # Strictly read-only Rovo action handlers
│   │   └── index.ts                  # Forge resolver, workflowValidator, triggers, queue & Rovo exports
│   └── frontend/
│       └── index.tsx                 # UI Kit 2 Assurance Cockpit (Matrix, K3 Proof Tree, Simulator, Governance)
├── tests/
│   ├── verification.test.ts          # Kernel, adversarial CE-01..11b, ABA, SQL CAS & 2-phase workflow tests
│   ├── phase2-cockpit-rovo.test.ts   # Live 6-issue provisioning, tamper detection, policy switch & Rovo tests
│   ├── jira-gateway.test.ts          # @forge/api REST v3 contract tests
│   └── manifest-validation.test.ts   # Official @forge/manifest schema & zero-egress validation
└── scripts/
    ├── run-benchmark.ts              # Reproducible benchmark against B0, B1, and strengthened B2
    └── verify-forge-bundle.cjs       # Offline @forge/bundler verification (Node runtime + Native UI Kit)
```

---

## Reproducible Local Verification

Requires **Node.js `>= 22.23.4`** (or `24.x`):

```bash
npm install
npm run verify
```

`npm run verify` executes:
1. `tsc -p tsconfig.typecheck.json --noEmit` — Strict TypeScript check across `src/`, `tests/`, and `scripts/`.
2. `vitest run` — Full adversarial, ABA, SQL CAS, provisioning, Rovo, and `@forge/manifest` test suites.
3. `tsx scripts/run-benchmark.ts` — Ground-truth benchmark across 16 labeled scenarios (37 slice-obligation assertions):
   - `B0 (Timestamp & Done Status)`: `20/37` (`54.1%`), `17` False-Safe
   - `B1 (Untyped Suspect Graph)`: `18/37` (`48.6%`), `10` False-Safe, `9` False-Block
   - `B2 (Version + Serial + Standard Envelope)`: `27/37` (`73.0%`), `6` False-Safe, `4` False-Block
   - **`LineLock v2 (Closed-World + K3 + Gen CAS)`**: **`37/37` (`100.0%`)**, **`0` False-Safe**, **`0` False-Block**
4. `node scripts/verify-forge-bundle.cjs` — Compiles all 8 Forge backend handlers and the UI Kit 2 Cockpit through `@forge/bundler`.

---

## Clean Jira Cloud Installation & Judge Walkthrough (5 Minutes)

### 1. Deploy & Install
```bash
npx forge login
npx forge register   # (Skip if deploying to your own registered app ARI)
npx forge deploy -e development
npx forge install --product jira --site <your-site>.atlassian.net
```
*(If upgrading an existing installation after pulling Phase 2 scopes, run `npx forge install --upgrade --product jira --site <your-site>.atlassian.net`.)*

> **Browser Note:** If using **Brave Browser**, toggle **Brave Shields OFF** on `<your-site>.atlassian.net` so Brave does not block Forge UI Kit 2's cross-origin `atlassian-dev.net` iframe bridge.

### 2. Attach the Native Jira Workflow Gate
1. Create or open a **Company-managed** Jira Software space (e.g., key `ECO`).
2. Navigate to **Space settings $\rightarrow$ Workflows $\rightarrow$ Edit workflow** (`Text` tab).
3. Select the **`Done`** transition $\rightarrow$ **Rules $\rightarrow$ Validate details (`+`)** $\rightarrow$ select **`LineLock Effectivity-Aware Evidence Gate`** $\rightarrow$ **Add** $\rightarrow$ **Update workflow**.

### 3. Interactive Walkthrough on an ECO Issue (`ECO-1`)
1. Open `ECO-1`, click the **Apps (`⬡`)** icon under the issue title, and open **`LineLock Assurance Cockpit`**.
2. Click **`Provision Helios EV Pack + 6 Live Jira Tests (Recommended)`** — LineLock creates 6 real `Done` Jira qualification tickets (`ECO-2`..`ECO-7`), links them to `ECO-1`, and pins their SHA-256 content hashes in Forge SQL.
3. Click **`Propose Cap Rev C (ALL, SN>=5000)`** — inspect why `VAR_400V [SN 5000..+inf)` passes via rule `CFR-400-CAP-SUB` while `VAR_800V [SN 5000..+inf)` fails Strong Kleene $K_3$ (`1.25 * 800V = 1000V <= 630V -> FALSE`), and try moving `ECO-1` to **`Done`** to watch Jira block the transition live!
4. Open **`Counterfactual & Remediation`**, simulate scoping `CAP-1210@C` to `VAR_400V` from `SN >= 5000` (`0` retests required, `SQL Mutated: FALSE`), and click **`Commit Counterfactual to ECO (CAS)`**.
5. Open **`Governance & ABA Signoff`** (switch to *Solo-Evaluator Demo Policy* if testing with a single admin account), sign the snapshot & generation, and move `ECO-1` to **`Done`** (`RELEASE_TRANSITIONED_VERIFIED`).
6. Open **`Ask Rovo`** $\rightarrow$ select **`LineLock Assurance Analyst`**, and ask counterfactual or baseline-audit questions against `ECO-1`!
