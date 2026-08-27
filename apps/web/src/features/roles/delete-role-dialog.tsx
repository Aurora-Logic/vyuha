import { TrashIcon } from '@phosphor-icons/react';

import { ReasonDialog } from '@/components/shared/reason-dialog';
import { toast } from '@/components/ui/toast';

import type { Role } from './types';
import { useDeleteRole } from './use-roles';

interface DeleteRoleDialogProps {
  /** The role about to go. Null keeps the dialog closed whatever `open` says. */
  role: Role | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Once the recycle bin has it: close whatever surface this was opened from. */
  onDeleted?: () => void;
}

/**
 * The delete confirm for a role, with its reason (REQ-B-09a).
 *
 * Reached from two places -- the editor's footer and a row's action menu --
 * and kept in one file so both name the same three consequences and post
 * through the same soft-delete route. A role deleted from the list and one
 * deleted from its editor must land in the recycle bin as the same record.
 */
export function DeleteRoleDialog({ role, open, onOpenChange, onDeleted }: DeleteRoleDialogProps) {
  const remove = useDeleteRole();

  return (
    <ReasonDialog
      open={open && role !== null}
      onOpenChange={(next) => {
        // A refused attempt's error must not greet the next role opened here.
        if (!next) remove.reset();
        onOpenChange(next);
      }}
      title={`Delete ${role?.name ?? ''}?`}
      description="The role goes to the recycle bin. Nothing is hard-deleted."
      consequences={[
        'It disappears from the role list and from the assignment picker.',
        'It is refused while any active account still holds it, and the refusal names them.',
        'Restoring it later brings its permission set back exactly as it is now.',
      ]}
      prompt="Why is this role being deleted?"
      hint="Stored on the deletion record and shown in the recycle bin."
      confirmLabel="Delete role"
      pendingLabel="Deleting"
      confirmIcon={<TrashIcon data-icon="inline-start" />}
      destructive
      pending={remove.isPending}
      error={remove.error}
      onConfirm={(reason) => {
        if (role === null) return;
        remove.mutate(
          { id: role.id, reason },
          {
            onSuccess: () => {
              toast.add({
                type: 'success',
                title: `${role.name} deleted`,
                description: 'It is in the recycle bin and can be restored.',
              });
              onOpenChange(false);
              onDeleted?.();
            },
          },
        );
      }}
    />
  );
}
