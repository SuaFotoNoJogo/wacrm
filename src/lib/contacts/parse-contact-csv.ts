/**
 * CSV parsing for the contacts import modal. Shared + unit-tested so
 * tag-column handling stays aligned with phone/name/email/company.
 */

import { toNFC } from '@/lib/text/unicode';

export interface ParsedContactRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  /** Tag names from the optional `tags` column (comma/semicolon separated). */
  tagNames: string[];
  /** Custom field values: map from field_name to value string. */
  customFieldValues: Record<string, string>;
}

/** Split a CSV cell into unique tag names (case-insensitive de-dupe). */
export function parseTagCell(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  const seen = new Set<string>();
  const names: string[] = [];

  for (const part of value.split(/[,;]/)) {
    const name = toNFC(part.trim());
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names;
}

export interface ParseContactCsvResult {
  rows: ParsedContactRow[];
  /** True when the CSV header includes a `tags` column. */
  hasTagsColumn: boolean;
  /** True when the CSV header includes a `company` column. */
  hasCompanyColumn: boolean;
  /** Names of custom fields detected in the CSV header. */
  customFieldNames: string[];
}

export function parseContactCsv(text: string): ParseContactCsvResult {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) {
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false, customFieldNames: [] };
  }

  const headers = lines[0]
    .split(',')
    .map((h) => toNFC(h.trim().toLowerCase().replace(/["']/g, '')));

  const phoneIdx = headers.indexOf('phone');
  if (phoneIdx === -1) {
    return { rows: [], hasTagsColumn: false, hasCompanyColumn: false, customFieldNames: [] };
  }

  const nameIdx = headers.indexOf('name');
  const emailIdx = headers.indexOf('email');
  const companyIdx = headers.indexOf('company');
  const tagsIdx = headers.indexOf('tags');

  // Detect custom field columns: any header not in the standard set
  const standardHeaders = new Set(['phone', 'name', 'email', 'company', 'tags']);
  const customFieldNames = headers
    .map((h, idx) => ({ name: h, idx }))
    .filter(({ name }) => !standardHeaders.has(name))
    .map(({ name }) => name);

  const customFieldIndices = customFieldNames.map((name) => headers.indexOf(name));

  const rows: ParsedContactRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCsvLine(line);
    const phone = values[phoneIdx]?.replace(/["']/g, '').trim();
    if (!phone) continue;

    const customFieldValues: Record<string, string> = {};
    for (let j = 0; j < customFieldNames.length; j++) {
      const fieldName = customFieldNames[j];
      const fieldIdx = customFieldIndices[j];
      const value = toNFC(values[fieldIdx]?.replace(/["']/g, '').trim() ?? '');
      if (value) {
        customFieldValues[fieldName] = value;
      }
    }

    rows.push({
      phone,
      name:
        nameIdx >= 0
          ? toNFC(values[nameIdx]?.replace(/["']/g, '').trim() ?? '') || undefined
          : undefined,
      email:
        emailIdx >= 0
          ? toNFC(values[emailIdx]?.replace(/["']/g, '').trim() ?? '') || undefined
          : undefined,
      company:
        companyIdx >= 0
          ? toNFC(values[companyIdx]?.replace(/["']/g, '').trim() ?? '') || undefined
          : undefined,
      tagNames:
        tagsIdx >= 0 ? parseTagCell(values[tagsIdx]?.replace(/["']/g, '')) : [],
      customFieldValues,
    });
  }

  return {
    rows,
    hasTagsColumn: tagsIdx >= 0,
    hasCompanyColumn: companyIdx >= 0,
    customFieldNames,
  };
}

/** Simple CSV line parse (handles quoted fields). */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}
