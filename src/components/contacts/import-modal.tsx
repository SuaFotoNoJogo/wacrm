'use client';

import { useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  dedupeByPhone,
  isUniqueViolation,
  normalizeKey,
} from '@/lib/contacts/dedupe';
import {
  parseContactCsv,
  type ParsedContactRow,
} from '@/lib/contacts/parse-contact-csv';
import {
  assignImportedContactTags,
  resolveImportTagIds,
  type ContactTagAssignment,
} from '@/lib/contacts/resolve-import-tags';
import {
  assignImportedContactCustomValues,
  resolveImportCustomFieldIds,
  type ContactCustomFieldAssignment,
} from '@/lib/contacts/resolve-import-custom-fields';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Upload,
  FileText,
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { CsvImportPreviewTable, truncateFilename } from './csv-import-preview';

const PREVIEW_LIMIT = 5;

interface ImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

export function ImportModal({
  open,
  onOpenChange,
  onImported,
}: ImportModalProps) {
  const supabase = createClient();
  const { accountId, canEditSettings } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedContactRow[]>([]);
  const [hasTagsColumn, setHasTagsColumn] = useState(false);
  const [hasCompanyColumn, setHasCompanyColumn] = useState(false);
  const [customFieldNames, setCustomFieldNames] = useState<string[]>([]);
  const [tagColorByKey, setTagColorByKey] = useState<Map<string, string>>(
    new Map()
  );
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{
    imported: number;
    skipped: number;
    failed: number;
    tagsAssigned: number;
    customFieldsAssigned: number;
  } | null>(null);

  function reset() {
    setFile(null);
    setParsedRows([]);
    setHasTagsColumn(false);
    setHasCompanyColumn(false);
    setCustomFieldNames([]);
    setTagColorByKey(new Map());
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;

    setFile(selected);
    setResult(null);

    const text = await selected.text();
    const {
      rows,
      hasTagsColumn: csvHasTags,
      hasCompanyColumn: csvHasCompany,
      customFieldNames: csvCustomFields,
    } = parseContactCsv(text);

    if (rows.length === 0) {
      toast.error(
        'No valid rows found. Ensure CSV has a "phone" column header.'
      );
      setParsedRows([]);
      setHasTagsColumn(false);
      setHasCompanyColumn(false);
      setCustomFieldNames([]);
      setTagColorByKey(new Map());
      return;
    }

    setParsedRows(rows);
    setHasTagsColumn(csvHasTags);
    setHasCompanyColumn(csvHasCompany);
    setCustomFieldNames(csvCustomFields);

    if (csvHasTags && accountId) {
      const { data: tags } = await supabase
        .from('tags')
        .select('name, color')
        .eq('account_id', accountId);

      const colors = new Map<string, string>();
      for (const tag of tags ?? []) {
        const key = tag.name.trim().toLowerCase();
        if (!colors.has(key)) colors.set(key, tag.color);
      }
      setTagColorByKey(colors);
    } else {
      setTagColorByKey(new Map());
    }
  }

  async function handleImport() {
    if (parsedRows.length === 0) return;
    setImporting(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error('Not authenticated');
      if (!accountId)
        throw new Error('Your profile is not linked to an account.');

      let imported = 0;
      let skipped = 0;
      let failed = 0;

      // 1) De-dupe within the file by normalized phone (keep first).
      const { unique, duplicates: inFileDupes } = dedupeByPhone(parsedRows);
      skipped += inFileDupes;

      // 2) Skip numbers already in this account. One read of the
      //    generated `phone_normalized` column (migration 022) → Set.
      const { data: existingRows } = await supabase
        .from('contacts')
        .select('phone_normalized')
        .eq('account_id', accountId);
      const existing = new Set(
        (existingRows ?? [])
          .map(
            (r) => (r as { phone_normalized: string | null }).phone_normalized
          )
          .filter((p): p is string => !!p)
      );

      const toInsert = unique.filter((row) => {
        if (existing.has(normalizeKey(row.phone))) {
          skipped++;
          return false;
        }
        return true;
      });

      // 3) Resolve tag names → ids (admin+ may auto-create missing tags).
      //    Skip the round-trip when the import carries no tag names.
      const allTagNames = toInsert.flatMap((row) => row.tagNames);
      let tagIdByKey = new Map<string, string>();
      let skippedNames: string[] = [];
      if (allTagNames.length > 0) {
        ({ tagIdByKey, skippedNames } = await resolveImportTagIds(supabase, {
          accountId,
          userId: user.id,
          tagNames: allTagNames,
          canCreateTags: canEditSettings,
        }));
      }

      const tagAssignments: ContactTagAssignment[] = [];

      // 3b) Resolve custom field names → ids. Custom fields are NOT auto-created.
      //     Skip the round-trip when the import carries no custom fields.
      let fieldIdByName = new Map<string, string>();
      let skippedCustomFieldNames: string[] = [];
      if (customFieldNames.length > 0) {
        ({ fieldIdByName, skippedNames: skippedCustomFieldNames } = await resolveImportCustomFieldIds(
          supabase,
          {
            accountId,
            fieldNames: customFieldNames,
          }
        ));
      }

      const customFieldAssignments: ContactCustomFieldAssignment[] = [];

      // 4) Batch insert the genuinely-new rows in chunks of 50. The DB
      //    unique index is the backstop: a 23505 (race, or a format
      //    that normalizes equal) counts as skipped, not failed.
      const chunkSize = 50;

      for (let i = 0; i < toInsert.length; i += chunkSize) {
        const chunk = toInsert.slice(i, i + chunkSize);
        const rows = chunk.map((row) => ({
          user_id: user.id,
          account_id: accountId,
          phone: row.phone,
          name: row.name || null,
          email: row.email || null,
          company: row.company || null,
        }));

        const { data, error } = await supabase
          .from('contacts')
          .insert(rows)
          .select('id');

        if (error) {
          // Retry individually so one bad/duplicate row doesn't sink
          // the whole chunk.
          for (let j = 0; j < rows.length; j++) {
            const row = rows[j];
            const source = chunk[j];
            const { data: singleData, error: singleErr } = await supabase
              .from('contacts')
              .insert(row)
              .select('id')
              .single();

            if (!singleErr && singleData) {
              imported++;
              if (source.tagNames.length > 0) {
                tagAssignments.push({
                  contactId: singleData.id,
                  tagNames: source.tagNames,
                });
              }
              for (const [fieldName, value] of Object.entries(source.customFieldValues)) {
                const fieldId = fieldIdByName.get(fieldName);
                if (fieldId) {
                  customFieldAssignments.push({
                    contactId: singleData.id,
                    fieldId,
                    value,
                  });
                }
              }
            } else if (isUniqueViolation(singleErr)) {
              skipped++;
            } else {
              failed++;
            }
          }
        } else {
          const inserted = data ?? [];
          imported += inserted.length;
          // inserted[j] ↔ chunk[j] only holds because a single INSERT
          // preserves RETURNING order. If this path is ever split into
          // parallel inserts, zip by phone or returned id instead.
          for (let j = 0; j < inserted.length; j++) {
            const source = chunk[j];
            if (!source) continue;
            if (source.tagNames.length > 0) {
              tagAssignments.push({
                contactId: inserted[j].id,
                tagNames: source.tagNames,
              });
            }
            for (const [fieldName, value] of Object.entries(source.customFieldValues)) {
              const fieldId = fieldIdByName.get(fieldName);
              if (fieldId) {
                customFieldAssignments.push({
                  contactId: inserted[j].id,
                  fieldId,
                  value,
                });
              }
            }
          }
        }
      }

      // 5) Wire tags onto the contacts we just created. Failure here must
      //    not mask a successful contact import.
      let tagsAssigned = 0;
      try {
        tagsAssigned = await assignImportedContactTags(
          supabase,
          tagAssignments,
          tagIdByKey
        );
      } catch {
        toast.warning('Contacts imported, but some tag assignments failed.');
      }

      // 5b) Wire custom field values onto the contacts we just created.
      let customFieldsAssigned = 0;
      try {
        customFieldsAssigned = await assignImportedContactCustomValues(
          supabase,
          customFieldAssignments
        );
      } catch {
        toast.warning('Contacts imported, but some custom field assignments failed.');
      }

      setResult({ imported, skipped, failed, tagsAssigned, customFieldsAssigned });
      if (imported > 0) {
        toast.success(
          `${imported} contact${imported !== 1 ? 's' : ''} imported`
        );
        onImported();
      }
      if (tagsAssigned > 0) {
        toast.success(
          `${tagsAssigned} tag assignment${tagsAssigned !== 1 ? 's' : ''} applied`
        );
      }
      if (customFieldsAssigned > 0) {
        toast.success(
          `${customFieldsAssigned} custom field value${customFieldsAssigned !== 1 ? 's' : ''} applied`
        );
      }
      if (skippedNames.length > 0) {
        const sample = skippedNames.slice(0, 3).join(', ');
        const more =
          skippedNames.length > 3 ? ` (+${skippedNames.length - 3} more)` : '';
        toast.info(
          `Unknown tags skipped (create them in Settings first): ${sample}${more}`
        );
      }
      if (skippedCustomFieldNames.length > 0) {
        const sample = skippedCustomFieldNames.slice(0, 3).join(', ');
        const more =
          skippedCustomFieldNames.length > 3 ? ` (+${skippedCustomFieldNames.length - 3} more)` : '';
        toast.info(
          `Unknown custom fields skipped (create them in Settings first): ${sample}${more}`
        );
      }
      if (skipped > 0) {
        toast.info(`${skipped} duplicate${skipped !== 1 ? 's' : ''} skipped`);
      }
      if (failed > 0) {
        toast.error(
          `${failed} contact${failed !== 1 ? 's' : ''} failed to import`
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Import failed';
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,720px)] flex-col gap-0 overflow-hidden border-border/80 bg-popover p-0 text-popover-foreground sm:max-w-2xl">
        <div className="shrink-0 space-y-4 border-b border-border/80 px-6 pt-6 pb-5">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-lg text-popover-foreground">
              Import Contacts
            </DialogTitle>
            <DialogDescription className="leading-relaxed text-muted-foreground">
              Upload a CSV with a required{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                phone
              </code>{' '}
              column. Optional:{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                name
              </code>
              ,{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                email
              </code>
              ,{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                company
              </code>
              ,{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                tags
              </code>{' '}
              (comma-separated; quote multi-tag cells), or any custom field names.
            </DialogDescription>
          </DialogHeader>

          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ')
                fileInputRef.current?.click();
            }}
            className={cn(
              'group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-5 transition-all',
              file
                ? 'border-primary/35 bg-primary/[0.04]'
                : 'hover:border-primary/40 border-border/80 bg-background/40 hover:bg-background/70'
            )}
          >
            {file ? (
              <>
                <div className="bg-primary/15 ring-primary/25 flex size-10 items-center justify-center rounded-lg ring-1">
                  <FileText className="text-primary size-5" />
                </div>
                <p
                  className="max-w-full truncate px-2 text-sm font-medium text-popover-foreground"
                  title={file.name}
                >
                  {truncateFilename(file.name)}
                </p>
                <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {parsedRows.length} row{parsedRows.length !== 1 ? 's' : ''}{' '}
                  ready
                </span>
              </>
            ) : (
              <>
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted/80 ring-1 ring-border/80 transition-colors group-hover:bg-muted">
                  <Upload className="size-5 text-muted-foreground group-hover:text-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  Click to choose a CSV file
                </p>
                <p className="text-[11px] text-muted-foreground">
                  .csv up to your browser limit
                </p>
              </>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {parsedRows.length > 0 && !result && (
            <CsvImportPreviewTable
              rows={parsedRows}
              previewLimit={PREVIEW_LIMIT}
              customFieldNames={customFieldNames}
              tagColorByKey={tagColorByKey}
              hasTagsColumn={hasTagsColumn}
              hasCompanyColumn={hasCompanyColumn}
            />
          )}

          {result && (
            <div className="rounded-xl border border-border bg-background/50 p-4">
              <p className="text-sm font-medium text-popover-foreground">Import complete</p>
              <div className="mt-3 flex flex-wrap gap-3">
                {result.imported > 0 && (
                  <div className="text-primary flex items-center gap-1.5 text-sm">
                    <CheckCircle className="size-4 shrink-0" />
                    {result.imported} imported
                  </div>
                )}
                {result.tagsAssigned > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-cyan-400">
                    <CheckCircle className="size-4 shrink-0" />
                    {result.tagsAssigned} tag
                    {result.tagsAssigned !== 1 ? 's' : ''} assigned
                  </div>
                )}
                {result.skipped > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-amber-400">
                    <AlertTriangle className="size-4 shrink-0" />
                    {result.skipped} skipped
                  </div>
                )}
                {result.failed > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-red-400">
                    <XCircle className="size-4 shrink-0" />
                    {result.failed} failed
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="mt-0 shrink-0 gap-2 border-t border-border/80 bg-background/50 px-6 py-4 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {result ? 'Close' : 'Cancel'}
          </Button>
          {!result && (
            <Button
              type="button"
              disabled={parsedRows.length === 0 || importing}
              onClick={handleImport}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {importing && <Loader2 className="size-4 animate-spin" />}
              Import {parsedRows.length > 0 ? parsedRows.length : ''} contact
              {parsedRows.length !== 1 ? 's' : ''}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
