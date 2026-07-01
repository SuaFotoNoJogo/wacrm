/**
 * Normalizes text to NFC (precomposed) Unicode form.
 *
 * Postgres `=`/`ILIKE` compare bytes, not glyphs — "ã" typed in a
 * browser (NFC, U+00E3) and "ã" from a CSV exported by certain tools
 * (NFD, "a" + combining tilde U+0061 U+0303) look identical but never
 * match. Apply this at every write path that stores free-text values
 * (contact fields, custom field values, tag names) so comparisons
 * against user-typed filter input succeed.
 */
export function toNFC(value: string): string {
  return value.normalize('NFC');
}
