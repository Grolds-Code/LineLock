# LineLock

**Effectivity-Aware Verification of Engineering Evidence for Jira on Atlassian Forge**

> **Runs on Atlassian Eligible** · **Zero External Egress** · **Multi-Industry Regulated Hardware (Automotive EV, MedTech IEC 60601, Aerospace DO-160G + Custom Studio)** · **Strong Kleene ($K_3$) Deterministic Kernel** · **Space-Wide Fleet Portfolio (`jira:projectPage`)** · **Forge SQL TiDB Conditional CAS** · **Two-Phase Jira Workflow Gate** · **Read-Only Rovo Counterfactual Analyst (`rovo:agent`)**

> **Scope & Safety Boundary:** LineLock verifies the completeness, integrity, and applicability of recorded engineering qualification evidence against effective bill-of-materials (BOM) configurations, explicit operating envelopes, and human-authorized carry-forward rules. It does **not** certify physical product safety or statutory regulatory compliance.

---

## Why LineLock Exists

Traditional PLM/ALM traceability tools and Jira dependency plugins fail on hardware Engineering Change Orders (ECOs) in two opposite ways:
1. **Unsafe False-Pass:** Timestamp gates and naive version checks silently approve changes when an unexamined BOM component is added, when environmental bounds shift non-monotonically (e.g., cold-soak `-40 degC` vs. tested `-20 degC`, or neonatal micro-bolus `<=1.8%` vs. adult `<=3.0%`), or when a linked Jira test ticket's parameters are edited after sign-off.
2. **Costly False-Block:** Untyped "suspect link" graphs invalidate *every* serial unit and product variant whenever a component revision changes—even for pre-cutover serial ranges `[SN 1000..5000)` or variants covered by an approved engineering carry-forward rule.

LineLock solves this natively inside Jira Cloud across **Automotive EV**, **MedTech Class III**, **Aerospace Flight Control**, and **custom hardware families**:
- **Elementary Serial-Interval & Variant Decomposition:** Partitions `[serialFrom, serialTo)` effectivity edges (open-ended `[SN 5000..+inf)` or lot-bounded `[SN 5000..8000)`) across product variants and enforces structural cycle/overlap diagnostics.
- **Closed-World Dependency & Envelope Partitions:** Every obligation declares `governedSlotPaths` $\sqcup$ justified `excludedSlots` and `governedEnvelopeKeys` $\sqcup$ justified `excludedEnvelopeKeys`. Missing governed test bindings (`INDETERMINATE_INCOMPLETE_EVIDENCE_FOOTPRINT`) or unclassified new components (`INDETERMINATE_UNEXAMINED_DEPENDENCY`) block fail-closed.
- **Strong Kleene ($K_3$) Scaled-Decimal Carry-Forward:** Evaluates `TRUE | FALSE | UNKNOWN` predicates using exact `BigInt` scaled arithmetic (`mantissa * 10^scale`) and mandatory canonical units—preventing IEEE-754 rounding errors and ensuring `!UNKNOWN == UNKNOWN` never silently passes missing data.
- **Multi-Industry Templates + Custom Component & Jira Evidence Studio:** Provision live 6-ticket qualification suites in 1 click for **Automotive EV (`ISO 26262 / LV124`)**, **MedTech Class III Infusion Pump (`IEC 60601-1 / 60601-2-24`)**, or **Aerospace Flight Actuator (`RTCA DO-160G`)**, author custom `APPROVED` / `DRAFT` component revisions with arbitrary quantitative attributes, and bind any existing `Done` Jira ticket as RFC 8785 SHA-256 content-pinned evidence.
- **Space-Wide Fleet Assurance Portfolio (`jira:projectPage`):** Space portfolio dashboard (`LineLock Fleet Assurance` under the Space top tab bar / `More`) with native `@forge/react` `DonutChart`, `BarChart`, and `ProgressBar` analytics auditing every initialized ECO across the Jira space.
- **ABA-Resistant Human Governance & Honest Two-Phase Workflow Gate:** Every `RoleAttestation` binds `(snapshotSha256, approvalGeneration, policyVersion)` with live Jira Project Role RBAC (direct + group actors). `jira:workflowValidator` writes a TTL-bounded `PendingTransitionIntent` via Forge SQL CAS (`affectedRows === 1`) before Jira commits, promoted to `FinalizedReleaseReceipt` iff Jira reaches `Done` without post-validation drift.
- **Read-Only Rovo Counterfactual & Fleet Analyst (`rovo:agent`):** Exposes four strictly `GET` read-only actions (`ll-act-inspect-eco`, `ll-act-sim-cutover`, `ll-act-baselines`, `ll-act-fleet-status`) to Rovo without AI ever mutating state or bypassing deterministic verification.

---

## Repository Structure

