import { useState } from 'react';
import {
  CheckIcon,
  ListChecksIcon,
  LockKeyIcon,
  PlusIcon,
  ShieldCheckIcon,
} from '@phosphor-icons/react';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { ListSkeleton } from '@/components/shared/list-skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { RowActions } from '@/components/shared/row-actions';
import { SearchField } from '@/components/shared/search-field';
import { SectionHeading } from '@/components/shared/section-heading';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { TabsToolbar, TabsToolbarAction } from '@/components/shared/tabs-toolbar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Item, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { useShortcut } from '@/lib/keyboard/registry';
import { usePermission, usePermissions } from '@/lib/session/permissions';
import { PERMISSIONS, type PermissionKey } from '@vyuha/shared';

import { DeleteRoleDialog } from './delete-role-dialog';
import { RoleEditorSheet } from './role-editor-sheet';
import { PERMISSION_GROUPS, countAllPermissions, type Role } from './types';
import { useRoles } from './use-roles';

/**
 * REQ-B-07 / PRD §5 screen 17: roles as named bundles of permissions.
 *
 * Two tabs, because the screen answers two different questions. "Which roles
 * exist and what does each one carry" is the administrator's question and needs
 * `roles.manage`. "What am I allowed to do" is everybody's question, and the
 * answer is already in the session — so that tab needs no permission at all.
 *
 * P2-3 recorded that this screen was read-only because `PATCH /roles` did not
 * exist. It does now, and every write goes through a confirm step that takes a
 * typed reason.
 *
 * Laid out on Supabase's Team page (owner, 27 Aug 2026): the strip and the one
 * primary action share a row, a filter sits under it, then the table, then a
 * quiet count -- so this register reads like every other in the
 * administration column.
 */

/** "7 roles", "1 role": the quiet line under a table. */
function countOf(count: number, noun: string): string {
  return `${String(count)} ${count === 1 ? noun : `${noun}s`}`;
}

/** The one state a row wears: a seeded role can be edited but not renamed or deleted. */
function KindChip({ role }: { role: Role }) {
  return role.isSystem ? (
    <Badge variant="secondary">Seeded</Badge>
  ) : (
    <Badge variant="outline">Custom</Badge>
  );
}

function matchesRole(role: Role, needle: string): boolean {
  return (
    role.name.toLowerCase().includes(needle) ||
    (role.description ?? '').toLowerCase().includes(needle)
  );
}

