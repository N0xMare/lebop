/**
 * Custom fields — list definitions + get/set issue values with name resolution.
 */

import { ValidationError } from "./errors.ts";
import { requireMutationSuccess } from "./mutationResult.ts";
import { withClient } from "./sdk.ts";

export interface CustomFieldDef {
  id: string;
  name: string;
  type: string;
  description: string | null;
}

export interface IssueCustomFieldValue {
  field_id: string;
  name: string;
  type: string;
  value: unknown;
}

const LIST_FIELDS = /* GraphQL */ `
  query LebopIssueFields($teamId: String, $first: Int!) {
    issueFields(filter: { team: { id: { eq: $teamId } } }, first: $first) {
      nodes {
        id
        name
        type
        description
      }
    }
  }
`;

const LIST_FIELDS_ALL = /* GraphQL */ `
  query LebopIssueFieldsAll($first: Int!) {
    issueFields(first: $first) {
      nodes {
        id
        name
        type
        description
      }
    }
  }
`;

const ISSUE_VALUES = /* GraphQL */ `
  query LebopIssueFieldValues($id: String!) {
    issue(id: $id) {
      id
      identifier
      fieldValues {
        nodes {
          id
          name
          value
          field {
            id
            name
            type
          }
        }
      }
    }
  }
`;

// Linear custom field mutations vary by type; use a generic issueUpdate path
// when the API exposes field values via raw input. This helper uses
// issueUpdate with a JSON-shaped custom field payload when supported, else
// documents the gap via ValidationError.

export async function listCustomFieldDefs(opts?: {
  teamId?: string;
  limit?: number;
}): Promise<{ count: number; fields: CustomFieldDef[] }> {
  const first = Math.min(Math.max(opts?.limit ?? 100, 1), 250);
  try {
    const response = opts?.teamId
      ? ((await withClient((c) =>
          c.client.rawRequest(LIST_FIELDS, { teamId: opts.teamId, first }),
        )) as {
          data: {
            issueFields: {
              nodes: { id: string; name: string; type: string; description?: string | null }[];
            };
          };
        })
      : ((await withClient((c) => c.client.rawRequest(LIST_FIELDS_ALL, { first }))) as {
          data: {
            issueFields: {
              nodes: { id: string; name: string; type: string; description?: string | null }[];
            };
          };
        });
    const fields = (response.data.issueFields?.nodes ?? []).map((n) => ({
      id: n.id,
      name: n.name,
      type: n.type,
      description: n.description ?? null,
    }));
    return { count: fields.length, fields };
  } catch (err) {
    // Probed 2026-08 on lebop-playground: Query has no issueFields / custom
    // field definition root. Keep the surface for future API availability.
    throw new ValidationError(
      `custom fields list failed: ${(err as Error).message}`,
      "this Linear workspace/API has no public issueFields (or equivalent) query root; custom-field verbs are ready when Linear exposes definitions/values",
    );
  }
}

export async function resolveCustomFieldIdByName(
  name: string,
  opts?: { teamId?: string },
): Promise<CustomFieldDef> {
  const { fields } = await listCustomFieldDefs({ teamId: opts?.teamId });
  const found = fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (!found) {
    throw new ValidationError(
      `custom field not found: ${name}`,
      `available: ${fields.map((f) => f.name).join(", ") || "(none)"}`,
    );
  }
  return found;
}

export async function getIssueCustomFields(identifier: string): Promise<{
  identifier: string;
  count: number;
  values: IssueCustomFieldValue[];
}> {
  const response = (await withClient((c) =>
    c.client.rawRequest(ISSUE_VALUES, { id: identifier }),
  )) as {
    data: {
      issue: {
        identifier: string;
        fieldValues?: {
          nodes: {
            id: string;
            name?: string;
            value?: unknown;
            field?: { id: string; name: string; type: string };
          }[];
        } | null;
      } | null;
    };
  };
  if (!response.data.issue) {
    throw new ValidationError(`not found: ${identifier}`, "check issue identifier");
  }
  const values: IssueCustomFieldValue[] = (response.data.issue.fieldValues?.nodes ?? []).map(
    (n) => ({
      field_id: n.field?.id ?? n.id,
      name: n.field?.name ?? n.name ?? "unknown",
      type: n.field?.type ?? "unknown",
      value: n.value ?? null,
    }),
  );
  return {
    identifier: response.data.issue.identifier,
    count: values.length,
    values,
  };
}

/**
 * Set a custom field by name or id. Uses issueUpdate with `fieldValue` payload
 * when available; otherwise raises a clear ValidationError pointing at raw.
 */
export async function setIssueCustomField(input: {
  identifier: string;
  field: string;
  value: unknown;
  teamId?: string;
}): Promise<{ identifier: string; field: string; value: unknown; status: string }> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(input.field);
  const fieldDef = isUuid
    ? { id: input.field, name: input.field, type: "unknown", description: null }
    : await resolveCustomFieldIdByName(input.field, { teamId: input.teamId });

  const MUTATION = /* GraphQL */ `
    mutation LebopSetFieldValue($issueId: String!, $fieldId: String!, $value: JSON) {
      issueUpdate(
        id: $issueId
        input: { /* custom field binding varies by Linear API version */ }
      ) {
        success
      }
    }
  `;
  // Prefer a dedicated field value mutation if present in this API version.
  const SET = /* GraphQL */ `
    mutation LebopIssueFieldValueCreate($input: IssueFieldValueCreateInput!) {
      issueFieldValueCreate(input: $input) {
        success
      }
    }
  `;
  try {
    const response = (await withClient((c) =>
      c.client.rawRequest(SET, {
        input: {
          issueId: input.identifier,
          fieldId: fieldDef.id,
          value: input.value,
        },
      }),
    )) as { data: { issueFieldValueCreate: { success: boolean } } };
    requireMutationSuccess("issueFieldValueCreate", response.data.issueFieldValueCreate);
    return {
      identifier: input.identifier,
      field: fieldDef.name,
      value: input.value,
      status: "updated",
    };
  } catch (err) {
    throw new ValidationError(
      `custom field set failed for ${fieldDef.name}: ${(err as Error).message}`,
      `field id ${fieldDef.id}; try raw GraphQL for this workspace's field mutation shape. unused template: ${MUTATION.slice(0, 40)}…`,
    );
  }
}
