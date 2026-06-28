'use client';

import { useRef, useState } from 'react';
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
import { Upload, FileText, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CsvContact {
  phone: string;
  name?: string;
}

interface CsvUploadModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpload: (contacts: CsvContact[]) => void;
}

function parseBroadcastCsv(text: string): CsvContact[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = lines[0]
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/["']/g, ''));

  const phoneIdx = headers.indexOf('phone');
  if (phoneIdx === -1) return [];

  const nameIdx = headers.indexOf('name');
  const contacts: CsvContact[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = line.split(',').map((v) => v.trim().replace(/["']/g, ''));
    const phone = values[phoneIdx]?.trim();
    if (!phone) continue;

    contacts.push({
      phone,
      name: nameIdx >= 0 ? values[nameIdx]?.trim() || undefined : undefined,
    });
  }

  return contacts;
}

export function CsvUploadModal({
  open,
  onOpenChange,
  onUpload,
}: CsvUploadModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [parsedContacts, setParsedContacts] = useState<CsvContact[]>([]);
  const [parsing, setParsing] = useState(false);

  function reset() {
    setFile(null);
    setParsedContacts([]);
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
      const contacts = parseBroadcastCsv(text);

      if (contacts.length === 0) {
        toast.error(
          'No valid rows found. Ensure CSV has a "phone" column header.'
        );
        setFile(null);
        setParsedContacts([]);
        return;
      }

      setFile(selected);
      setParsedContacts(contacts);
      toast.success(`${contacts.length} contact${contacts.length !== 1 ? 's' : ''} ready`);
    } catch (err) {
      toast.error('Failed to parse CSV file');
      setFile(null);
      setParsedContacts([]);
    } finally {
      setParsing(false);
    }
  }

  function handleUpload() {
    if (parsedContacts.length === 0) return;
    onUpload(parsedContacts);
    handleOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,600px)] flex-col gap-0 overflow-hidden border-border/80 bg-popover p-0 text-popover-foreground sm:max-w-md">
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
              .
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
                  {file.name}
                </p>
                <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {parsedContacts.length} contact
                  {parsedContacts.length !== 1 ? 's' : ''} ready
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
          {parsedContacts.length > 0 && (
            <div className="space-y-3">
              <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                Preview · first 5
              </p>

              <div className="overflow-hidden rounded-xl border border-border ring-1 ring-border/50">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[24rem] text-xs">
                    <thead>
                      <tr className="border-b border-border bg-background/60">
                        <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                          Phone
                        </th>
                        <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                          Name
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/70">
                      {parsedContacts.slice(0, 5).map((contact, i) => (
                        <tr
                          key={i}
                          className="bg-popover/40 transition-colors hover:bg-muted/30"
                        >
                          <td className="px-3 py-2 whitespace-nowrap text-muted-foreground font-mono text-[11px]">
                            {contact.phone}
                          </td>
                          <td className="px-3 py-2 text-popover-foreground">
                            {contact.name || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {parsedContacts.length > 5 && (
                <p className="text-center text-[11px] text-muted-foreground">
                  + {parsedContacts.length - 5} more contact
                  {parsedContacts.length - 5 !== 1 ? 's' : ''}
                </p>
              )}
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
            Cancel
          </Button>
          <Button
            type="button"
            disabled={parsedContacts.length === 0 || parsing}
            onClick={handleUpload}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {parsing && <Loader2 className="size-4 animate-spin" />}
            Upload {parsedContacts.length > 0 ? parsedContacts.length : ''} contact
            {parsedContacts.length !== 1 ? 's' : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
