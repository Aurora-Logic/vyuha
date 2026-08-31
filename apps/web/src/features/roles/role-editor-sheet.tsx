import { useMemo, useState } from 'react';
import { InfoIcon, PlusIcon, TrashIcon, WarningCircleIcon } from '@phosphor-icons/react';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { ReasonDialog } from '@/components/shared/reason-dialog';
import { SectionHeading } from '@/components/shared/section-heading';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Item, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { toast } from '@/components/ui/toast';
import { useIsMobile } from '@/hooks/use-mobile';
import type { PermissionKey } from '@vyuha/shared';

import { DeleteRoleDialog } from './delete-role-dialog';
import {
  PERMISSION_GROUPS,
  countAllPermissions,
  samePermissionSet,
  type Role,
} from './types';
import { useCreateRole, useUpdateRole } from './use-roles';

/**
 * REQ-B-07's editor: a role's name, description and permission set.
 *
 * Saving opens a reason dialog rather than writing straight away. That is the
 * "with comments" the whole slice is about, and putting it in the confirm step
 * rather than as a field in the form is deliberate — a reason box sitting above
 * a long checkbox list gets filled in before the change is decided, and reads
 * "changing permissions" for every edit anybody ever makes.
 *
 * A seeded role can have its permissions and description edited but not its
 * name (the seed reconciles by name), and cannot be deleted. Both are stated on
 * the screen next to the disabled control rather than discovered by pressing.
 */

interface RoleEditorSheetProps {
  /** Null with `open` means create; a role means edit. */
  role: Role | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canManage: boolean;
}

