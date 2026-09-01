import { useEffect, useState } from 'react';
import { ArrowSquareOutIcon, CheckIcon, CopyIcon, EnvelopeSimpleIcon, PackageIcon, WhatsappLogoIcon } from '@phosphor-icons/react';

import { SectionHeading } from '@/components/shared/section-heading';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { formatRelativeAge } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS } from '@vyuha/shared';

import { PhotoPicker } from '@/components/shared/photo-picker';
import { TextField } from './dispatch-dialog';
import type { PreparedPhoto } from '@/components/shared/prepare-photo';
import { ResponsiveDialog, ResponsiveDialogActions } from '@/components/shared/responsive-dialog';
import type { Dispatch, DispatchNotification } from './types';
import { useAttachmentUrl, useDeliverDispatch, useMarkNotification } from './use-dispatches';

/**
 * What sits under a dispatch's delivery note (REQ-AA-16, AA-31): the
 * photographs behind a signed link minted when the page opens, and the
 * customer's notification — composed by the system, sent by a person, and
 * marked so (REQ-AA-24…AA-27, the `manual` channel of REQ-AA-26).
 */

const NOTIFICATION_STATUS_LABELS: Record<DispatchNotification['status'], string> = { pending: 'Pending', sent: 'Sent', failed: 'Failed' };

export function DispatchPhotographs({ dispatch }: { dispatch: Dispatch }) {
  if (dispatch.attachments.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <SectionHeading title="Photographs" note="Signed links, minted when this opened; they expire." />
      <div className="flex flex-wrap gap-2">
        {dispatch.attachments.map((attachment, index) => (
          <AttachmentThumb key={attachment.fileId} dispatchId={dispatch.id} fileId={attachment.fileId} label={attachment.kind === 'box' ? 'Box photo' : 'LR photo'} index={index} />
        ))}
      </div>
    </div>
  );
}

