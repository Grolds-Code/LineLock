# LineLock cloud-only Jira test deployment

Target: **one-atlas-sadl.atlassian.net**, `development` environment, Forge app ID
`806d313b-57d3-41d5-b781-73e48a1effe7`.

This workflow is for the **draft feature branch**. Do not merge into `main`,
upgrade production, or publish a judge installation link until live checks pass.

## Step A — create the dedicated Jira ECO work type

The current `ECO` company-managed project (ID `10202`) has **no**
dedicated Engineering Change Order issue type. Existing ECO-1 is a Bug; ECO-14
is an Epic; linked evidence issues are Tasks.

In Jira Cloud administration (requires **Administer Jira**, a site-wide
permission), open **Settings → Work items → Work types → Add work type**.
Create a **standard** work type:

- **Name:** `Engineering Change Order`
- **Description:** `Controlled hardware engineering changes subject to LineLock evidence and approval verification.`

Associate it with the work-type scheme assigned to project `ECO`, keeping all
existing Epic, Story, Bug, Task, and Sub-task types. Avoid replacing or
removing the scheme's existing work types, and **do not migrate the 20 existing
test issues** at this stage.

Verify in Jira's new-issue dialog that `Engineering Change Order` can be
selected for project `ECO`.

## Step B — use GitHub Codespaces (no local PC setup)

1. Open the [LineLock repository](https://github.com/Grolds-Code/LineLock).
2. Select branch `fix/codegeist-winning-hardening-20261124`.
3. Choose **Code → Codespaces → Create codespace**. The repo's
   `.devcontainer/devcontainer.json` initializes Node.js and dependencies.
4. Generate or use a dedicated Atlassian **scoped** API token for the
   account that owns the Forge app. **Never paste a token into a chat,
   GitHub issue, commit, or terminal log.**
5. Configure **Codespaces secrets** in GitHub Settings:
   `FORGE_EMAIL` (the Forge app owner's Atlassian login email) and
   `FORGE_API_TOKEN` (the token). Grant secret access only to
   `Grolds-Code/LineLock`. Restart the Codespace after adding secrets.
6. From the Codespace terminal, on the feature branch, run:

   ```bash
   LINELOCK_CONFIRM_DEV_SITE=one-atlas-sadl.atlassian.net \
     bash scripts/forge-dev-deploy.sh
   ```

The script refuses an unconfirmed site or wrong app ID. It runs full CI,
Forge lint, development-only deployment, installation upgrade, and Forge
eligibility in that order. Read all output and save the eligibility result.
If permissions require additional admin approval, stop and review rather
than trying a production deployment.

The ChatGPT Atlassian connector can read Jira configuration and work items,
but **cannot use your Forge CLI credentials or deploy app code**. Codespaces
keeps deployment cloud-based while your token stays in GitHub secrets.

## Step C — finish the live test, do not infer its outcome

After the updated Forge app is installed:

1. Open the **LineLock Fleet Assurance** project page.
2. Under **Release gate issue-type policy**, choose the newly created
   `Engineering Change Order` work type and save it as a project admin.
3. Attach **LineLock Effectivity-Aware Evidence Gate** to the relevant
   release-to-Done workflow transition for this work type. Avoid applying
   it to shared Task workflows.
4. Create a **new**, disposable, clearly labelled test ECO. Do not reuse
   Done `ECO-1` or mutate existing `ECO-14` for the first release-gate test.
5. Test negative and positive transitions, evidence creation/linking,
   rollback-safe provisioning, Rovo issue permissions and consent,
   release-receipt reconciliation, and Fleet visibility.
6. Record a real demo only after these checks pass, then request the
   appropriate Forge development install/distribution link for judges.

### Evidence to retain

- Commit SHA and final GitHub Actions run
- `forge lint` output
- Forge development deployment version and installation outcome
- `forge eligibility` output with reasons, if any
- Screenshots of denied and allowed ECO Done transitions
- Screenshots/recording of real issue panel, Fleet and Rovo
- Actual installation and public YouTube demo URLs

**A green GitHub unit test suite is not proof of live Forge/Jira behavior.**
