# Security Policy — LineLock

## Cryptographic & Trust-Boundary Guarantees

LineLock enforces five defense-in-depth engineering invariants across its pure verification kernel (`src/core/`) and Atlassian Forge integration layer (`src/forge/`):

1. **No Declared External Network Egress (official eligibility pending):** `manifest.yml` enforces zero `permissions.external` declarations (verified in CI by [`tests/manifest-validation.test.ts`](tests/manifest-validation.test.ts)).
2. **Pure Deterministic Kernel Isolation:** `src/core/` contains zero `@forge/*`, `fetch`, or non-deterministic clock imports (enforced by static source scanning in [`tests/phase3-production-hardening.test.ts`](tests/phase3-production-hardening.test.ts)). All numeric predicates execute via exact `BigInt` scaled decimals (`mantissa * 10^scale`) under Strong Kleene ($K_3$) three-valued logic (`TRUE | FALSE | UNKNOWN`).
3. **Parameterized Single-Statement SQL & Optimistic CAS:** Every Forge SQL (`@forge/sql`) query uses `.prepare(...).bindParams(...)` bound parameters—never string interpolation—and enforces conditional Compare-and-Swap (`WHERE eco_issue_id = ? AND revision_seq = ?`, checking `affectedRows === 1`).
4. **ABA-Resistant Human Governance & Live RBAC:** Every `RoleAttestation` cryptographically binds `(snapshotSha256, approvalGeneration, policyVersion)` and re-verifies live Jira Project Role membership (both direct `actorUser` and group `atlassian-group-role-actor` memberships) on every evaluation.
5. **Read-Only Rovo AI Boundary:** Every Rovo action (`ll-act-inspect-eco`, `ll-act-sim-cutover`, `ll-act-baselines`, `ll-act-fleet-status`) is strictly `actionVerb: GET` and tested through read-only service paths that cannot mutate Forge SQL or override `jira:workflowValidator`. They run under the invoking Jira user's token without `asApp()` fallback; live consent and Issue Security testing remain required.

## Scope of evidence integrity and release authority

- **Legacy v1:** existing evidence without `hashProjectionVersion` retains the original
  SHA-256 projection and snapshot normalization. An upgrade must not silently
  invalidate an unchanged, previously signed snapshot.
- **New v2:** selected Jira fields, raw ADF and attachment metadata contribute
  to the content hash. Attachment bytes are **not** hashed; neither version
  establishes whether a physical qualification test was scientifically valid.
- **Provisioning:** Jira issue creation uses a per-ECO CAS ledger and an
  immutable operation ID saved as a Jira issue property in the creation request.
  An ambiguous create outcome remains unretriable until its original Jira
  ticket is verified against provenance by an administrator. The system does
  not claim exactly-once network delivery.
- **Issue scope:** the release validator prefers administrator-configured
  stable issue-type IDs and always governs existing ECO workspaces, even after
  mutable labels or names change. Moved ECOs fail closed on project identity
  mismatch.
- **Visibility:** user-scoped Jira checks precede interactive disclosure.
  Fleet counts are limited to caller-visible issues and to each page.
- **Demo policy:** single-evaluator governance explicitly waives production
  separation of duties and invalidates previous approval generations.
- **Deployment:** automated tests verify the simulated permission, CAS and
  workflow logic. Fresh Jira installation, `forge lint`, `forge eligibility`,
  and Rovo consent checks must still be performed before representing the
  application as independently deployment-verified.

## Reporting a Vulnerability

Please report suspected security, cryptographic, or RBAC bypass issues via GitHub Security Advisories on `https://github.com/Grolds-Code/LineLock/security/advisories/new` (or open a confidential security report on the repository) with:
- Affected file/function in `src/core/` or `src/forge/`
- Minimal reproduction scenario or Vitest case demonstrating a False-Safe (`transitionAllowed === true` on an invalid configuration) or CAS/ABA race condition.
