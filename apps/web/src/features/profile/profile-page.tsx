import { Fragment, useState } from 'react';
import { CaretDownIcon, IdentificationBadgeIcon, ShieldCheckIcon, UsersThreeIcon } from '@phosphor-icons/react';

import { PageHeader } from '@/components/shared/page-header';
import { SearchField } from '@/components/shared/search-field';
import { SectionHeading } from '@/components/shared/section-heading';
import { ThemeToggleGroup } from '@/components/shared/theme-toggle-group';
import { MfaProfileSection } from '@/features/auth/mfa-profile-section';
import { useMfaStatus } from '@/features/auth/use-mfa';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemSeparator, ItemTitle } from '@/components/ui/item';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { NotificationPreferences } from '@/features/notifications/notification-preferences';
import { humaniseEnum } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useMe } from '@/lib/session/use-session';
import { PERMISSION_DESCRIPTIONS, employeeDisplayName, type PermissionKey } from '@vyuha/shared';

/**
 * The account behind the session, and exactly what it may do.
 *
 * Everything here is read from `/auth/me` and nothing is computed locally.
 * Technical design §10 makes the server's effective permission set the single
 * answer to "what can this person do", and a screen that recalculated it from
 * role names would be a second, quieter answer that could disagree.
 *
 * Laid out in the order a person needs it (owner, 22 Aug 2026): who you are,
 * read in a glance, with three figures under it; then what is yours to
 * change -- how you sign in, how the product looks to you, what reaches you
 * -- two columns on a desk, one on a phone; then the reference list of
 * permissions, folded, with a filter, because twenty-odd rows are the wrong
 * thing to scroll past to reach nothing.
 *
 * It is reached from the user menu rather than the sidebar: PRD §6.1 fixes the
 * sidebar groups to Work, Records, Reports and Setup, and a personal account
 * page belongs to none of them.
 */

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const first = words[0]?.charAt(0) ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

/** The module a permission key belongs to, read from its first segment. */
const MODULE_LABELS: Record<string, string> = {
  punch: 'Punching',
  attendance: 'Attendance',
  leave: 'Leave',
  employee: 'People',
  shift: 'Shifts',
  holiday: 'Holidays',
  report: 'Reports',
  reports: 'Reports',
  settings: 'Settings',
  roles: 'Roles',
  audit: 'Audit',
  integration: 'Integrations',
  masters: 'Masters',
  receivables: 'Receivables',
  crm: 'CRM',
  sales: 'Sales',
  purchase: 'Purchase',
  access: 'Access',
};

function groupByModule(permissions: readonly PermissionKey[]): { label: string; keys: PermissionKey[] }[] {
  const groups = new Map<string, PermissionKey[]>();
  for (const key of permissions) {
    const prefix = key.split('.')[0] ?? key;
    const label = MODULE_LABELS[prefix] ?? humaniseEnum(prefix);
    groups.set(label, [...(groups.get(label) ?? []), key]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, keys]) => ({ label, keys: [...keys].sort((a, b) => a.localeCompare(b)) }));
}

export function ProfilePage() {
  const { data: me, isPending, isError, error, refetch } = useMe();

  if (isPending) {
    // The skeleton is the page's own shape: the identity row, the strip,
    // then the two columns. A skeleton that looks like something else
    // promises the wrong screen for the half-second it shows.
    return (
      <div role="status" aria-busy="true" aria-label="Loading profile" className="flex flex-col gap-6">
        <div className="flex items-start gap-4">
          <Skeleton className="size-12 shrink-0 rounded-full" />
          <div className="flex flex-col gap-2 pt-1">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3 w-56" />
            <Skeleton className="h-5 w-32" />
          </div>
        </div>
        <Skeleton className="h-14 w-full" />
        <div className="grid gap-6 lg:grid-cols-2">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldCheckIcon />
          </EmptyMedia>
          <EmptyTitle>Could not load your profile</EmptyTitle>
          <EmptyDescription>{error.message}</EmptyDescription>
        </EmptyHeader>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void refetch();
          }}
        >
          Try again
        </Button>
      </Empty>
    );
  }

  // Unreachable behind SessionGate, which renders the sign-in screen instead of
  // the shell when there is no session. Handled anyway so the screen degrades
  // to a sentence rather than to a blank page if that ever stops being true.
  if (!me) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>Not signed in</EmptyTitle>
          <EmptyDescription>Sign in to see your profile.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const name = me.employee ? employeeDisplayName(me.employee.firstName, me.employee.lastName) : me.user.email;

  return (
    <>
      <PageHeader description="The account you are signed in with, what is yours to change, and what it is allowed to do." />

      <Identity name={name} email={me.user.email} employeeCode={me.employee?.employeeCode ?? null} status={me.user.status} roles={me.roles} />

      <AtAGlance roleCount={me.roles.length} permissionCount={me.permissions.length} />

      {/* What is yours to change. Two columns on a desk; on a phone they
          stack, sign-in first because it is the one that can lock you out. */}
      <div className="grid gap-8 lg:grid-cols-2 lg:gap-10">
        <div className="flex flex-col gap-8">
          <MfaProfileSection />
          <section className="flex flex-col gap-3">
            <SectionHeading title="Appearance for you" note="Light, dark, or whatever the device is using. The workspace's colours are an administrator's setting." />
            <ThemeToggleGroup className="w-full max-w-sm" />
          </section>
        </div>
        <NotificationPreferences />
      </div>

      <Separator />

      <Access permissions={me.permissions} />
    </>
  );
}

