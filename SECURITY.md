# Security Policy — LineLock

## Cryptographic & Trust-Boundary Guarantees

LineLock enforces five defense-in-depth engineering invariants across its pure verification kernel (`src/core/`) and Atlassian Forge integration layer (`src/forge/`):

1. **Zero External Network Egress (`Runs on Atlassian`):** `manifest.yml` enforces zero `permissions.external` declarations (verified in CI by [`tests/manifest-validation.test.ts`](tests/manifest-validation.test.ts)).
2. **Pure Deterministic Kernel Isolation:** `src/core/` contains zero `@forge/*`, `fetch`, or non-deterministic clock imports (enforced by static source scanning in [`tests/phase3-production-hardening.test.ts`](tests/phase3-production-hardening.test.ts)). All numeric predicates execute via exact `BigInt` scaled decimals (`mantissa * 10^scale`) under Strong Kleene ($K_3$) three-valued logic (`TRUE | FALSE | UNKNOWN`).
3. **Parameterized Single-Statement SQL & Optimistic CAS:** Every Forge SQL (`@forge/sql`) query uses `.prepare(...).bindParams(...)` bound parameters—never string interpolation—and enforces conditional Compare-and-Swap (`WHERE eco_issue_id = ? AND revision_seq = ?`, checking `affectedRows === 1`).
4. **ABA-Resistant Human Governance & Live RBAC:** Every `RoleAttestation` cryptographically binds `(snapshotSha256, approvalGeneration, policyVersion)` and re-verifies live Jira Project Role membership (both direct `actorUser` and group `atlassian-group-role-actor` memberships) on every evaluation.
5. **Read-Only AI / MCP Boundary:** Every Rovo action and Atlassian MCP tool (`ll-act-inspect-eco`, `ll-act-sim-cutover`, `ll-act-baselines`, `ll-act-fleet-status`) is strictly `actionVerb: GET` and verified never to mutate Forge SQL or override `jira:workflowValidator`.

## Reporting a Vulnerability

Please report suspected security, cryptographic, or RBAC bypass issues via GitHub Security Advisories on `https://github.com/Grolds-Code/LineLock/security/advisories/new` (or open a confidential security report on the repository) with:
- Affected file/function in `src/core/` or `src/forge/`
- Minimal reproduction scenario or Vitest case demonstrating a False-Safe (`transitionAllowed === true` on an invalid configuration) or CAS/ABA race condition.
