# Support & Troubleshooting — LineLock

## Common Setup Checks

1. **LineLock Panel Loading Spinner in Brave Browser:**
   - Brave Shields blocks Atlassian Forge's cross-origin `atlassian-dev.net` Native UI Kit iframe bridge by default. Click the **Brave Lion icon** on `<your-site>.atlassian.net` and toggle **Shields OFF** for your Jira site (or use Chrome / Edge / Firefox).
2. **Attaching the Native Jira Workflow Gate (`jira:workflowValidator`):**
   - Ensure your Jira Software space is **Company-managed**.
   - Go to **Space settings $\rightarrow$ Workflows $\rightarrow$ Edit workflow** (`Text` tab) $\rightarrow$ select the **`Done`** transition $\rightarrow$ **Rules $\rightarrow$ Validate details (`+`)** $\rightarrow$ add **`LineLock Effectivity-Aware Evidence Gate`** $\rightarrow$ **Update workflow**.
3. **Cold-Install Forge SQL Cluster Provisioning (`PROVISIONING_IN_PROGRESS`):**
   - On a brand-new site installation, Atlassian Forge provisions the per-tenant TiDB SQL cluster asynchronously via `avi:forge:installed:app`. LineLock fails closed until schema migrations reach `READY`, and provides a 1-click **Run Idempotent SQL Migration Recovery** button in both the Issue Cockpit and the **LineLock Fleet Assurance** project page.
4. **Role Attestation Authorization (`UNAUTHORIZED_ACTOR`):**
   - LineLock verifies live Jira Project Role membership (`Space settings -> People`). Under *Production Multi-Role Policy*, separation-of-duties prevents the ECO author/editor from signing their own proposal. For single-user evaluations, switch to **Solo-Evaluator Demo Policy (`Administrators` Role)** and ensure your account (or one of your Jira groups) holds the `Administrators` role in the space.

## Filing Issues
Open a structured bug report or industry template request at `https://github.com/Grolds-Code/LineLock/issues`.