function Identity({ name, email, employeeCode, status, roles }: { name: string; email: string; employeeCode: string | null; status: string; roles: readonly { id: string; name: string }[] }) {
  return (
    <section className="flex items-start gap-4">
      <Avatar size="lg">
        <AvatarFallback>{initialsOf(name)}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="truncate text-xl leading-tight font-semibold tracking-tight">{name}</h2>
        {/* The email is the sign-in; when the account has no employee record the name is the email already. */}
        {name === email ? null : <p className="text-muted-foreground truncate text-sm">{email}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {employeeCode === null ? (
            // REQ-B-02: a login and an employee record are separate entities. Saying so beats an unexplained dash.
            <Badge variant="outline">Not linked to an employee record</Badge>
          ) : (
            <Badge variant="outline" className="font-mono">
              <IdentificationBadgeIcon data-icon="inline-start" />
              {employeeCode}
            </Badge>
          )}
          {status === 'ACTIVE' ? null : <Badge variant="destructive">{humaniseEnum(status)}</Badge>}
          {roles.map((role) => (
            <Badge key={role.id} variant="secondary">
              {role.name}
            </Badge>
          ))}
          {roles.length === 0 ? <span className="text-muted-foreground text-xs">No role assigned — only what everyone can see.</span> : null}
        </div>
      </div>
    </section>
  );
}

/** Three figures, read before anything is scrolled: the same strip the dashboard uses. */
function AtAGlance({ roleCount, permissionCount }: { roleCount: number; permissionCount: number }) {
  const mfa = useMfaStatus();
  const twoStep = mfa.data === undefined ? '…' : mfa.data.enabled ? 'On' : mfa.data.required ? 'Set-up required' : 'Off';
  const entries: readonly [string, string][] = [
    ['Roles', String(roleCount)],
    ['Permissions', String(permissionCount)],
    ['Two-step sign-in', twoStep],
  ];
  return (
    <dl className="divide-border grid grid-cols-2 divide-x divide-y border sm:grid-cols-3 sm:divide-y-0">
      {entries.map(([label, value], index) => (
        <div key={label} className={cn('flex flex-col gap-0.5 px-3 py-2', index === entries.length - 1 && 'col-span-2 sm:col-span-1')}>
          <dt className="text-muted-foreground text-[0.6875rem]">{label}</dt>
          <dd className="text-base font-medium tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The roles, then the effective permission list folded behind a row with a count and a filter. */
function Access({ permissions }: { permissions: readonly PermissionKey[] }) {
  const [needle, setNeedle] = useState('');
  const query = needle.trim().toLowerCase();
  const matching = query === '' ? permissions : permissions.filter((key) => key.toLowerCase().includes(query) || PERMISSION_DESCRIPTIONS[key].toLowerCase().includes(query));
  const groups = groupByModule(matching);

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading
        icon={<UsersThreeIcon />}
        title="What you can do"
        note="The effective set the server returned. Every screen and endpoint is decided from this list, not from the role names."
      />
      <Collapsible>
        {/* The whole row is the target (thumb-reach: a full-width row, not a
            chevron), and the count is on the closed state so nobody has to
            open it to learn there is nothing inside. */}
        <CollapsibleTrigger render={<Button variant="ghost" className="group/fold h-auto w-full min-h-11 justify-between gap-4 px-0 text-left whitespace-normal hover:bg-transparent" />}>
          <span className="text-sm font-semibold">
            Permissions
            <span className="text-muted-foreground ml-2 font-normal tabular-nums">{permissions.length}</span>
          </span>
          <CaretDownIcon className="text-muted-foreground shrink-0 transition-transform duration-200 ease-out group-data-[panel-open]/fold:rotate-180 motion-reduce:transition-none" />
        </CollapsibleTrigger>
        <CollapsibleContent className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0 motion-reduce:transition-none">
          {permissions.length > 0 ? (
            <div className="flex flex-col gap-4 pt-3">
              <SearchField id="profile-permission-filter" label="Filter permissions" value={needle} onValueChange={setNeedle} placeholder="Filter permissions" className="sm:max-w-xs" />
              {groups.length === 0 ? <p className="text-muted-foreground text-xs">Nothing matches &ldquo;{needle.trim()}&rdquo;.</p> : null}
              {groups.map((group) => (
                <section key={group.label} className="flex flex-col gap-1.5">
                  <h3 className="text-muted-foreground text-xs font-medium">{group.label}</h3>
                  <ItemGroup role="list" className="gap-0 border">
                    {group.keys.map((permission, index) => (
                      <Fragment key={permission}>
                        {index > 0 ? <ItemSeparator className="my-0" /> : null}
                        {/* Meaning first, key second: the sentence is what a
                            person reads, the key is what they paste into a
                            question to an administrator. */}
                        <Item size="xs" role="listitem" className="min-h-9 rounded-none">
                          <ItemContent className="min-w-0 gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
                            <ItemTitle className="min-w-0 text-xs font-normal">{PERMISSION_DESCRIPTIONS[permission]}</ItemTitle>
                            <ItemDescription className="font-mono text-xs sm:ml-auto sm:shrink-0">{permission}</ItemDescription>
                          </ItemContent>
                        </Item>
                      </Fragment>
                    ))}
                  </ItemGroup>
                </section>
              ))}
            </div>
          ) : (
            <Empty className="mt-3 border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ShieldCheckIcon />
                </EmptyMedia>
                <EmptyTitle>No permissions</EmptyTitle>
                <EmptyDescription>This account has no permissions yet. Ask an administrator to assign a role.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