export function DispatchNotifications({ dispatch }: { dispatch: Dispatch }) {
  // P8-5: marking a notification sent and recording a delivery are the
  // floor's acts, and their endpoints ask for sales.fulfil.
  const canAct = usePermission(PERMISSIONS.SALES_FULFIL);
  const mark = useMarkNotification();
  return (
    <div className="flex flex-col gap-2">
      <SectionHeading title="Customer notification" note="Composed here; sent by hand until the channels are wired. Mark it once it has gone." />
      {dispatch.notifications.length === 0 ? <p className="text-muted-foreground text-xs">No notification was composed.</p> : null}
      <ul className="flex flex-col divide-y border">
        {dispatch.notifications.map((notification) => (
          <li key={notification.id} className="flex flex-col gap-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm">
                {notification.channel === 'email' ? <EnvelopeSimpleIcon /> : <WhatsappLogoIcon />}
                <span className="font-medium">{notification.channel === 'email' ? 'Email' : 'WhatsApp'}</span>
                <span className="text-muted-foreground text-xs">{notification.recipient ?? 'no address on the party or the order'}</span>
              </span>
              <span className="flex items-center gap-2">
                <Badge variant={notification.status === 'sent' ? 'default' : notification.status === 'failed' ? 'destructive' : 'outline'}>
                  {NOTIFICATION_STATUS_LABELS[notification.status]}
                  {notification.sentAt ? ` · ${formatRelativeAge(notification.sentAt)}` : ''}
                </Badge>
              </span>
            </div>
            {notification.error ? <p className="text-destructive text-xs">{notification.error}</p> : null}
            <Textarea readOnly rows={6} aria-label={`${notification.channel} message`} className="font-mono" value={notification.composedText} />
            <div className="flex flex-wrap items-center justify-end gap-2">
              <CopyButton text={notification.composedText} label={`${notification.channel} message`} />
              {/* D-47: click-to-send. Opens the conversation with the message typed;
                  the person taps send there, and coming back marks it sent here. */}
              {notification.channel === 'whatsapp' && notification.status === 'pending' && notification.recipient && canAct ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={mark.isPending}
                  onClick={() => {
                    const digits = (notification.recipient ?? '').replace(/\D/gu, '');
                    const number = digits.length === 10 ? `91${digits}` : digits;
                    window.open(`https://wa.me/${number}?text=${encodeURIComponent(notification.composedText)}`, '_blank', 'noopener');
                    mark.mutate(
                      { dispatchId: dispatch.id, notificationId: notification.id, status: 'sent' },
                      {
                        onSuccess: () => {
                          toast.add({ type: 'success', title: 'WhatsApp opened', description: `Marked sent against ${dispatch.number}; undo by marking it failed if the message did not go.` });
                        },
                      },
                    );
                  }}
                >
                  <WhatsappLogoIcon data-icon="inline-start" />
                  Send on WhatsApp
                </Button>
              ) : null}
              {notification.status === 'pending' && canAct ? (
                <Button
                  size="sm"
                  disabled={mark.isPending}
                  onClick={() => {
                    mark.mutate(
                      { dispatchId: dispatch.id, notificationId: notification.id, status: 'sent' },
                      {
                        onSuccess: () => {
                          toast.add({ type: 'success', title: `${notification.channel === 'email' ? 'Email' : 'WhatsApp'} marked sent`, description: `Recorded against ${dispatch.number}.` });
                        },
                      },
                    );
                  }}
                >
                  {mark.isPending && mark.variables?.notificationId === notification.id ? <Spinner data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}
                  Mark sent
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      </div>
  );
}

/** A photograph behind its signed URL, asked for when the sheet opens; a link, because the full image is what the customer is sent. */
function AttachmentThumb({ dispatchId, fileId, label, index }: { dispatchId: string; fileId: string; label: string; index: number }) {
  const url = useAttachmentUrl(dispatchId, fileId);
  const name = `${label} ${String(index + 1)}`;
  if (url.isPending) return <Skeleton className="size-24" aria-label={`Loading ${name}`} />;
  if (url.isError) {
    return (
      <span className="text-muted-foreground flex size-24 items-center justify-center border p-2 text-center text-xs" title={url.error.message}>
        {name} unavailable
      </span>
    );
  }
  return (
    <a href={url.data.url} target="_blank" rel="noreferrer" className="group relative block size-24 border" aria-label={`Open ${name} in a new tab`}>
      <img src={url.data.url} alt={name} className="size-full object-cover" />
      <span className="bg-background/80 absolute inset-x-0 bottom-0 flex items-center justify-between px-1.5 py-0.5 text-[0.6875rem]">
        {label}
        <ArrowSquareOutIcon />
      </span>
    </a>
  );
}

/**
 * The clipboard is the convenience; the text on screen is the guarantee. A
 * multi-line message does not fit CopyField's single-line input, so this is
 * its button and its announcement beside a read-only Textarea instead.
 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [outcome, setOutcome] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (outcome !== 'copied') return undefined;
    const timer = window.setTimeout(() => {
      setOutcome('idle');
    }, 2500);
    return () => {
      window.clearTimeout(timer);
    };
  }, [outcome]);

  async function copy() {
    try {
      // `navigator.clipboard` is absent over plain http and reading it throws;
      // the catch covers that as well as a refused permission (see CopyField).
      await navigator.clipboard.writeText(text);
      setOutcome('copied');
    } catch {
      setOutcome('failed');
    }
  }

  return (
    <>
      <span className="text-muted-foreground text-xs" role="status" aria-live="polite">
        {outcome === 'copied' ? 'Copied.' : outcome === 'failed' ? 'This browser would not write to the clipboard; select the text and copy it by hand.' : ''}
      </span>
      <Button
        variant="outline"
        size="sm"
        aria-label={outcome === 'copied' ? `${label} copied` : `Copy ${label}`}
        onClick={() => {
          void copy();
        }}
      >
        {outcome === 'copied' ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
        Copy
      </Button>
    </>
  );
}

/**
 * D-47: the door step. A shipped dispatch offers "Mark delivered"; the form
 * asks only for what the system cannot know — who took the goods, a note,
 * the photograph at the door — and the delivered notice follows by itself.
 * A delivered dispatch states the fact and stops offering the verb.
 */
export function DeliverSection({ dispatch }: { dispatch: Dispatch }) {
  // P8-5: marking a notification sent and recording a delivery are the
  // floor's acts, and their endpoints ask for sales.fulfil.
  const canAct = usePermission(PERMISSIONS.SALES_FULFIL);
  const deliver = useDeliverDispatch();
  const [open, setOpen] = useState(false);
  const [receivedBy, setReceivedBy] = useState('');
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<PreparedPhoto[]>([]);
  const [tried, setTried] = useState(false);
  const missingName = tried && receivedBy.trim() === '' ? 'Who received it?' : null;
  const missingPhoto = tried && photos.length === 0 ? 'A photograph at the door is required.' : null;

  function submit() {
    setTried(true);
    if (receivedBy.trim() === '' || photos.length === 0) return;
    deliver.mutate(
      { dispatchId: dispatch.id, receivedBy: receivedBy.trim(), note: note.trim() === '' ? null : note.trim(), photos: photos.map((p) => p.file) },
      {
        onSuccess: (delivered) => {
          setOpen(false);
          const mail = delivered.notifications.find((n) => n.channel === 'email' && n.event === 'delivered');
          toast.add({
            type: 'success',
            title: `${dispatch.number} delivered`,
            description: mail?.status === 'sent' ? `Received by ${receivedBy.trim()}. The customer has been mailed.` : mail?.recipient ? `Received by ${receivedBy.trim()}. The mail ${mail.status === 'failed' ? 'failed — see the notice below' : 'is pending'}.` : `Received by ${receivedBy.trim()}. No email on file to tell them.`,
          });
        },
        onError: (error: Error) => {
          toast.add({ type: 'error', title: 'Not marked delivered', description: error.message });
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <SectionHeading
        title={dispatch.status === 'delivered' ? 'Delivered' : 'On its way'}
        note={
          dispatch.status === 'delivered'
            ? `Received by ${dispatch.receivedBy ?? 'the customer'}${dispatch.deliveredAt ? ` ${formatRelativeAge(dispatch.deliveredAt)}` : ''}${dispatch.deliveredByName ? `, marked by ${dispatch.deliveredByName}` : ''}${dispatch.deliveryNote ? `. ${dispatch.deliveryNote}` : '.'}`
            : 'Mark it delivered at the door: who received it, and a photograph. The customer is told by mail.'
        }
        action={
          dispatch.status === 'shipped' && canAct ? (
            <Button
              size="sm"
              onClick={() => {
                setOpen(true);
              }}
            >
              <PackageIcon data-icon="inline-start" />
              Mark delivered
            </Button>
          ) : undefined
        }
      />
      <ResponsiveDialog open={open} onOpenChange={setOpen} title={`Deliver ${dispatch.number}`} description={`${dispatch.customerName} · ${dispatch.orderNumber}`}>
        <div className="flex flex-col gap-4">
          <TextField id="deliver-received-by" label="Received by" value={receivedBy} onChange={setReceivedBy} error={missingName} disabled={deliver.isPending} placeholder="Name at the door" />
          <PhotoPicker
            label="Photograph at the door"
            hint="The goods as handed over. One is required; up to three."
            photos={photos}
            max={3}
            error={missingPhoto}
            disabled={deliver.isPending}
            onAdd={(photo) => {
              setPhotos((current) => [...current, photo]);
            }}
            onRemove={(index) => {
              setPhotos((current) => current.filter((_, i) => i !== index));
            }}
          />
          <Textarea aria-label="Note" placeholder="Anything to note — left at the counter, one carton opened to check" rows={2} value={note} onChange={(event) => { setNote(event.target.value); }} />
          <ResponsiveDialogActions>
            <Button variant="outline" onClick={() => { setOpen(false); }} disabled={deliver.isPending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={deliver.isPending}>
              {deliver.isPending ? <Spinner data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}
              Delivered
            </Button>
          </ResponsiveDialogActions>
        </div>
      </ResponsiveDialog>
    </div>
  );
}
