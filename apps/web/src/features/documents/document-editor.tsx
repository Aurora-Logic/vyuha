import { type CSSProperties, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeftIcon, ArrowsInIcon, DotsThreeVerticalIcon, EyeIcon, FileXlsIcon, ListIcon, PaintBrushIcon, PencilSimpleIcon, PrinterIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { toast } from '@/components/ui/toast';
import { useIsMobile } from '@/hooks/use-mobile';
import { useBranding } from '@/lib/branding/use-branding';
import { usePermission } from '@/lib/session/permissions';
import { cn } from '@/lib/utils';
import { PERMISSIONS, type DocumentSettings, type PrintedDocumentType } from '@vyuha/shared';

import { DesignRail } from './design-rail';
import { HandlingMarksControl } from './handling-marks-control';
import { DocumentForm } from './document-form';
import { downloadDocumentFile } from './download';
import { PackingSlipPaper } from './packing-slip-paper';
import { SLIP_PAPER_TYPES } from './paper-support';
import { A4_WIDTH_PX, ZOOMS, fitZoomIndex } from './paper-fit';
import { DocumentPaper, type PaperEditing, type PaperModel } from './paper';
import { useFooterLogoUrls, useSaveDocumentSettings } from './use-document-settings';

/**
 * The page every printed document is edited on: a bar (where you are, what
 * this is, what you can do), the stage with the paper zoomed to fit the
 * screen, Preview, PDF, Excel, and the design rail on request. The
 * document types differ in what they hold and what they can do — the
 * estimate, order, invoice and purchase order pages hand this shell their
 * paper model, their editing hooks and their own action buttons; the
 * shell owns everything the four have in common, so a person who has
 * raised one document knows how to raise the others.
 */

// The zoom steps and the fit are a pure, tested module (paper-fit.ts).

export interface DocumentEditorProps {
  docType: PrintedDocumentType;
  /** Where the back arrow goes and what it says. */
  backTo: string;
  backLabel: string;
  /** "New estimate", "Sales order SO-0007". */
  title: string;
  /** Badges after the title: status, sync state, fulfilment. */
  badges?: ReactNode;
  dirty: boolean;
  /** Buttons after Preview / PDF / Excel / Design; the page's own verbs, Save last. */
  actions?: ReactNode;
  /** An error the page wants shown above the paper. */
  failure?: { title: string; description: string } | null;
  /** A one-line hint above the paper (what is missing before Save). */
  hint?: string | null;
  model: PaperModel;
  /** Present while the document is editable and Preview is off. */
  editing?: PaperEditing;
  /** Turned off while the document is not editable, so Preview does not pretend to toggle anything. */
  canPreview?: boolean;
  /** Paths for the print route and the Excel copy; null while unsaved. */
  printPath: string | null;
  excel: { path: string; filename: string } | null;
  /** Anything below the paper: quantities, invoices, dispatches, receipts. */
  extras?: ReactNode;
  /** The design draft is the page's, so the paper and the rail see one copy. */
  settings: { draft: DocumentSettings; setDraft: (next: DocumentSettings) => void; saved: DocumentSettings };
}

export function DocumentEditor(props: DocumentEditorProps) {
  const { docType, backTo, backLabel, title, badges, dirty, actions, failure, hint, model, editing, canPreview = true, printPath, excel, extras, settings } = props;
  const isMobile = useIsMobile();
  const branding = useBranding();
  const [preview, setPreview] = useState(false);
  const [designOpen, setDesignOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // Open at 100% on a desk, where a document is read and typed at full size
  // (owner, 22 Aug); a phone still starts fit-to-width, because 210mm at 100%
  // would scroll sideways off a 360px screen — the reason fit exists there.
  const [fit, setFit] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  const [zoomIndex, setZoomIndex] = useState(ZOOMS.length - 1);
  const [sheetHeight, setSheetHeight] = useState<number | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const saveSettings = useSaveDocumentSettings();
  const canManageSettings = usePermission(PERMISSIONS.SETTINGS_MANAGE);
  const footerLogoUrls = useFooterLogoUrls(settings.draft.profile.footerLogoFileIds);
  const design = settings.draft.designs[docType];
  const settingsDirty = JSON.stringify(settings.draft) !== JSON.stringify(settings.saved);
  const showEditing = preview ? undefined : editing;
  const hasExtras = extras !== undefined;
  // A phone draws the document as a form (DocumentForm) and shows the paper
  // only on request, so the toggle exists there even for a document nobody
  // can edit; on a desk the paper is the editor and the toggle is Preview.
  const formOnPhone = isMobile && !preview;
  const previewToggle = isMobile || (canPreview && editing !== undefined);

  // Fit: the largest zoom step at which the whole sheet stands in the stage — by height on a desk; by width on a
  // phone, where the stage scrolls and a squashed A4 grid would be unreadable.
  useLayoutEffect(() => {
    if (!fit) return undefined;
    const stage = stageRef.current;
    const paper = paperRef.current;
    if (stage === null || paper === null) return undefined;
    const measure = () => {
      const availableHeight = stage.clientHeight - 32;
      const availableWidth = stage.clientWidth - (isMobile ? 24 : 32);
      // offsetHeight is the layout height, which the transform leaves alone.
      const naturalHeight = paper.offsetHeight;
      setSheetHeight((prev) => (prev === naturalHeight ? prev : naturalHeight));
      // The sheet is 210mm wide unless the stage has squashed it, so the width is known rather than measured.
      const naturalWidth = A4_WIDTH_PX;
      if (naturalHeight === 0 || availableWidth <= 0) return;
      // Fit inside both the stage's height and its width; the tighter side
      // binds. A short slip on a narrow screen is bound by width, so it no
      // longer takes a height-only scale that spills off both edges.
      const index = fitZoomIndex({ naturalHeight, naturalWidth, availableHeight, availableWidth });
      setZoomIndex((prev) => (prev === index ? prev : index));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    observer.observe(paper);
    return () => {
      observer.disconnect();
    };
  }, [fit, isMobile, preview, zoomIndex, design.templateId, design.fontScale, model.lines.length, hasExtras]);

  async function exportXlsx() {
    if (excel === null) return;
    try {
      await downloadDocumentFile(excel.path, excel.filename);
    } catch (error) {
      toast.add({ type: 'error', title: 'Excel export failed', description: error instanceof Error ? error.message : 'Try again.' });
    }
  }
  const zoom = ZOOMS[fit ? zoomIndex : ZOOMS.length - 1];

  return (
    <>
      <div className="-mx-4 -mt-4 -mb-24 flex h-[calc(100dvh-3.5rem)] flex-col md:-mx-6 md:-mt-6 md:-mb-6">
        <div
          // The guide's anchor for every document screen. This toolbar is the
          // one thing all seven of them share — four editors and three paper
          // views all render DocumentEditor — and none of them renders the
          // PageHeader the rest of the product is anchored on.
          data-guide="screen.document"
          // One row on a phone: the back arrow alone, the title truncating,
          // Preview and the overflow at the thumb's edge. Wrapping put the
          // actions on a second row with a blank band beside them.
          className="bg-background/85 supports-[backdrop-filter]:bg-background/70 flex shrink-0 items-center gap-2 border-b px-3 py-2 backdrop-blur md:flex-wrap md:px-6"
        >
          <Button variant="ghost" size="sm" nativeButton={false} render={<Link to={backTo} />}>
            <ArrowLeftIcon data-icon="inline-start" />
            <span className="max-md:sr-only">{backLabel}</span>
          </Button>
          {/* The badges may wrap under the title on a phone; this block is
              flex-1, so wrapping inside it never moves the actions beside it.
              Measured: an 'Awaiting invoice' pill pushed the page to 391px at 360. */}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-semibold">{title}</span>
            {badges}
            {dirty ? <Badge variant="secondary">Unsaved</Badge> : null}
          </div>
          <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
            <Button variant={fit ? 'default' : 'outline'} size="sm" className="hidden md:inline-flex" aria-pressed={fit} aria-label="Fit the page to the screen" onClick={() => { setFit((v) => !v); }}>
              <ArrowsInIcon data-icon="inline-start" />
              {fit ? `Fit ${String(Math.round(zoom.value * 100))}%` : '100%'}
            </Button>
            {previewToggle ? (
              <Button variant={preview ? 'default' : 'outline'} size="sm" aria-pressed={preview} onClick={() => { setPreview((v) => !v); }}>
                {preview ? (editing !== undefined ? <PencilSimpleIcon data-icon="inline-start" /> : <ListIcon data-icon="inline-start" />) : <EyeIcon data-icon="inline-start" />}
                {preview ? (editing !== undefined ? 'Edit' : 'Details') : 'Preview'}
              </Button>
            ) : null}
            <div className="hidden items-center gap-2 md:flex">
              {/* An anchor, so the print route opens in its own tab; nativeButton off because the rendered element is not a <button>. */}
              {printPath === null ? (
                <Button variant="outline" size="sm" disabled>
                  <PrinterIcon data-icon="inline-start" />
                  PDF
                </Button>
              ) : (
                <Button variant="outline" size="sm" nativeButton={false} render={<a href={printPath} target="_blank" rel="noreferrer" />}>
                  <PrinterIcon data-icon="inline-start" />
                  PDF
                </Button>
              )}
              <Button variant="outline" size="sm" disabled={excel === null} onClick={() => { void exportXlsx(); }}>
                <FileXlsIcon data-icon="inline-start" />
                Excel
              </Button>
              <Button variant="outline" size="sm" aria-label="Open the design rail" onClick={() => { setDesignOpen(true); }}>
                <PaintBrushIcon data-icon="inline-start" />
                Design
              </Button>
              {isMobile ? null : actions}
            </div>
            {/* On a phone the bar stays one row: Preview beside an overflow that
                opens as a bottom sheet (thumb-reach: a menu of rows arrives from
                an edge); the page's own verbs move to a footer the thumb reaches. */}
            <Button variant="outline" size="icon-sm" className="md:hidden" aria-label="More document actions" onClick={() => { setMobileMenuOpen(true); }}>
              <DotsThreeVerticalIcon />
            </Button>
          </div>
        </div>

        <div ref={stageRef} className={cn('min-h-0 flex-1 overflow-auto px-3 py-4 md:px-6', formOnPhone ? 'bg-background' : 'bg-muted/40')}>
          {failure ? (
            <Alert variant="destructive" className="mx-auto mb-4 max-w-[210mm]">
              <WarningCircleIcon />
              <AlertTitle>{failure.title}</AlertTitle>
              <AlertDescription>{failure.description}</AlertDescription>
            </Alert>
          ) : null}
          {hint ? <p className="text-muted-foreground mx-auto mb-3 max-w-[210mm] text-xs">{hint}</p> : null}
          {/* D-47 (owner): the marks are set here, on the slip, not inside Design. */}
          {SLIP_PAPER_TYPES.includes(docType) ? (
            <div className="mx-auto mb-4 max-w-[210mm]">
              <HandlingMarksControl
                docType={docType}
                settings={settings.draft}
                onDraft={settings.setDraft}
                canManage={canManageSettings}
                onSave={(next) => {
                  saveSettings.mutate(next);
                }}
              />
            </div>
          ) : null}
          {formOnPhone ? (
            <DocumentForm model={model} design={design} editing={editing} />
          ) : (
            // overflow-x-clip: the sheet keeps its 210mm layout width under the
            // transform, which would otherwise give the stage a sideways scroll.
            <div
              className={cn('overflow-x-clip', zoom.value < 1 && sheetHeight !== null && 'h-[calc(var(--sheet-height)*var(--sheet-scale))]')}
              // Measured values reach CSS as custom properties, the way the toggle group passes its gap.
              style={{ '--sheet-height': `${String(sheetHeight ?? 0)}px`, '--sheet-scale': String(zoom.value) } as CSSProperties}
            >
              <div ref={paperRef} className={cn('relative left-1/2 w-[210mm] origin-top -translate-x-1/2', zoom.className)}>
                {SLIP_PAPER_TYPES.includes(docType) ? (
                  // D-47: the goods papers have their own paper; the slip previews box 1 of N.
                  <PackingSlipPaper design={design} profile={settings.draft.profile} orgName={branding.data?.name ?? ''} logoUrl={branding.data?.logoUrl ?? null} model={model} box={1} />
                ) : (
                  <DocumentPaper design={design} profile={settings.draft.profile} logoUrl={branding.data?.logoUrl ?? null} footerLogoUrls={footerLogoUrls} orgName={branding.data?.name ?? ''} model={model} editing={showEditing} />
                )}
              </div>
            </div>
          )}
          {extras ? <div className="mx-auto mt-6 max-w-[210mm]">{extras}</div> : null}
        </div>

        {isMobile && actions !== undefined && actions !== null ? (
          <div className="bg-background/95 supports-[backdrop-filter]:bg-background/80 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur md:hidden">
            {actions}
          </div>
        ) : null}
      </div>

      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetContent side="bottom" className="gap-0">
          <SheetHeader className="border-b">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>Export and design.</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {printPath === null ? (
              <Button variant="outline" className="justify-start" disabled>
                <PrinterIcon data-icon="inline-start" />
                PDF
              </Button>
            ) : (
              <Button variant="outline" className="justify-start" nativeButton={false} render={<a href={printPath} target="_blank" rel="noreferrer" />} onClick={() => { setMobileMenuOpen(false); }}>
                <PrinterIcon data-icon="inline-start" />
                PDF
              </Button>
            )}
            <Button variant="outline" className="justify-start" disabled={excel === null} onClick={() => { void exportXlsx(); setMobileMenuOpen(false); }}>
              <FileXlsIcon data-icon="inline-start" />
              Excel
            </Button>
            <Button variant="outline" className="justify-start" onClick={() => { setMobileMenuOpen(false); setDesignOpen(true); }}>
              <PaintBrushIcon data-icon="inline-start" />
              Design
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={designOpen} onOpenChange={setDesignOpen}>
        <SheetContent side={isMobile ? 'bottom' : 'right'} className="gap-0 p-0 sm:max-w-md max-md:max-h-[92vh]">
          <SheetHeader className="border-b">
            <SheetTitle>Design</SheetTitle>
            <SheetDescription>Template, accent and what the page shows — live on the paper. Business details are saved once, for every document.</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-hidden">
            <DesignRail
              docType={docType}
              settings={settings.draft}
              onChange={settings.setDraft}
              canSave={canManageSettings}
              dirty={settingsDirty}
              saving={saveSettings.isPending}
              saveError={saveSettings.error}
              onSave={() => {
                saveSettings.mutate(settings.draft, {
                  onSuccess: () => {
                    toast.add({ type: 'success', title: 'Design saved', description: 'Every document of this kind prints this way now.' });
                  },
                });
              }}
              onDiscard={() => {
                settings.setDraft(settings.saved);
              }}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

