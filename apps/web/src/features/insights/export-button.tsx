import { useState } from 'react';
import { DownloadSimpleIcon } from '@phosphor-icons/react';
import { PERMISSIONS } from '@vyuha/shared';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { downloadDocumentFile } from '@/features/documents/download';
import { usePermission } from '@/lib/session/permissions';

/**
 * Export from the view (CFO brief R6, O6): the same filters and period the
 * screen shows, as a workbook with the standard header block. Hidden
 * without cfo.export; every export is logged server-side.
 */
export function ExportButton({
  report,
  range,
  scope = {},
  label = 'Export',
}: {
  report: string;
  range: { from: string; to: string };
  scope?: Record<string, string | undefined>;
  label?: string;
}) {
  const canExport = usePermission(PERMISSIONS.CFO_EXPORT);
  const [busy, setBusy] = useState(false);
  if (!canExport) return null;

  async function run() {
    setBusy(true);
    try {
      const params = new URLSearchParams({ report, from: range.from, to: range.to });
      for (const [k, v] of Object.entries(scope)) if (v !== undefined && v !== '') params.set(k, v);
      await downloadDocumentFile(`/cfo/export?${params.toString()}`, `${report}-${range.from}-to-${range.to}.xlsx`);
      toast.add({ type: 'success', title: 'Export ready', description: 'Exactly what the screen shows, with its header block.' });
    } catch (error) {
      toast.add({ type: 'error', title: 'Could not export', description: error instanceof Error ? error.message : 'Try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void run()}>
      <DownloadSimpleIcon data-icon="inline-start" />
      {busy ? 'Preparing' : label}
    </Button>
  );
}
