import { UserFocusIcon } from '@phosphor-icons/react';

import { SectionHeading } from '@/components/shared/section-heading';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { useEmployees } from '@/features/employees/use-employees';
import { EMPTY_VALUE } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS } from '@vyuha/shared';

import { useAssignPartyManager, useParty } from './use-parties';

const UNASSIGNED = '__none__';

/**
 * The relationship manager on a customer: who owns its sales and collections.
 * Anyone who sees the party sees the RM; setting it needs parties.rm.assign.
 *
 * It reads the party itself rather than the lifecycle shape the detail page
 * holds (which carries no manager), so the panel owns its own data and a
 * change re-reads only this.
 */
export function RmPanel({ partyId }: { partyId: string }) {
  const canAssign = usePermission(PERMISSIONS.PARTIES_RM_ASSIGN);
  const party = useParty(partyId);
  const assign = useAssignPartyManager();
  // The picker's options; only fetched for someone who can actually assign.
  const employees = useEmployees({ page: 1, pageSize: 200 }, { enabled: canAssign });
  const current = party.data?.manager ?? null;

  if (party.data === undefined) return null;

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading title="Relationship manager" note="Who owns this customer's sales and collections." />
      {canAssign ? (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={current?.id ?? UNASSIGNED}
            disabled={assign.isPending || employees.isPending}
            onValueChange={(value: string | null) => {
              if (value === null) return;
              const managerId = value === UNASSIGNED ? null : value;
              if (managerId === (current?.id ?? null)) return;
              assign.mutate(
                { partyId, managerId },
                {
                  onSuccess: () => {
                    toast.add({ type: 'success', title: managerId === null ? 'Relationship manager cleared' : 'Relationship manager assigned' });
                  },
                  onError: (error) => {
                    toast.add({ type: 'error', title: 'Could not change the relationship manager', description: error.message });
                  },
                },
              );
            }}
          >
            <SelectTrigger className="w-64" aria-label="Relationship manager">
              <SelectValue placeholder="Assign a relationship manager" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
              {(employees.data?.data ?? []).map((employee) => (
                <SelectItem key={employee.id} value={employee.id}>
                  {[employee.firstName, employee.lastName].filter((part) => part !== null && part !== '').join(' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {assign.isPending ? <Spinner /> : null}
          {current ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={assign.isPending}
              onClick={() => {
                assign.mutate(
                  { partyId, managerId: null },
                  {
                    onSuccess: () => { toast.add({ type: 'success', title: 'Relationship manager cleared' }); },
                    onError: (error) => { toast.add({ type: 'error', title: 'Could not clear the relationship manager', description: error.message }); },
                  },
                );
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-sm [&_svg]:size-4">
          <UserFocusIcon aria-hidden className="text-muted-foreground" />
          {current ? current.name : EMPTY_VALUE}
        </p>
      )}
    </section>
  );
}