export function RolesPage() {
  const canManage = usePermission(PERMISSIONS.ROLES_MANAGE);

  return (
    <>
      <PageHeader description="Roles are named bundles of permissions. Nothing in the system branches on a role name, and every change takes a reason." />

      <Tabs defaultValue="roles" className="gap-4">
        <TabsToolbar
          list={
            <TabsList>
              <TabsTrigger value="roles" className="px-3">
                <ShieldCheckIcon data-icon="inline-start" />
                Roles
              </TabsTrigger>
              <TabsTrigger value="permissions" className="px-3">
                <ListChecksIcon data-icon="inline-start" />
                Permissions
              </TabsTrigger>
            </TabsList>
          }
        >
          <TabsContent value="roles">
            {canManage ? (
              <RolesTab />
            ) : (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <LockKeyIcon />
                  </EmptyMedia>
                  <EmptyTitle>You cannot view the role definitions</EmptyTitle>
                  <EmptyDescription>
                    This needs the roles.manage permission. Your own permissions are on the
                    Permissions tab, which needs nothing.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </TabsContent>

          <TabsContent value="permissions">
            <PermissionCatalogueTab />
          </TabsContent>
        </TabsToolbar>
      </Tabs>
    </>
  );
}

function RolesTab() {
  const [editing, setEditing] = useState<Role | null>(null);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<Role | null>(null);
  const [search, setSearch] = useState('');
  const query = useRoles();
  const roles = query.data?.data ?? [];

  // Filtered here rather than by the server: the list is every role the
  // organisation has, a dozen rows already in hand, and a round trip per
  // keystroke would be slower than the filter it replaced.
  const needle = search.trim().toLowerCase();
  const visible = needle === '' ? roles : roles.filter((role) => matchesRole(role, needle));

  function openRole(role: Role | null) {
    setEditing(role);
    setOpen(true);
  }

  // PRD §6.4: Alt+C creates the record the screen is about.
  useShortcut({
    id: 'roles.create',
    keys: 'alt+c',
    label: 'New role',
    scope: 'screen',
    run: () => {
      openRole(null);
    },
  });

  const actionsFor = (row: Role) => (
    <RowActions
      label={`Actions for ${row.name}`}
      actions={[
        {
          key: 'edit',
          label: 'Edit role',
          icon: ACTION_ICONS.edit,
          onSelect: () => {
            openRole(row);
          },
        },
        {
          key: 'delete',
          label: 'Delete role',
          icon: ACTION_ICONS.remove,
          destructive: true,
          onSelect: () => {
            setDeleting(row);
          },
          ...(row.isSystem
            ? { unavailableReason: 'A seeded role cannot be deleted; the seed would recreate it.' }
            : {}),
        },
      ]}
    />
  );

  const columns: RecordColumn<Role>[] = [
    {
      key: 'name',
      header: 'Role',
      cell: (row) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{row.name}</span>
          <KindChip role={row} />
        </span>
      ),
    },
    {
      key: 'description',
      header: 'Description',
      cell: (row) =>
        row.description ?? <span className="text-muted-foreground">No description</span>,
      secondary: true,
    },
    {
      key: 'permissions',
      header: 'Permissions',
      cell: (row) => row.permissions.length,
      numeric: true,
    },
    {
      key: 'members',
      header: 'Members',
      cell: (row) => row.memberCount,
      numeric: true,
    },
    {
      key: 'actions',
      header: 'Actions',
      className: 'w-12 text-right',
      cell: actionsFor,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <TabsToolbarAction>
        <Button
          size="sm"
          onClick={() => {
            openRole(null);
          }}
        >
          <PlusIcon data-icon="inline-start" />
          New role
          <ShortcutHint keys="alt+c" className="ml-1 hidden md:inline-flex" />
        </Button>
      </TabsToolbarAction>

      <SearchField
        id="role-search"
        label="Filter roles by name or description"
        placeholder="Name or description"
        value={search}
        onValueChange={setSearch}
        className="min-w-0 sm:max-w-xs"
      />

      {query.isPending ? <ListSkeleton rows={4} label="Loading roles" /> : null}

      {query.isError ? (
        <QueryErrorAlert
          error={query.error}
          subject="roles"
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : null}

      {query.isSuccess && roles.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldCheckIcon />
            </EmptyMedia>
            <EmptyTitle>No roles yet</EmptyTitle>
            <EmptyDescription>
              The seed creates Employee, Operations, HR and Admin. An organisation with no roles
              has nobody who can sign in and do anything, so this usually means the seed has not
              been run.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {roles.length > 0 && visible.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldCheckIcon />
            </EmptyMedia>
            <EmptyTitle>No matching roles</EmptyTitle>
            <EmptyDescription>
              No role is named or described like that. Clear the filter to see them all.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {visible.length > 0 ? (
        <RecordTable
          columns={columns}
          rows={visible}
          rowKey={(row) => row.id}
          mobilePrimary={(row) => row.name}
          mobileStatus={(row) => <KindChip role={row} />}
          mobileSupporting={(row) =>
            `${countOf(row.permissions.length, 'permission')} · ${countOf(row.memberCount, 'member')}`
          }
          onRowActivate={openRole}
        />
      ) : null}

      {roles.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          {visible.length === 0 ? 'No roles match' : countOf(visible.length, 'role')}
        </p>
      ) : null}

      <RoleEditorSheet role={editing} open={open} onOpenChange={setOpen} canManage />
      <DeleteRoleDialog
        role={deleting}
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
      />
    </div>
  );
}

/**
 * One permission, with whether the reader holds it.
 *
 * A tick and a phrase rather than a disabled checkbox. A greyed-out checkbox
 * says "you may not change this yet"; this tab is not about changing anything,
 * it is about telling somebody what they can currently do.
 */
function PermissionRow({
  permissionKey,
  description,
  granted,
}: {
  permissionKey: PermissionKey;
  description: string;
  granted: boolean;
}) {
  return (
    <Item size="sm" className="min-h-11 px-0">
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="truncate font-mono text-xs">{permissionKey}</ItemTitle>
        <ItemDescription className="truncate text-xs">{description}</ItemDescription>
      </ItemContent>
      {granted ? (
        <Badge variant="secondary">
          <CheckIcon aria-hidden />
          Granted
        </Badge>
      ) : (
        <span className="text-muted-foreground text-xs" aria-label="Not granted">
          Not granted
        </span>
      )}
    </Item>
  );
}

/**
 * The permission catalogue, marked with what the reader themselves holds.
 *
 * `ALL_PERMISSIONS` is the contract package and the held set came from `/me`,
 * so this tab is real data whatever the roles endpoint is doing.
 */
function PermissionCatalogueTab() {
  const held = usePermissions();

  return (
    <div className="flex flex-col gap-4">
      <SectionHeading
        title="Every permission in the system"
        note={`You hold ${String(held.size)} of ${String(countAllPermissions())}. This comes from your session, not from the roles list.`}
      />

      <div className="flex flex-col gap-6 border p-4">
        {PERMISSION_GROUPS.map((group) => (
          <div key={group.family} className="flex flex-col gap-2">
            <SectionHeading title={group.label} />
            <div className="flex flex-col gap-1">
              {group.permissions.map((permission) => (
                <PermissionRow
                  key={permission.key}
                  permissionKey={permission.key}
                  description={permission.description}
                  granted={held.has(permission.key)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <p className="text-muted-foreground text-xs">{countOf(countAllPermissions(), 'permission')}</p>
    </div>
  );
}
