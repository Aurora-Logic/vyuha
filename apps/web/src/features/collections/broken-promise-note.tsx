import { HandshakeIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';

import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { formatDate, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS } from '@vyuha/shared';

import { usePromises } from './use-collections';

/**
 * REQ-AJ-10 / D-54: a customer who promises and does not pay is exactly
 * the signal a credit limit exists to catch -- so it is said, beside the
 * order, in the same place the limit is. It never blocks: blocking on a
 * broken promise as well as on the limit would give one customer two ways
 * to be stopped, and the override key would get handed out to relieve it.
 */
export function BrokenPromiseNote({ partyId }: { partyId: string | null }) {
  const viewSelf = usePermission(PERMISSIONS.COLLECTIONS_VIEW_SELF);
  const viewAll = usePermission(PERMISSIONS.COLLECTIONS_VIEW_ALL);
  const canSee = viewSelf || viewAll;
  const promises = usePromises({ page: 1, pageSize: 50, ...(partyId === null ? {} : { partyId }) }, { enabled: canSee && partyId !== null });
  if (!canSee || partyId === null || promises.data === undefined) return null;
  const broken = promises.data.data.filter((promise) => promise.state === 'broken' || promise.state === 'partially_kept');
  if (broken.length === 0) return null;
  const short = broken.reduce((sum, promise) => sum + (Number(promise.amount) - Number(promise.receivedAmount)), 0);
  const worst = [...broken].sort((a, b) => a.promisedDate.localeCompare(b.promisedDate))[0];

  return (
    <Alert>
      <HandshakeIcon />
      <AlertTitle>
        {broken.length === 1 ? 'A promise was not kept' : `${String(broken.length)} promises were not kept`}
      </AlertTitle>
      <AlertDescription>
        <p className="tabular-nums">
          {formatMoney(short)} still to arrive{worst === undefined ? '' : `, the oldest promised for ${formatDate(worst.promisedDate)}`}. This is a flag, not a block — the order goes through.
        </p>
      </AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" nativeButton={false} render={<Link to={`/collections?tab=promises`} />}>
          See the promises
        </Button>
      </AlertAction>
    </Alert>
  );
}
