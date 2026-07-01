import { cn } from '@/lib/utils';
import { Tag } from 'lucide-react';
import type { ParsedContactRow } from '@/lib/contacts/parse-contact-csv';

const DEFAULT_TAG_COLOR = '#3b82f6';

export function truncateFilename(name: string, max = 48): string {
  if (name.length <= max) return name;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const base = name.slice(0, name.length - ext.length);
  const keep = max - ext.length - 1;
  return `${base.slice(0, Math.max(keep, 12))}…${ext}`;
}

export function PreviewCell({
  value,
  mono,
  maxWidth = 'max-w-[9rem]',
}: {
  value: string;
  mono?: boolean;
  maxWidth?: string;
}) {
  return (
    <span
      className={cn('block truncate', maxWidth, mono && 'font-mono text-[11px]')}
      title={value}
    >
      {value}
    </span>
  );
}

export function ImportPreviewTags({
  tagNames,
  tagColorByKey,
}: {
  tagNames: string[];
  tagColorByKey: Map<string, string>;
}) {
  if (tagNames.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }

  return (
    <div className="flex min-w-[4.5rem] flex-wrap gap-1">
      {tagNames.map((name) => {
        const color = tagColorByKey.get(name.trim().toLowerCase()) ?? DEFAULT_TAG_COLOR;
        const isKnown = tagColorByKey.has(name.trim().toLowerCase());
        return (
          <span
            key={name}
            className="inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[10px] leading-none font-medium"
            style={{
              backgroundColor: `${color}18`,
              color,
              border: `1px solid ${color}${isKnown ? '55' : '30'}`,
            }}
            title={isKnown ? name : `${name} (will be created on import)`}
          >
            <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
            <span className="truncate">{name}</span>
          </span>
        );
      })}
    </div>
  );
}

interface CsvImportPreviewTableProps {
  /** Every parsed row — the table only renders the first `previewLimit`. */
  rows: ParsedContactRow[];
  previewLimit: number;
  /** All custom field column names detected in the CSV header. */
  customFieldNames: string[];
  /** Known tag name (lowercased) → color, for the tag chip preview. */
  tagColorByKey: Map<string, string>;
  /**
   * The CSV declared a `tags`/`company` header, even if every preview row
   * happens to be blank — shows the column anyway so the header choice is
   * still visible for validation. Data presence in the preview rows also
   * shows the column regardless of this flag.
   */
  hasTagsColumn?: boolean;
  hasCompanyColumn?: boolean;
}

/**
 * Full-fidelity CSV preview table shared between the Contacts "Import
 * Contacts" modal and the Broadcast "Upload CSV" audience modal — same
 * columns (phone/name/email/company/tags/custom fields), same truncation
 * and tag-chip rendering, so a CSV previews identically in both places.
 */
export function CsvImportPreviewTable({
  rows,
  previewLimit,
  customFieldNames,
  tagColorByKey,
  hasTagsColumn,
  hasCompanyColumn,
}: CsvImportPreviewTableProps) {
  const preview = rows.slice(0, previewLimit);
  // Tags: OR — show when the CSV declares the column or preview rows
  // carry values, so an all-empty tags column still renders for
  // validation. Company: AND — hide unless the CSV declares the column
  // *and* preview has data, avoiding an all-dash column that wastes
  // horizontal space in a compact modal.
  const previewHasTags = hasTagsColumn || preview.some((row) => row.tagNames.length > 0);
  const previewHasCompany = !!hasCompanyColumn && preview.some((row) => row.company?.trim());
  const previewCustomFields = customFieldNames.filter((fieldName) =>
    preview.some((row) => row.customFieldValues[fieldName]?.trim()),
  );

  const tagStats = (() => {
    const names = new Set<string>();
    let rowsWithTags = 0;
    for (const row of rows) {
      if (row.tagNames.length === 0) continue;
      rowsWithTags++;
      for (const name of row.tagNames) names.add(name.trim().toLowerCase());
    }
    return { unique: names.size, rowsWithTags };
  })();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
          Preview · first {preview.length}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {tagStats.rowsWithTags > 0 && (
            <span className="inline-flex items-center gap-1 rounded-md bg-muted/90 px-2 py-0.5 text-[11px] text-muted-foreground">
              <Tag className="text-primary/80 size-3" />
              {tagStats.unique} tag{tagStats.unique !== 1 ? 's' : ''} ·{' '}
              {tagStats.rowsWithTags} contact{tagStats.rowsWithTags !== 1 ? 's' : ''}
            </span>
          )}
          {customFieldNames.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-md bg-muted/90 px-2 py-0.5 text-[11px] text-muted-foreground">
              {customFieldNames.length} custom field{customFieldNames.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border ring-1 ring-border/50">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-xs">
            <thead>
              <tr className="border-b border-border bg-background/60">
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                  Phone
                </th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                  Name
                </th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                  Email
                </th>
                {previewHasCompany && (
                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                    Company
                  </th>
                )}
                {previewHasTags && (
                  <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                    Tags
                  </th>
                )}
                {previewCustomFields.map((fieldName) => (
                  <th
                    key={fieldName}
                    className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground"
                  >
                    {fieldName}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {preview.map((row, i) => (
                <tr key={i} className="bg-popover/40 transition-colors hover:bg-muted/30">
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                    <PreviewCell value={row.phone} mono maxWidth="max-w-[7.5rem]" />
                  </td>
                  <td className="px-3 py-2 text-popover-foreground">
                    <PreviewCell value={row.name || '—'} maxWidth="max-w-[8.5rem]" />
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    <PreviewCell value={row.email || '—'} maxWidth="max-w-[10rem]" />
                  </td>
                  {previewHasCompany && (
                    <td className="px-3 py-2 text-muted-foreground">
                      <PreviewCell value={row.company || '—'} maxWidth="max-w-[7rem]" />
                    </td>
                  )}
                  {previewHasTags && (
                    <td className="px-3 py-2 align-top">
                      <ImportPreviewTags tagNames={row.tagNames} tagColorByKey={tagColorByKey} />
                    </td>
                  )}
                  {previewCustomFields.map((fieldName) => (
                    <td key={fieldName} className="px-3 py-2 text-muted-foreground">
                      <PreviewCell
                        value={row.customFieldValues[fieldName] || '—'}
                        maxWidth="max-w-[8rem]"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {rows.length > previewLimit && (
        <p className="text-center text-[11px] text-muted-foreground">
          + {rows.length - previewLimit} more row{rows.length - previewLimit !== 1 ? 's' : ''} not
          shown
        </p>
      )}
    </div>
  );
}
