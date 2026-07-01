-- ============================================================
-- 028_normalize_unicode_text.sql
--
-- Backfills free-text columns to NFC (precomposed) Unicode form.
--
-- Root cause: text imported via CSV (contacts, custom field values,
-- tags) can arrive in NFD (decomposed) form — e.g. "ã" stored as
-- "a" + a combining tilde (U+0061 U+0303) instead of the single
-- precomposed codepoint (U+00E3) a browser produces when a user
-- types it. Both render identically on screen, but Postgres `=` and
-- `ILIKE` compare bytes, not glyphs, so a broadcast custom-field
-- filter like `clube contains "São Paulo"` silently matched zero
-- rows even though 1,000+ contacts had that exact value.
--
-- The app now normalizes to NFC on every write path (CSV import,
-- contact form, broadcast audience filters — see toNFC() in
-- src/lib/text/unicode.ts). This migration is the one-time cleanup
-- for data written before that fix. Only rows whose normalized form
-- actually differs are touched, so this is a no-op on already-NFC
-- data (the common case, e.g. anything typed directly in the UI).
-- ============================================================

UPDATE contacts
SET name = normalize(name, NFC)
WHERE name IS NOT NULL AND name <> normalize(name, NFC);

UPDATE contacts
SET email = normalize(email, NFC)
WHERE email IS NOT NULL AND email <> normalize(email, NFC);

UPDATE contacts
SET company = normalize(company, NFC)
WHERE company IS NOT NULL AND company <> normalize(company, NFC);

UPDATE contact_custom_values
SET value = normalize(value, NFC)
WHERE value IS NOT NULL AND value <> normalize(value, NFC);

UPDATE custom_fields
SET field_name = normalize(field_name, NFC)
WHERE field_name <> normalize(field_name, NFC);

UPDATE tags
SET name = normalize(name, NFC)
WHERE name <> normalize(name, NFC);