```text
LineLock/
├── manifest.yml                      # Native Forge manifest (Issue Panel, Project Page, Workflow Validator, Rovo Agent, SQL, Queue)
├── PRIVACY.md                        # Runs on Atlassian zero-egress & Forge SQL data lifecycle policy
├── SECURITY.md                       # Cryptographic, CAS, RBAC, and read-only Rovo AI trust boundaries
├── SUPPORT.md                        # Jira Cloud workflow gate setup & troubleshooting guide
├── src/
│   ├── core/                         # Pure deterministic verification kernel (zero @forge/* or network imports)
│   │   ├── types.ts                  # Domain types, closed-world partitions, K3 AST, two-phase receipts
│   │   ├── canonical.ts              # RFC 8785 canonical JSON & SHA-256 snapshot / Jira issue-state hashing
│   │   ├── predicates.ts             # Exact BigInt scaled quantities & Strong Kleene K3 evaluator
│   │   ├── intervals.ts              # Elementary serial-interval slicer & inverse change operations
│   │   ├── remediation.ts            # Exact branch-and-bound set cover (<= 16x20) + greedy fallback
│   │   ├── verifier.ts               # Footprint checker, carry-forward engine, ABA & gate state machine
│   │   ├── baselines.ts              # Baselines B0 (timestamp), B1 (suspect graph), B2 (version + envelope)
│   │   └── auditPacket.ts            # Deterministic DVP&R Release Assurance & Effectivity Markdown exporter
│   ├── scenarios/
│   │   ├── heliosBatteryPack.ts      # Automotive EV traction battery pack catalog (VAR_400V, VAR_800V)
│   │   ├── industryTemplates.ts      # Multi-industry catalog templates (Automotive EV, MedTech IEC 60601, Aerospace DO-160G)
│   │   ├── templateMetadata.ts       # Browser-safe multi-industry template descriptors for Native UI Kit
│   │   └── counterexamples.ts        # Adversarial counterexamples CE-01..CE-11b & 16-scenario benchmark corpus
│   ├── forge/                        # Atlassian Forge platform integration layer
│   │   ├── ports.ts                  # Explicit SQL provisioning states, workspace schema, Studio & Fleet types
│   │   ├── provisioning.ts           # Async DDL schema migration manager (@forge/sql MigrationRunner)
│   │   ├── sqlStore.ts               # Conditional CAS store on @forge/sql (affectedRows === 1) + TiDB simulator
│   │   ├── jiraGateway.ts            # Resilient @forge/api REST v3 gateway (direct + group-role RBAC & 6-ticket provisioner)
│   │   ├── service.ts                # LineLockService (multi-industry provisioning, Custom Studio, Fleet overview, ABA & 2-phase gate)
│   │   ├── rovo.ts                   # Strictly read-only Rovo action handlers (4 GET tools)
│   │   └── index.ts                  # Forge resolver, workflowValidator, triggers, queue & Rovo exports
│   └── frontend/
│       ├── index.tsx                 # 5-Tab UI Kit 2 Issue Cockpit (Matrix + StackBarChart, Simulator + BarChart, Custom Studio, Governance, Tamper Lab)
│       └── fleetPage.tsx             # Space-wide LineLock Fleet Assurance projectPage (DonutChart, BarChart, ProgressBar portfolio)
├── tests/
│   ├── verification.test.ts          # Kernel, adversarial CE-01..11b, ABA, SQL CAS & 2-phase workflow tests
│   ├── phase2-cockpit-rovo.test.ts   # Live 6-issue provisioning, tamper detection, policy switch & Rovo tests
│   ├── phase3-production-hardening.test.ts # Group-role RBAC, 0ms receipt promotion, [SN_from..SN_to) splits & re-pinning
│   ├── phase4-fleet-templates-studio.test.ts # MedTech & Aerospace templates, Custom Studio, Jira Binding & Fleet Portfolio
│   ├── jira-gateway.test.ts          # @forge/api REST v3 contract & resilient auth fallback tests
│   └── manifest-validation.test.ts   # Official @forge/manifest schema, rovo:agent, projectPage & zero-egress validation
└── scripts/
    ├── run-benchmark.ts              # Reproducible benchmark against B0, B1, and strengthened B2
    └── verify-forge-bundle.cjs       # Offline @forge/bundler verification (9 Node handlers + 2 Native UI Kit bundles)
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
2. `vitest run` — Full adversarial, ABA, SQL CAS, multi-industry template, Custom Studio, Fleet Portfolio, group-actor RBAC, Rovo, and `@forge/manifest` test suites.
3. `tsx scripts/run-benchmark.ts` — Ground-truth benchmark across 16 labeled scenarios (37 slice-obligation assertions):
   - `B0 (Timestamp & Done Status)`: `20/37` (`54.1%`), `17` False-Safe
   - `B1 (Untyped Suspect Graph)`: `18/37` (`48.6%`), `10` False-Safe, `9` False-Block
   - `B2 (Version + Serial + Standard Envelope)`: `27/37` (`73.0%`), `6` False-Safe, `4` False-Block
   - **`LineLock v2 (Closed-World + K3 + Gen CAS)`**: **`37/37` (`100.0%`)**, **`0` False-Safe**, **`0` False-Block**
4. `node scripts/verify-forge-bundle.cjs` — Compiles all 9 Forge backend handlers and both Native UI Kit 2 frontends (`main-ui` + `fleet-ui`) through `@forge/bundler`.

---

## Clean Jira Cloud Installation & Judge Walkthrough (5 Minutes)

### 1. Deploy & Install
```bash
npx forge login
npx forge deploy -e production
npx forge install -e production --product jira --site <your-site>.atlassian.net
```
*(Or install in 1 click using the Developer Console Installation Link provided in the submission notes.)*

> **Browser Note:** If using **Brave Browser**, toggle **Brave Shields OFF** on `<your-site>.atlassian.net` so Brave does not block Forge UI Kit 2's cross-origin `atlassian-dev.net` iframe bridge.

### 2. Attach the Native Jira Workflow Gate
1. Create or open a **Company-managed** Jira Software space (e.g., key `ECO`).
2. Navigate to **Space settings $\rightarrow$ Workflows $\rightarrow$ Edit workflow** (`Text` tab).
3. Select the **`Done`** transition $\rightarrow$ **Rules $\rightarrow$ Validate details (`+`)** $\rightarrow$ select **`LineLock Effectivity-Aware Evidence Gate`** $\rightarrow$ **Add** $\rightarrow$ **Update workflow**.

### 3. Interactive Multi-Industry & Fleet Walkthrough (`ECO-1`, `ECO-2`, Fleet Page & Rovo)
1. **Provision Any Regulated Hardware Domain (`ECO-1` / `ECO-2`):** Open `ECO-1` $\rightarrow$ **`LineLock Assurance Cockpit`** $\rightarrow$ choose **Automotive EV Powertrain**, **MedTech Class III Infusion Pump**, or **Aerospace DO-160G Flight Actuator** $\rightarrow$ click **`Provision Selected Template (6 Live Tests)`**. LineLock creates 6 real `Done` Jira qualification tickets, links them to the ECO, and pins their RFC 8785 SHA-256 content hashes in Forge SQL (`6 / 6` Supported).
2. **Trigger Serial Cutover & Workflow Block:** Click the flagship second-source cutover button (e.g., `Propose Cap Rev C (ALL, SN>=5000)` or `Propose Flow Sensor Rev B (ALL, SN>=5000)`). Inspect the Strong Kleene $K_3$ proof tree and `StackBarChart`, and try moving the ECO to **`Done`** to watch Jira block the transition live.
3. **Counterfactual Simulator & Custom Authoring Studio:**
   - In **`Counterfactual & Remediation`**, simulate open-ended or lot-bounded `[SN_from..SN_to)` cutovers with `SQL Mutated: FALSE` and inspect the live `BarChart` comparing `B0`, `B1`, `B2`, and `LineLock`.
   - In **`Custom Studio & Jira Binding`**, author your own custom component revision (`APPROVED` vs. `DRAFT`) with custom physical attributes or bind any existing `Done` Jira ticket key as content-pinned qualification evidence.
4. **Generation-Bound RBAC Signoff, Audit Export & Verified `Done` Release:** Open **`Governance & ABA Signoff`**, switch to *Solo-Evaluator Demo Policy*, sign the snapshot, optionally click **`Export DVP&R Comment`**, and transition the ECO to **`Done`** (`RELEASE_TRANSITIONED_VERIFIED`).
5. **Space-Wide Fleet Assurance Dashboard & Rovo Analyst:** In the Space's top horizontal tab bar (`Summary | Timeline | Kanban board | ... | More`), click **`More` $\rightarrow$ `LineLock Fleet Assurance`** to inspect portfolio-wide `DonutChart`, `BarChart`, and `ProgressBar` metrics across all ECOs, or open **Ask Rovo $\rightarrow$ `LineLock Assurance Analyst`** and run *Summarize space-wide LineLock Fleet Assurance status across project ECO*.

---

## Governance & Policies
- [Privacy Policy (`PRIVACY.md`)](PRIVACY.md) — 100% **Runs on Atlassian**, zero external egress.
- [Security Policy (`SECURITY.md`)](SECURITY.md) — Strong Kleene $K_3$, Forge SQL CAS, live RBAC, and read-only Rovo AI guarantees.
- [Support & Troubleshooting (`SUPPORT.md`)](SUPPORT.md) — Workflow validator & cold SQL provisioning guide.
- License: [MIT](LICENSE)
