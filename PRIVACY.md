# Privacy Policy — LineLock for Jira

**Effective Date:** November 2026  
**Forge App Identifier:** `ari:cloud:ecosystem::app/806d313b-57d3-41d5-b781-73e48a1effe7`  
**Hosting & Data Residency:** 100% **Runs on Atlassian** (Atlassian Forge Compute + Atlassian Forge SQL TiDB)

## 1. Zero External Egress Guarantee
LineLock executes exclusively inside the Atlassian Forge isolated Node.js 22 runtime (`nodejs22.x`) and Native UI Kit 2 (`@forge/react`). Its `manifest.yml` declares **zero `permissions.external` egress URLs**. No customer Jira issue content, Bill-of-Materials (BOM) definitions, user account identifiers, or cryptographic digests ever leave Atlassian-managed cloud infrastructure.

## 2. Data Processed & Stored
LineLock accesses only the minimum Atlassian scopes required to verify Engineering Change Orders (ECOs):
- `read:jira-work`: Reads ECO work item status categories and linked Jira qualification work item summaries, descriptions, resolutions, and status categories to compute canonical RFC 8785 SHA-256 content hashes.
- `write:jira-work`: Used only when an authenticated user explicitly clicks **Provision 6 Live Jira Qualification Tests** or **Post Audit Record Comment to ECO**.
- `read:jira-user`: Verifies live Jira Project Role membership (including group-assigned role actors via `/rest/api/3/user/groups`) when validating human role attestations.
- `storage:app`: Persists per-ECO verification workspaces, monotonic `approvalGeneration` counters, optimistic Compare-and-Swap (`revision_seq`) rows, and generation-bound `RoleAttestation` records in per-installation Atlassian Forge SQL (`@forge/sql`).

## 3. AI / Rovo & Atlassian MCP Boundary
LineLock's Rovo Agent (`LineLock Assurance Analyst`) and Atlassian MCP server (`LineLock Verification MCP`) invoke strictly read-only (`actionVerb: GET`) deterministic kernel functions within Atlassian's tenant boundary. LineLock does not transmit customer data to third-party LLM providers.

## 4. Data Retention & Deletion
All workspace state resides inside the customer's tenant-isolated Atlassian Forge SQL database (`linelock_eco_workspaces` and `linelock_provisioning_audit`). Uninstalling LineLock from an Atlassian Cloud site schedules tenant storage deletion in accordance with Atlassian Forge platform data-lifecycle policies.
