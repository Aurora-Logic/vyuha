import { StatusBadge } from '@/components/shared/status-badge';
import { FULFILMENT_STATE_LABELS, type FulfilmentState } from '@vyuha/shared';

/**
 * REQ-AA-02/AA-03: the derived word, worn beside the status. It summarises; the
 * numbers beside it (REQ-AA-29) are what count. Coloured by the one status map
 * so it reads the same as every other state in the app.
 */
export function FulfilmentBadge({ state }: { state: FulfilmentState }) {
  return <StatusBadge state={state} label={FULFILMENT_STATE_LABELS[state]} />;
}
