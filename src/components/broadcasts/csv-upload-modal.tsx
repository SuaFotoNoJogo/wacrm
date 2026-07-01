'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Upload, FileText, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseContactCsv, type ParsedContactRow } from '@/lib/contacts/parse-contact-csv';
import { CsvImportPreviewTable, truncateFilename } from '@/components/contacts/csv-import-preview';

const PREVIEW_LIMIT = 5;

interface CsvUploadModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpload: (contacts: ParsedContactRow[]) => void;
}

export function CsvUploadModal({
  open,
  onOpenChange,
  onUpload,
}: CsvUploadModalProps) {
  const { accountId } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedContactRow[]>([]);
  const [customFieldNames, setCustomFieldNames] = useState<string[]>([]);
  const [hasTagsColumn, setHasTagsColumn] = useState(false);
  const [hasCompanyColumn, setHasCompanyColumn] = useState(false);
  const [tagColorByKey, setTagColorByKey] = useState<Map<string, string>>(new Map());
  const [parsing, setParsing] = useState(false);

  function reset() {
    setFile(null);
    setParsedRows([]);
    setCustomFieldNames([]);
    setHasTagsColumn(false);
    setHasCompanyColumn(false);
    setTagColorByKey(new Map());
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;

    setParsing(true);
    try {
      const text = await selected.text();
      const {
        rows,
        hasTagsColumn: csvHasTags,
        hasCompanyColumn: csvHasCompany,
        customFieldNames: detectedFields,
      } = parseContactCsv(text);

      if (rows.length === 0) {
        toast.error(
          'No valid rows found. Ensure CSV has a "phone" column header.'
        );
        setFile(null);
        setParsedRows([]);
        setCustomFieldNames([]);
        setHasTagsColumn(false);
        setHasCompanyColumn(false);
        setTagColorByKey(new Map());
        return;
      }

      setFile(selected);
      setParsedRows(rows);
      setCustomFieldNames(detectedFields);
      setHasTagsColumn(csvHasTags);
      setHasCompanyColumn(csvHasCompany);
      toast.success(`${rows.length} contact${rows.length !== 1 ? 's' : ''} ready`);

      // Preview known tag colors (and which tag names would be created)
      // the same way the Contacts import modal does.
      if (csvHasTags && accountId) {
        const supabase = createClient();
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
    } catch (err) {
      toast.error('Failed to parse CSV file');
      setFile(null);
      setParsedRows([]);
      setCustomFieldNames([]);
      setHasTagsColumn(false);
      setHasCompanyColumn(false);
      setTagColorByKey(new Map());
    } finally {
      setParsing(false);
    }
  }

  function handleUpload() {
    if (parsedRows.length === 0) return;
    onUpload(parsedRows);
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,720px)] flex-col gap-0 overflow-hidden border-border/80 bg-popover p-0 text-popover-foreground sm:max-w-2xl">
        <div className="shrink-0 space-y-4 border-b border-border/80 px-6 pt-6 pb-5">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-lg text-popover-foreground">
              Upload CSV
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
                  {parsedRows.length} row{parsedRows.length !== 1 ? 's' : ''} ready
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
            disabled={parsing}
            className="hidden"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {parsedRows.length > 0 && (
            <CsvImportPreviewTable
              rows={parsedRows}
              previewLimit={PREVIEW_LIMIT}
              customFieldNames={customFieldNames}
              tagColorByKey={tagColorByKey}
              hasTagsColumn={hasTagsColumn}
              hasCompanyColumn={hasCompanyColumn}
            />
          )}
        </div>

        <DialogFooter className="mt-0 shrink-0 gap-2 border-t border-border/80 bg-background/50 px-6 py-4 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={parsedRows.length === 0 || parsing}
            onClick={handleUpload}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {parsing && <Loader2 className="size-4 animate-spin" />}
            Upload {parsedRows.length > 0 ? parsedRows.length : ''} contact
            {parsedRows.length !== 1 ? 's' : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
