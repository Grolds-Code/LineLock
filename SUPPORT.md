# LineLock support and installation checks

LineLock is a deterministic Jira engineering-evidence gate. It verifies
recorded evidence against affected product and serial configurations, but
does **not** certify physical safety, testing quality or regulatory compliance.

## 1. First-time installation

1. Install LineLock into a Jira Cloud **test** site using the shared Forge
   installation link. A shareable link has not yet been publicly verified
   for the Codegeist submission.
2. Open **LineLock Fleet Assurance** in the relevant Jira project.
3. Let the Forge SQL migrations reach `READY`. On a first installation,
   the per-site SQL cluster can be provisioned asynchronously. A project
   administrator can use **Run Idempotent SQL Migration Recovery**.
4. Create or identify a **dedicated Engineering Change Order issue type**.
   In the Fleet project page, select that type under **Release gate
   issue-type policy** and save it as a project administrator.
   The gate uses Jira's issue-type **ID**, not its editable name.
5. Configure the Jira workflow to attach **LineLock Effectivity-Aware
   Evidence Gate** to the intended release-to-Done transition. The manifest
   declares both company-managed and team-managed project types, but
   availability depends on the Jira workflow editor and must be tested
   in the target site. Do not attach the gate indiscriminately to shared
   Task/Story/Bug workflows.
6. Open a governed ECO issue, launch the **LineLock Assurance Cockpit**
   issue panel, and provision one of the demonstration industry templates.

An initialized LineLock ECO remains governed after ordinary label or summary
edits. The release gate blocks uninitialized governed ECOs. Other issue types
continue through ordinary shared workflows.

**Project moves:** LineLock records project identity at setup. If an ECO is
moved or the project identity changes, release fails closed until an
administrator reviews the new project and scope configuration. Never
reinterpret moved issue keys as authorization.

## 2. Qualification ticket creation and recovery

The six-ticket demonstration creates actual Jira Tasks, transitions them to
Done and links them to the ECO. Your Jira project must allow creation,
transition and issue linking, with a valid path to the Done status category.

A failed create, transition or link is not silently reported as success.

Each ticket creation is tracked in a per-ECO Forge SQL ledger with its
unique provisioning operation ID. A create-time Jira issue property
(`linelock.provenance`) binds it to the original ECO, template and evidence slot.

- If a ticket was created and its Jira ID was saved, **Provision** resumes
  that ticket instead of creating a replacement.
- If Jira might have created a ticket **before** LineLock saved its ID, the
  slot is marked `CREATING` and further automatic creation stops.
- In the ECO cockpit, choose **Inspect Provisioning Recovery**. Locate the
  actual Jira issue and enter its key in the recovery form. Only a project
  administrator may perform this operation.
- **Verify Jira Provenance and Recover Slot** checks the original operation
  ID and parent ECO against the issue's Jira property. An unrelated ticket
  will be rejected.
- After successful reconciliation, use the normal provision action to
  resume. If the ticket cannot be located with confidence, stop rather
  than risking a duplicate.

Do not delete or bypass a ledger row to force a retry; that defeats the
exactly-once recovery safety property.

## 3. Jira permissions and authorization

Interactive UI operations and Rovo access require Jira user permissions.
LineLock checks the caller through `api.asUser()` before exposing an ECO,
linked evidence or Fleet results.

Policy changes and governed issue-type setup require project administrator
authorization. Editing an ECO requires Edit Issues permissions, and
provisioning needs the applicable Create, Transition and Link capabilities.

The four Rovo actions are read-only. They must not sign, approve, change
a BOM, persist a release receipt, or trigger SQL migrations. If Jira user
consent is unavailable, a Rovo request fails closed instead of falling back
to app-level access.

**Issue Security:** Jira project Browse permission does not imply permission
to every ECO or evidence ticket. Restricted issue records are excluded from
the caller's Fleet view, including its page-level counts.

## 4. Approval policy

Under production multi-role governance, the ECO author or last editor cannot
self-approve. Required project-role members and separation of duties are
verified against live Jira memberships, including group actors.

The single-evaluator policy is **demonstration only** and displays an
explicit separation-of-duties waiver. It does not represent production
authorization. Switching policy increments the policy version and approval
generation, invalidating prior attestations.

## 5. Evidence integrity and scope

Newly pinned evidence uses v2 content hashing of selected Jira fields,
raw Atlassian Document Format and attachment metadata. Legacy records
without a version field retain their exact historical v1 hash semantics.
Re-pinning or upgrading evidence invalidates previous approval generations.

This does not hash attachment bytes or prove a laboratory result is valid.
A Done status and a matching hash are not substitutes for engineering review.

## 6. Fleet display

Fleet is paginated at **25 caller-visible ECOs**. Its totals and charts are
per-page, not global project counts when more records exist. A restricted
ECO must not appear indirectly in totals or pagination.

## 7. Common failures

**Panel not loading:** Browser privacy features can block Atlassian's
cross-origin Forge UI bridge. Check the browser's site permissions and try
a standard supported browser.

**Storage not READY:** Use the administrator's recovery control. The release
validator fails closed until migrations complete.

**No direct Done transition:** Configure the issue workflow or provide a
permitted intermediate status path. The provisioner must not claim Done.

**Rovo cannot inspect:** Check the user's Jira issue/evidence permissions
and Rovo consent. Do not fix access by supplying an app-wide token.

**Project administrator controls absent:** Check live Jira
`ADMINISTER_PROJECTS` permission and the user's group-based role membership.

## 8. Submission readiness

Run `npm run verify`, `forge lint`, a clean Forge development deployment
and `forge eligibility`. Verify the issue panel, project page, validator
and Rovo Chat on a fresh Jira Cloud site. Only then create a judge-accessible
installation link and record the public YouTube demonstration.

See [Codegeist submission and testing checklist](docs/CODEGEIST_2026_SUBMISSION.md)
for the remaining release gates.

For issues, use https://github.com/Grolds-Code/LineLock/issues.
