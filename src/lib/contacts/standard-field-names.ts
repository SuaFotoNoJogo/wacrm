/**
 * Custom field names that shadow a built-in contact field (name, phone,
 * email, company, tags). These can end up in `custom_fields` from a
 * mistaken manual entry in Settings — they're never created by CSV
 * import, which routes these column headers to the real contact
 * columns / tag system instead. Anywhere custom fields are listed for
 * a human to pick from, filter these out so the built-in field isn't
 * shadowed by a same-named (and usually empty) custom field.
 */
export const STANDARD_FIELD_NAMES = ['name', 'phone', 'email', 'company', 'tags'];

export function isStandardFieldName(fieldName: string): boolean {
  return STANDARD_FIELD_NAMES.includes(fieldName.toLowerCase());
}
