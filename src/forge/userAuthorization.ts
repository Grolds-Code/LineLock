import api, { route } from "@forge/api";

/**
 * Permission checks for interactive Jira and Rovo entrypoints.
 * Never use asApp fallback for a user-controlled read or mutation.
 */
export class InteractiveAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InteractiveAccessDeniedError";
  }
}

interface PermissionsResponse {
  readonly permissions?: Readonly<Record<string, { readonly havePermission?: boolean }>>;
}

export async function assertUserCanReadIssue(issueIdOrKey: string): Promise<void> {
  const id = issueIdOrKey.trim();
  if (!id) throw new InteractiveAccessDeniedError("A Jira issue identifier is required.");
  try {
    const response = await api.asUser().requestJira(
      route`/rest/api/3/issue/${id}?fields=project,issuetype`
    );
    if (!response.ok) {
      throw new InteractiveAccessDeniedError(
        "The current user cannot access this Jira issue or has not granted required consent."
      );
    }
  } catch {
    throw new InteractiveAccessDeniedError(
      "Jira did not authorize access to the requested issue. Check permissions and consent."
    );
  }
}

export async function assertUserCanReadProject(projectKey: string): Promise<void> {
  const key = projectKey.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new InteractiveAccessDeniedError("A valid Jira project key is required.");
  }
  try {
    const response = await api.asUser().requestJira(route`/rest/api/3/project/${key}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    throw new InteractiveAccessDeniedError(
      "Jira did not authorize access to the requested project. Check permissions and consent."
    );
  }
}

export async function assertUserIssuePermissions(
  issueId: string,
  permissions: readonly string[]
): Promise<void> {
  await assertUserCanReadIssue(issueId);
  await checkUserPermissions(
    route`/rest/api/3/mypermissions?issueId=${issueId}&permissions=${permissions.join(",")}`,
    permissions
  );
}

export async function assertUserProjectPermissions(
  projectKey: string,
  permissions: readonly string[]
): Promise<void> {
  await assertUserCanReadProject(projectKey);
  await checkUserPermissions(
    route`/rest/api/3/mypermissions?projectKey=${projectKey}&permissions=${permissions.join(",")}`,
    permissions
  );
}

async function checkUserPermissions(
  path: ReturnType<typeof route>,
  permissions: readonly string[]
): Promise<void> {
  if (permissions.length === 0) return;
  let result: PermissionsResponse;
  try {
    const response = await api.asUser().requestJira(path);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    result = (await response.json()) as PermissionsResponse;
  } catch {
    throw new InteractiveAccessDeniedError(
      "Jira could not verify the current user's permissions. No privileged operation was performed."
    );
  }
  const missing = permissions.filter((p) => result.permissions?.[p]?.havePermission !== true);
  if (missing.length) {
    throw new InteractiveAccessDeniedError(
      `The current user lacks required Jira permission: ${missing.join(", ")}.`
    );
  }
}
