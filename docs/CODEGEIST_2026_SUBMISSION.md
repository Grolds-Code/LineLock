# LineLock — Codegeist 2026 submission readiness

**Primary category:** Apps for Specialized Industries  
**Bonus category:** Best Agents (Forge `rovo:agent`)  
**Project:** [LineLock](https://github.com/Grolds-Code/LineLock)  
**Competition:** [Codegeist 2026](https://codegeist2026.devpost.com/rules)  
**Deadline:** 22 December 2026 at noon Pacific Time

> Status: ENGINEERING CANDIDATE, NOT YET SUBMISSION-READY. A public YouTube
> demo, shareable Forge installation link, fresh-site installation and live
> consent/security tests still need completion. Do not claim official Runs on
> Atlassian eligibility until `forge eligibility` has been checked.

## The 20-second explanation

**The closest Jira ticket to Done is not necessarily a safe engineering release.**

A component revision can affect only specific products and serial numbers.
A conventional ticket status or suspect-link graph cannot tell an engineer
whether the existing qualification tests still apply. One method may approve
an unsafe gap; another may force expensive retesting of unaffected units.

**LineLock evaluates the actual configuration, the exact tested conditions,
the applicable approved rule and the signoff authority before an ECO can
move to Done.** It explains the first blocking reason and lets the engineer
simulate a narrower, defensible change without making that change.

## What to show judges

The core story is deliberately a single automotive engineering-change
decision. MedTech and Aerospace remain supported examples, not competing
stories in a five-minute video.

1. Open a Jira ECO and its native **LineLock Assurance Cockpit**. Show
   the prominent release decision and next action.
2. Provision the six demonstration qualification tickets; show that
   LineLock links and pins each real Jira issue. If provisioning is not
   available in the site's workflow, disclose the installation requirement.
3. Propose the capacitor Rev C substitution for **both** 400V and 800V
   variants from serial 5000. Explain why 800V qualification is not justified.
4. Simulate applying the revision only to the 400V product scope, without
   committing. Show the affected serial slice and reduced remediation burden.
5. Commit the scoped change explicitly. Show that the previous signoffs
   do **not** survive this edit; complete required human authorization and
   the controlled Jira transition on an installed test environment.
6. Ask Rovo which configurations are blocked and what narrower alternative
   avoids unnecessary retesting. Rovo **explains and simulates**; it cannot
   sign, approve or silently mutate the ECO.

The release decision depends on deterministic product and evidence data,
not on a language model's judgment.

## Suggested 4:35 YouTube demo storyboard

| Segment | Length | What viewers see | What to say |
|---|---:|---|---|
| Industry problem | 0:00–0:25 | One Jira engineering change | "A component change may invalidate only some serial ranges, but status-based gates can't see that." |
| Evidence gate | 0:25–1:15 | Cockpit release decision and impacted 800V slices | "LineLock refuses to treat a Done ticket or changed version as qualification proof." |
| Counterfactual | 1:15–2:10 | Simulate ALL vs 400V-only from SN 5000 | "Here is exactly which units change and which existing tests still apply." |
| Approval authority | 2:10–2:55 | Generation-bound signoff and Jira release transition | "Every committed change invalidates stale signatures. A human must authorize the actual snapshot." |
| Rovo analysis | 2:55–3:40 | Rovo inspect and simulate actions | "Rovo can investigate and recommend, but cannot override the verifier or commit the result." |
| Technical proof and close | 3:40–4:35 | Serial intervals, K3 trace, Forge SQL CAS, quick end-to-end view | "The decision is explainable, versioned, and enforced in Jira, not just illustrated in a dashboard." |

Record **real functional footage** on Jira Cloud. Never replace actual runtime
checks with static screenshots that imply those checks passed.

## Engineering proof (claim only when current CI passes)

- Pure deterministic core with closed-world BOM and envelope completeness.
- Exact bounded-decimal Strong Kleene three-valued logic.
- Serial-interval and product-variant effectivity slicing.
- Snapshot- and generation-bound human signoffs.
- Forge SQL conditional CAS and post-transition receipt reconciliation.
- Versioned Jira evidence hashes. v1 snapshots remain unchanged; v2
  includes raw Atlassian Document Format and attachment **metadata**.
- Per-ECO provisioning ledger with persisted Jira IDs and conservative
  recovery when a creation response is ambiguous.
- User-permission-scoped Rovo reads; no app-privilege fallback in Rovo.
- Native `jira:issuePanel`, `jira:projectPage`,
  `jira:workflowValidator`, `rovo:agent` and four GET actions.
- In-project administrator-configured governed Jira issue type.

**Benchmark disclosure:** The existing 37/37 result measures 37
author-labeled assertions in 16 synthetic automotive scenarios. It is
a reproducible regression suite, *not* a measured industrial accuracy rate,
a certification, or an independent commercial PLM comparison.

**Evidence disclosure:** A Jira ticket's existence, Done status, hash
integrity and approved engineering applicability are separate questions.
Raw ADF and attachment-metadata hashing does not hash the attachment's
binary contents or prove the physical test was valid.

## Fresh Jira installation acceptance checklist

- [ ] `npm ci --ignore-scripts && npm run verify` succeeds on the final commit
- [ ] `forge lint` succeeds against the intended manifest
- [ ] `forge deploy -e development` completes on a fresh test installation
- [ ] `forge eligibility` output is captured and reviewed; no eligibility assumed
- [ ] A shareable Forge **installation link** is generated for judges
- [ ] Dedicated Engineering Change Order issue type is created or identified
- [ ] In Fleet, a project administrator selects that issue type for governed release transitions
- [ ] The workflow validator is attached to the correct Done transition
- [ ] Ordinary Jira Tasks/Stories/Bugs still transition without LineLock
- [ ] An uninitialized governed ECO fails closed
- [ ] The six Jira qualification tasks create, reach Done, link, and pin correctly
- [ ] Interrupted provisioning is resumed without duplicate tickets; uncertain POST recovery is exercised
- [ ] Jira role permissions, group actors, and separation of duties are tested
- [ ] One user without project access and one user restricted by Jira Issue Security cannot inspect private ECO/evidence data via UI, Fleet or Rovo
- [ ] Standalone Rovo Chat and issue-context Rovo requests obtain proper user consent and fail closed if consent is missing
- [ ] Rovo GET actions cause zero SQL DML writes, including with a pending release receipt
- [ ] Evidence changes detectable by v2 invalidate the relevant assurance
- [ ] Production signoff differs visibly from the marked single-evaluator demo waiver
- [ ] Fleet pagination uses visible-only page counts and works on more than 25 ECOs
- [ ] Public YouTube video is under five minutes and uses functional Jira footage
- [ ] Devpost entry contains installation and testing instructions, category, bonus track, source URL, demo URL and all required fields

## Judge installation instructions (finish after live verification)

1. Follow the Forge installation link provided in the submission.
2. Install in a Jira Cloud test site with appropriate project administration permissions.
3. Create or select a dedicated ECO issue type and a project workflow with a controlled Done transition.
4. Open **LineLock Fleet Assurance** in the project, configure the governed ECO issue type, then attach the LineLock workflow validator to the relevant transition.
5. Create one ECO issue and open its **LineLock Assurance Cockpit** issue panel.
6. Choose Automotive EV and initialize the six qualification tickets. Confirm Jira permits the required Task transitions and issue links.
7. Apply the supplied all-variants cutover, inspect the block, simulate 400V-only scope, commit only if desired, and examine Rovo's read-only explanation.

This is a test workflow. It does not certify that a customer-specific Jira
workflow, evidence process, or engineering approval chain is compliant with
industry law or standards.

## Required URLs for the Devpost entry

- Source: https://github.com/Grolds-Code/LineLock
- Forge installation: **PENDING LIVE CREATION AND TEST**
- YouTube demo: **PENDING REAL RECORDING AND PUBLIC UPLOAD**
- Devpost submission: **PENDING FINAL FORM**