export function RoleEditorSheet({ role, open, onOpenChange, canManage }: RoleEditorSheetProps) {
  const isMobile = useIsMobile();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? 'bottom' : 'right'}
        className="gap-0 sm:max-w-lg max-md:max-h-[90vh]"
      >
        {/* Keyed so the draft belongs to the role that was opened, not to
            whichever was opened first. */}
        {open ? (
          <RoleEditorBody
            key={role?.id ?? 'new'}
            role={role}
            canManage={canManage}
            onDone={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

type PendingAction = 'save' | 'delete' | null;

function RoleEditorBody({
  role,
  canManage,
  onDone,
}: {
  role: Role | null;
  canManage: boolean;
  onDone: () => void;
}) {
  const creating = role === null;

  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<ReadonlySet<PermissionKey>>(
    () => new Set(role?.permissions ?? []),
  );
  const [confirming, setConfirming] = useState<PendingAction>(null);

  const create = useCreateRole();
  const update = useUpdateRole();

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const chosen = useMemo(() => [...selected].sort(), [selected]);

  const nameChanged = !creating && trimmedName !== role.name;
  const descriptionChanged = !creating && trimmedDescription !== (role.description ?? '');
  const permissionsChanged = creating || !samePermissionSet(chosen, role.permissions);
  const dirty = creating || nameChanged || descriptionChanged || permissionsChanged;

  const nameTooShort = trimmedName.length < 2;
  const nameLocked = !creating && role.isSystem;

  function toggle(key: PermissionKey, next: boolean) {
    setSelected((current) => {
      const copy = new Set(current);
      if (next) copy.add(key);
      else copy.delete(key);
      return copy;
    });
  }

  /**
   * A whole family at once, in one state update.
   *
   * Not a loop over `toggle`: each call is its own setState against the
   * previous set, and React batches them, so forty-odd of those would each
   * build a copy and the last would win. One pass, one copy.
   */
  function setGroup(keys: readonly PermissionKey[], grantAll: boolean) {
    setSelected((current) => {
      const copy = new Set(current);
      for (const key of keys) {
        if (grantAll) copy.add(key);
        else copy.delete(key);
      }
      return copy;
    });
  }

  function submit(reason: string) {
    if (creating) {
      create.mutate(
        {
          name: trimmedName,
          description: trimmedDescription.length > 0 ? trimmedDescription : null,
          permissions: chosen,
          reason,
        },
        {
          onSuccess: (created) => {
            toast.add({
              type: 'success',
              title: `${created.name} created`,
              description: `${String(created.permissions.length)} permissions. Your reason is in the audit log.`,
            });
            setConfirming(null);
            onDone();
          },
        },
      );
      return;
    }

    update.mutate(
      {
        id: role.id,
        // Only what changed. Sending an unchanged name would make the server
        // refuse a seeded role for a rename nobody asked for.
        ...(nameChanged ? { name: trimmedName } : {}),
        ...(descriptionChanged
          ? { description: trimmedDescription.length > 0 ? trimmedDescription : null }
          : {}),
        ...(permissionsChanged ? { permissions: chosen } : {}),
        reason,
      },
      {
        onSuccess: (saved) => {
          toast.add({
            type: 'success',
            title: `${saved.name} saved`,
            description: `${String(saved.permissions.length)} permissions. Your reason is in the audit log.`,
          });
          setConfirming(null);
          onDone();
        },
      },
    );
  }

  return (
    <>
      <SheetHeader className="shrink-0 border-b">
        <SheetTitle>{creating ? 'New role' : role.name}</SheetTitle>
        <SheetDescription>
          {creating
            ? 'A named bundle of permissions. Nothing in the system branches on its name.'
            : `${String(chosen.length)} of ${String(countAllPermissions())} permissions, held by ${String(role.memberCount)} active ${role.memberCount === 1 ? 'account' : 'accounts'}.`}
        </SheetDescription>
      </SheetHeader>

      {/* min-h-0 is load-bearing: a flex child defaults to min-height:auto and
          would grow past the sheet instead of scrolling inside it. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {!canManage ? (
          <Alert>
            <WarningCircleIcon />
            <AlertTitle>Read-only</AlertTitle>
            <AlertDescription>
              Changing a role needs the roles.manage permission, which your account does not hold.
            </AlertDescription>
          </Alert>
        ) : null}

        {nameLocked ? (
          <Alert>
            <InfoIcon />
            <AlertTitle>This is a seeded role</AlertTitle>
            <AlertDescription>
              Its permissions and description are editable. Its name is not, and it cannot be
              deleted — the seed reconciles roles by name, so a rename would create a second one
              on the next run. Re-seeding also resets a seeded role&apos;s permissions back to the
              shipped matrix.
            </AlertDescription>
          </Alert>
        ) : null}

        <Field>
          <FieldLabel htmlFor="role-name">Name</FieldLabel>
          <Input
            id="role-name"
            value={name}
            disabled={!canManage || nameLocked}
            maxLength={60}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <FieldDescription>
            {nameLocked
              ? 'Fixed, because the seed matches on it.'
              : 'At least two characters, unique in this organisation.'}
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="role-description">Description</FieldLabel>
          <Input
            id="role-description"
            value={description}
            disabled={!canManage}
            maxLength={240}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
          <FieldDescription>One line saying who this role is for. Optional.</FieldDescription>
        </Field>

        {PERMISSION_GROUPS.map((group) => {
          const grantedHere = group.permissions.filter((p) => selected.has(p.key)).length;
          return (
          <div key={group.family} className="flex flex-col gap-2">
            <SectionHeading
              title={group.label}
              action={
                <GroupToggle
                  label={group.label}
                  granted={grantedHere}
                  total={group.permissions.length}
                  disabled={!canManage}
                  onChange={(grantAll) => {
                    setGroup(group.permissions.map((p) => p.key), grantAll);
                  }}
                />
              }
            />
            <div className="flex flex-col gap-1">
              {group.permissions.map((permission) => (
                <PermissionToggle
                  key={permission.key}
                  permissionKey={permission.key}
                  description={permission.description}
                  checked={selected.has(permission.key)}
                  disabled={!canManage}
                  onCheckedChange={(next) => {
                    toggle(permission.key, next);
                  }}
                />
              ))}
            </div>
          </div>
          );
        })}
      </div>

      <SheetFooter className="shrink-0 flex-row justify-end gap-2 border-t">
        {!creating && canManage ? (
          <Button
            variant="outline"
            className="mr-auto"
            disabled={role.isSystem}
            title={
              role.isSystem
                ? 'A seeded role cannot be deleted; the seed would recreate it.'
                : undefined
            }
            onClick={() => {
              setConfirming('delete');
            }}
          >
            <TrashIcon data-icon="inline-start" />
            Delete
          </Button>
        ) : null}
        <Button variant="outline" onClick={onDone}>
          <ACTION_ICONS.close data-icon="inline-start" />
          Close
        </Button>
        <Button
          disabled={!canManage || !dirty || nameTooShort}
          onClick={() => {
            create.reset();
            update.reset();
            setConfirming('save');
          }}
        >
          {creating ? <PlusIcon data-icon="inline-start" /> : null}
          {creating ? 'Create' : 'Save'}
        </Button>
      </SheetFooter>

      <ReasonDialog
        open={confirming === 'save'}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
        }}
        title={creating ? `Create ${trimmedName || 'this role'}?` : `Save ${role?.name ?? ''}?`}
        description="A role change takes effect on the holder's very next request, without them signing in again."
        consequences={describeChange({
          creating,
          role,
          chosen,
          nameChanged,
          descriptionChanged,
          permissionsChanged,
        })}
        prompt="Why is this changing?"
        hint="Six months from now this is the only record of why somebody gained or lost an ability."
        confirmLabel={creating ? 'Create role' : 'Save changes'}
        pendingLabel={creating ? 'Creating' : 'Saving'}
        pending={create.isPending || update.isPending}
        error={create.error ?? update.error}
        onConfirm={submit}
      />

      <DeleteRoleDialog
        role={role}
        open={confirming === 'delete'}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
        }}
        onDeleted={onDone}
      />
    </>
  );
}

/** Says exactly what is about to change, so the confirm is not a shrug. */
function describeChange(input: {
  creating: boolean;
  role: Role | null;
  chosen: readonly PermissionKey[];
  nameChanged: boolean;
  descriptionChanged: boolean;
  permissionsChanged: boolean;
}): string[] {
  const { creating, role, chosen } = input;
  if (creating || role === null) {
    return [`The new role will carry ${String(chosen.length)} permissions.`];
  }

  const lines: string[] = [];
  if (input.nameChanged) lines.push(`Renamed from "${role.name}".`);
  if (input.descriptionChanged) lines.push('The description changes.');

  if (input.permissionsChanged) {
    const before = new Set(role.permissions);
    const granted = chosen.filter((key) => !before.has(key));
    const revoked = role.permissions.filter((key) => !chosen.includes(key));
    if (granted.length > 0) lines.push(`Granting: ${granted.join(', ')}.`);
    if (revoked.length > 0) lines.push(`Revoking: ${revoked.join(', ')}.`);
  }

  if (role.memberCount > 0) {
    lines.push(
      `${String(role.memberCount)} active ${role.memberCount === 1 ? 'account is' : 'accounts are'} affected immediately.`,
    );
  }

  return lines;
}

/**
 * One permission, with a real checkbox.
 *
 * The read-only version of this screen showed a tick or the words "Not
 * granted", which was right while nothing could be changed. Now that something
 * can, a checkbox is the control — and it is labelled by the key itself, so the
 * whole 44px row is the hit target rather than a 16px box.
 */
/**
 * Grant or revoke a whole family at once.
 *
 * Forty-seven permissions is forty-seven clicks to build an Admin-shaped role,
 * and the families are how anybody thinks about it -- "this person does
 * purchase" is one decision, not five. The per-permission rows stay, because
 * the exceptions are the point of a custom role; this is the coarse move that
 * makes the fine ones worth having.
 *
 * Three states, not two. A half-granted family must not render as unchecked --
 * that would say "nobody here has anything", and one click would then quietly
 * revoke the two they did have. Indeterminate says what is true, and clicking
 * it grants the rest rather than clearing them, because filling in is the
 * likelier intent and the reversible one.
 */
function GroupToggle({
  label,
  granted,
  total,
  disabled,
  onChange,
}: {
  label: string;
  granted: number;
  total: number;
  disabled: boolean;
  onChange: (grantAll: boolean) => void;
}) {
  const all = granted === total;
  const none = granted === 0;
  return (
    <span className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs tabular-nums">
        {granted} of {total}
      </span>
      <Label className="flex cursor-pointer items-center gap-1.5 text-xs font-normal">
        <Checkbox
          aria-label={`${all ? 'Revoke' : 'Grant'} every permission in ${label}`}
          // Base UI carries the third state on its own prop rather than in
          // `checked`; a half-granted family is checked=false plus
          // indeterminate, which is what renders the dash.
          checked={all}
          indeterminate={!all && !none}
          disabled={disabled}
          onCheckedChange={() => {
            // From anything but "all", fill in. Only a full family clears.
            onChange(!all);
          }}
        />
        All
      </Label>
    </span>
  );
}

function PermissionToggle({
  permissionKey,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  permissionKey: PermissionKey;
  description: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <Item size="sm" className="min-h-11 px-0">
      <Checkbox
        id={`perm-${permissionKey}`}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next: boolean | 'indeterminate') => {
          onCheckedChange(next === true);
        }}
      />
      <ItemContent className="min-w-0 gap-0.5">
        <Label htmlFor={`perm-${permissionKey}`} className="cursor-pointer">
          <ItemTitle className="truncate font-mono text-xs">{permissionKey}</ItemTitle>
        </Label>
        <ItemDescription className="truncate text-xs">{description}</ItemDescription>
      </ItemContent>
      {disabled && checked ? <Badge variant="secondary">Granted</Badge> : null}
    </Item>
  );
}
