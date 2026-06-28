import type { SupabaseClient } from '@supabase/supabase-js';

export interface ResolveImportCustomFieldsResult {
  /** Custom field name → custom field id. */
  fieldIdByName: Map<string, string>;
  /** Names that could not be matched (field doesn't exist). */
  skippedNames: string[];
}

/**
 * Resolve custom field names from a CSV import to custom field IDs.
 * Only existing account custom fields are matched (no auto-creation).
 */
export async function resolveImportCustomFieldIds(
  supabase: SupabaseClient,
  params: {
    accountId: string;
    fieldNames: string[];
  }
): Promise<ResolveImportCustomFieldsResult> {
  const { accountId, fieldNames } = params;

  const uniqueNames: string[] = [];
  const seen = new Set<string>();
  for (const raw of fieldNames) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueNames.push(name);
  }

  if (uniqueNames.length === 0) {
    return { fieldIdByName: new Map(), skippedNames: [] };
  }

  const { data: existing, error: fetchError } = await supabase
    .from('custom_fields')
    .select('id, field_name')
    .eq('account_id', accountId);

  if (fetchError) throw fetchError;

  const fieldIdByName = new Map<string, string>();
  const existingLower = new Map<string, string>();
  for (const field of existing ?? []) {
    const key = field.field_name.trim().toLowerCase();
    if (!existingLower.has(key)) existingLower.set(key, field.id);
  }

  const skippedNames: string[] = [];

  for (const name of uniqueNames) {
    const key = name.toLowerCase();
    const fieldId = existingLower.get(key);
    if (fieldId) {
      fieldIdByName.set(name, fieldId);
    } else {
      skippedNames.push(name);
    }
  }

  return { fieldIdByName, skippedNames };
}

export interface ContactCustomFieldAssignment {
  contactId: string;
  fieldId: string;
  value: string;
}

/**
 * Insert contact_custom_values rows for imported contacts.
 * Returns the number of values inserted.
 */
export async function assignImportedContactCustomValues(
  supabase: SupabaseClient,
  assignments: ContactCustomFieldAssignment[]
): Promise<number> {
  if (assignments.length === 0) return 0;

  const rows = assignments.map(({ contactId, fieldId, value }) => ({
    contact_id: contactId,
    custom_field_id: fieldId,
    value,
  }));

  const chunkSize = 100;
  let assigned = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from('contact_custom_values').upsert(chunk, {
      onConflict: 'contact_id,custom_field_id',
      ignoreDuplicates: false,
    });
    if (error) throw error;
    assigned += chunk.length;
  }

  return assigned;
}
