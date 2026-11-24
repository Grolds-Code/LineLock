# Privacy Policy — LineLock for Jira

**Effective Date:** November 2026  
**Forge App Identifier:** `ari:cloud:ecosystem::app/806d313b-57d3-41d5-b781-73e48a1effe7`  
**Architecture:** Atlassian Forge compute and Forge SQL storage. Official **Runs on Atlassian** eligibility remains to be verified with `forge eligibility`. Customer-specific residency guarantees depend on the Atlassian platform.

## 1. No Declared External Network Egress
LineLock executes exclusively inside the Atlassian Forge isolated Node.js 22 runtime (`nodejs22.x`) and Native UI Kit 2 (`@forge/react`). Its `manifest.yml` declares **zero `permissions.external` egress URLs**. LineLock declares no app-controlled external egress permissions. Rovo and Jira data processing remain subject to Atlassian's platform terms and site configuration; the absence of external app egress alone is not an independent data-residency certification.

## 2. Data Processed & Stored
LineLock accesses only the minimum Atlassian scopes required to verify Engineering Change Orders (ECOs):
- `read:jira-work`: Reads ECO and evidence issue status, summaries, ADF descriptions, selected fields, and attachment metadata for versioned SHA-256 evidence projections. Attachment binary contents are not hashed.
- `write:jira-work`: Supports authorized Jira issue creation, qualification transitions and links, and explicit audit comments. Governance and BOM edits persist in Forge SQL behind Jira permission checks.
- `read:jira-user`: Verifies live Jira Project Role membership (including group-assigned role actors via `/rest/api/3/user/groups`) when validating human role attestations.
- `storage:app`: Persists governed ECO workspaces, generation-bound attestations, project issue-type policy configuration, and per-evidence-slot provisioning checkpoints in Forge SQL (`@forge/sql`).

## 3. AI / Rovo Boundary
LineLock's Rovo Agent (`LineLock Assurance Analyst`) invokes four read-only (`actionVerb: GET`) deterministic analysis actions. The Rovo Jira gateway uses the invoking user's Jira token and never falls back to app privileges. LineLock code has no explicit third-party LLM integration; any Atlassian Rovo processing is governed by Atlassian's own policies. Its GET actions must not approve releases or write SQL.

## 4. Data Retention & Deletion
All workspace state resides inside the customer's tenant-isolated Atlassian Forge SQL database (`linelock_eco_workspaces` and `linelock_provisioning_audit`). Uninstallation and data retention follow Atlassian Forge's applicable storage lifecycle and retention policies; deletion should not be assumed to be instantaneous.
