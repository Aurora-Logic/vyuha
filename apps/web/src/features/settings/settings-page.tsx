import { useState, type ReactNode } from 'react';
import { format } from 'date-fns';
import { EnvelopeSimpleIcon, LockKeyIcon, PaperPlaneTiltIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { Link, useSearchParams } from 'react-router';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { PageHeader } from '@/components/shared/page-header';
import { SettingsPanel, SettingsPanelSkeleton, SettingsRow, SettingsSection } from '@/components/shared/settings-panel';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { SampleDataNotice } from '@/features/attendance/sample-data-notice';
import {
  RecordHistoryButton,
  RecordHistorySheet,
} from '@/features/audit/record-history-sheet';
import { PurchaseSettingsPanel } from '@/features/purchase/purchase-settings-panel';
import { SalesSettingsPanel } from '@/features/sales/sales-settings-panel';
import { ApiError } from '@/lib/api/client';
import { useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { cn } from '@/lib/utils';
import {
  CURRENCY_SYMBOLS,
  DEVICE_BINDING_MODES,
  MFA_POLICIES,
  MFA_POLICY_LABELS,
  NUMBER_FORMATS,
  NUMBER_FORMAT_LABELS,
  PERMISSIONS,
  SESSION_HOURS_MAX,
  SESSION_HOURS_MIN,
  type AccessWindow,
  type DuplicatesPolicy,
  type ReturnReasonsPolicy,
} from '@vyuha/shared';

import { AccessWindowPanel } from './access-window-panel';
import { AppearancePanel } from './appearance-panel';
import { CustomerClassesTab } from './customer-classes-tab';
import { DocumentsPanel } from './documents-panel';
import { OfficeLocationPanel } from './office-location-panel';
import { PolicyChoiceField, PolicyDurationField, PolicyNumberField, PolicyToggleField, ReturnReasonsField } from './policy-fields';
import {
  DATE_FORMATS,
  DEVICE_BINDING_LABELS,
  GEOFENCE_BEHAVIOURS,
  GEOFENCE_LABELS,
  INTEREST_DAY_BASES,
  INTEREST_RECEIVABLE_BASES,
  INTEREST_RECEIVABLE_BASE_LABELS,
  INTEREST_STOCK_CLOCK_LABELS,
  INTEREST_STOCK_CLOCK_STARTS,
  MONTH_LABELS,
  TIMEZONE_OPTIONS,
  WEEKDAY_LABELS,
  type Appearance,
  type AttendancePolicy,
  type InterestPolicy,
  type LeavePolicy,
  type OrgProfile,
  type OrgSettings,
  type PhotoPolicy,
  type RetentionPolicy,
  type SecurityPolicy,
  type SettingsPatch,
  type WorkspaceLocale,
} from './types';
import { useAccessWindowDraft, useSaveAccessWindow } from './use-access-window';
import { useOfficeGeofence, useSaveGeofence, type GeofenceWrite } from './use-office-location';
import { useSaveSettings, useSettings, useTestEmail } from './use-settings';

/**
 * REQ-L-01 to REQ-L-05 / PRD §5 screen 16, plus the office geofence (REQ-D-08)
 * and the sign-in window (12 REQ-AB-02).
 *
 * One draft for the whole screen, saved a panel at a time (owner, 27 Aug
 * 2026: the Supabase anatomy -- each panel carries its own status and its
 * own Save, enabled only while that panel has moved). A panel's request
 * carries only the groups it owns, so saving the timezone cannot blank the
 * punch policy, and a panel the reader has not touched is never sent. Ctrl+A,
 * the Tally Accept key, still saves everything dirty on the screen at once:
 * the person who has edited three panels should not have to find three
 * buttons.
 *
 * The office location and the access window are the two things here that are
 * not settings rows: the geofence centre lives on a `locations` record and the
 * window on its own route, so their panels save through their own writers.
 * All three writers run through one path, and the screen reports which of
 * them landed rather than assuming all did.
 *
 * No tab strip. The administration rail (admin-shell) names the pages and
 * writes `?tab=`; this screen only reads it and draws the sections it names.
 */

const KB = 1024;

interface Draft {
  organisation: OrgProfile;
  attendance: AttendancePolicy;
  photo: PhotoPolicy;
  security: SecurityPolicy;
  appearance: Appearance;
  locale: WorkspaceLocale;
  retention: RetentionPolicy;
  duplicates: DuplicatesPolicy;
  returns: ReturnReasonsPolicy;
  interest: InterestPolicy;
  leave: LeavePolicy;
}

type DraftKey = keyof Draft;

const DRAFT_KEYS: readonly DraftKey[] = [
  'organisation',
  'attendance',
  'photo',
  'security',
  'appearance',
  'locale',
  'retention',
  'duplicates',
  'returns',
  'interest',
  'leave',
];

function draftOf(settings: OrgSettings): Draft {
  return {
    organisation: settings.organisation,
    attendance: settings.attendance,
    photo: settings.photo,
    security: settings.security,
    appearance: settings.appearance,
    locale: settings.locale,
    retention: settings.retention,
    duplicates: settings.duplicates,
    returns: settings.returns,
    interest: settings.interest,
    leave: settings.leave,
  };
}

function sameGroup(left: unknown, right: unknown): boolean {
  // Every group is a flat object of strings and numbers, so serialised
  // equality is exactly the equality that decides whether to send it.
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Only the groups that moved. An unchanged group left out of the body is what
 * makes "absent means unchanged" safe on the server.
 */
function patchOf(draft: Draft, saved: OrgSettings): SettingsPatch {
  const patch: SettingsPatch = {};

  if (!sameGroup(draft.organisation, saved.organisation)) {
    patch.organisation = {
      name: draft.organisation.name,
      legalName: draft.organisation.legalName,
      timezone: draft.organisation.timezone,
      dateFormat: draft.organisation.dateFormat,
      weekStart: draft.organisation.weekStart,
      leaveYearStartMonth: draft.organisation.leaveYearStartMonth,
    };
  }
  if (!sameGroup(draft.attendance, saved.attendance)) patch.attendance = draft.attendance;
  if (!sameGroup(draft.photo, saved.photo)) patch.photo = draft.photo;
  if (!sameGroup(draft.security, saved.security)) patch.security = draft.security;
  if (!sameGroup(draft.appearance, saved.appearance)) patch.appearance = draft.appearance;
  if (!sameGroup(draft.locale, saved.locale)) patch.locale = draft.locale;
  if (!sameGroup(draft.retention, saved.retention)) patch.retention = draft.retention;
  if (!sameGroup(draft.duplicates, saved.duplicates)) patch.duplicates = draft.duplicates;
  if (!sameGroup(draft.returns, saved.returns)) patch.returns = draft.returns;
  if (!sameGroup(draft.interest, saved.interest)) patch.interest = draft.interest;
  if (!sameGroup(draft.leave, saved.leave)) patch.leave = draft.leave;

  return patch;
}

/** The part of the patch a panel owns: its groups, and only those that moved. */
function pickGroups(patch: SettingsPatch, keys: readonly DraftKey[]): SettingsPatch {
  const picked: SettingsPatch = {};
  for (const key of keys) {
    if (patch[key] !== undefined) Object.assign(picked, { [key]: patch[key] });
  }
  return picked;
}

/** `keys` taken from `from`; every other group left as `into` has it. */
function withGroups(into: Draft, from: Draft, keys: readonly DraftKey[]): Draft {
  const next = { ...into };
  for (const key of keys) Object.assign(next, { [key]: from[key] });
  return next;
}

/**
 * Owner, 22 Aug 2026: every module's settings live here, one page each. The
 * page is in the URL so the sales and purchase list pages can deep-link to
 * theirs, and so a reload lands where the person was. The rail writes it;
 * this screen reads it.
 */
const TABS = ['organisation', 'appearance', 'office', 'attendance', 'sales', 'purchase', 'classes', 'documents', 'email', 'access'] as const;
type SettingsTab = (typeof TABS)[number];

function useSettingsTab(): SettingsTab {
  const [searchParams] = useSearchParams();
  const param = searchParams.get('tab');
  return TABS.includes(param as SettingsTab) ? (param as SettingsTab) : 'organisation';
}

/**
 * The page the address names if the reader may see it, else the first they
 * may -- which is also the row the rail highlights, so the two agree.
 */
function visibleTab(tab: SettingsTab, visible: Record<SettingsTab, boolean>): SettingsTab {
  if (visible[tab]) return tab;
  return TABS.find((candidate) => visible[candidate]) ?? tab;
}

export function SettingsPage() {
  const canManage = usePermission(PERMISSIONS.SETTINGS_MANAGE);
  const canSales = usePermission(PERMISSIONS.SALES_DISCOUNT_APPROVE);
  const canPurchase = usePermission(PERMISSIONS.PURCHASE_DOCUMENT_APPROVE);
  // REQ-M-02 and REQ-L-05. Settings are the one record where the diff matters
  // more than the current value: "what is the retention now" is on the screen,
  // and "who shortened it, and when" is the question a purged photo raises.
  const canReadTrail = usePermission(PERMISSIONS.AUDIT_VIEW);
  const [historyOpen, setHistoryOpen] = useState(false);
  const query = useSettings({ enabled: canManage });
  const saved = query.data?.value ?? null;

  return (
    <>
      <PageHeader
        description="Every module's settings in one place: the organisation, how it looks, attendance and photos, sales and purchase thresholds, documents, email, security and the sign-in window."
        action={
          canManage && canReadTrail && saved !== null ? (
            <RecordHistoryButton
              onClick={() => {
                setHistoryOpen(true);
              }}
            />
          ) : undefined
        }
      />

      {!canManage && (canSales || canPurchase) ? (
        <ModuleSettingsOnly canSales={canSales} canPurchase={canPurchase} />
      ) : canManage ? (
        <div className="flex flex-col gap-6">
          {query.data?.sample ? <SampleDataNotice what="settings" /> : null}

          {query.isPending ? <SettingsPanelSkeleton label="Loading settings" heading /> : null}

          {query.isError ? (
            <QueryErrorAlert
              error={query.error}
              subject="settings"
              onRetry={() => {
                void query.refetch();
              }}
            />
          ) : null}

          {saved ? <SettingsForm key={saved.organisation.id} saved={saved} canSales={canSales} canPurchase={canPurchase} /> : null}
        </div>
      ) : (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot change organisation settings</EmptyTitle>
            <EmptyDescription>
              This screen needs the settings.manage permission. Ask an administrator to grant it,
              or ask them to make the change for you.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {saved !== null ? (
        <RecordHistorySheet
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          entityType="settings"
          // The organisation row is what every settings write audits against,
          // including the logo (REQ-L-01), so one id covers every page.
          entityId={saved.organisation.id}
          title="Organisation settings"
          description="Every settings change, with the values before and after."
        />
      ) : null}
    </>
  );
}

/** A sales or purchase approver without settings.manage: their pages, nothing else. */
function ModuleSettingsOnly({ canSales, canPurchase }: { canSales: boolean; canPurchase: boolean }) {
  const tab = visibleTab(useSettingsTab(), {
    organisation: false,
    appearance: false,
    office: false,
    attendance: false,
    sales: canSales,
    purchase: canPurchase,
    classes: false,
    documents: false,
    email: false,
    access: false,
  });
  return tab === 'purchase' ? <PurchaseSettingsPanel /> : <SalesSettingsPanel />;
}

interface SaveFooterProps {
  /** Something to send: enables Save. */
  dirty: boolean;
  /**
   * Something to put back. Usually the same as `dirty`, but an office draft
   * the panel refuses to send has nothing to save and still wants a Cancel.
   */
  canCancel?: boolean;
  /** This panel's own write in flight: what the spinner reports. */
  saving: boolean;
  /**
   * Any write on the screen in flight: what disables the buttons. Two panels
   * saving at once would race each other for the draft.
   */
  busy: boolean;
  onCancel: () => void;
  onSave: () => void;
}

/**
 * The right half of a panel footer. Every panel here is also saved by Ctrl+A
 * (PRD §6.4: Accept / Save), so every Save wears the hint.
 */
function SaveFooter({ dirty, canCancel = dirty, saving, busy, onCancel, onSave }: SaveFooterProps) {
  return (
    <>
      {canCancel ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
      <Button size="sm" disabled={!dirty || busy} onClick={onSave}>
        {saving ? <Spinner data-icon="inline-start" /> : <ACTION_ICONS.save data-icon="inline-start" />}
        {saving ? 'Saving' : 'Save changes'}
        <ShortcutHint keys="ctrl+a" className="ml-1 hidden md:inline-flex" />
      </Button>
    </>
  );
}

function SettingsForm({ saved, canSales, canPurchase }: { saved: OrgSettings; canSales: boolean; canPurchase: boolean }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(saved));
  const save = useSaveSettings();
  const office = useOfficeGeofence();
  const saveOffice = useSaveGeofence();
  const accessWindow = useAccessWindowDraft();
  const saveWindow = useSaveAccessWindow();
  // The per-party overrides screen needs its own key, so the link to it hides
  // with the screen rather than leading to a refusal.
  const canConfigureInterest = usePermission(PERMISSIONS.INTEREST_CONFIGURE);
  const canSeeClasses = usePermission(PERMISSIONS.CFO_SALES_VIEW);
  const canEditClasses = usePermission(PERMISSIONS.CFO_TIER_MASTER);
  const tab = visibleTab(useSettingsTab(), {
    organisation: true,
    appearance: true,
    office: true,
    attendance: true,
    sales: canSales,
    purchase: canPurchase,
    classes: canSeeClasses,
    documents: true,
    email: true,
    access: true,
  });

  const patch = patchOf(draft, saved);
  const officeWrite = office.write;
  const windowWrite = accessWindow.write;
  const dirty = Object.keys(patch).length > 0 || officeWrite !== null || windowWrite !== null;
  const saving = save.isPending || saveOffice.isPending || saveWindow.isPending;
  // An office draft the panel refuses to send is not "saved", and the status
  // line would be lying if it said so.
  const officeBlocked = office.change.kind === 'invalid';

  /**
   * The one write path. A panel's Save names its own groups and nothing
   * else; Ctrl+A names every group and both records, and what is clean is
   * simply not sent.
   */
  function persist(keys: readonly DraftKey[], officeChange: GeofenceWrite | null, windowChange: AccessWindow | null) {
    if (saving) return;
    const settingsPatch = pickGroups(patch, keys);
    const sendSettings = Object.keys(settingsPatch).length > 0;
    if (!sendSettings && officeChange === null && windowChange === null) return;

    void (async () => {
      // allSettled, not all: a refused geofence must not throw away an edited
      // timezone that the server already accepted, and one rejection must not
      // leave the other promise unhandled.
      const [settingsResult, officeResult, windowResult] = await Promise.allSettled([
        sendSettings ? save.mutateAsync(settingsPatch) : Promise.resolve(null),
        officeChange === null ? Promise.resolve(null) : saveOffice.mutateAsync(officeChange),
        windowChange === null ? Promise.resolve(null) : saveWindow.mutateAsync(windowChange),
      ]);

      const savedSettings = settingsResult.status === 'fulfilled' && settingsResult.value !== null;
      const savedOffice = officeResult.status === 'fulfilled' && officeResult.value !== null;
      const savedWindow = windowResult.status === 'fulfilled' && windowResult.value !== null;

      if (settingsResult.status === 'fulfilled' && settingsResult.value !== null) {
        // Only the groups that were sent take the server's answer. A panel
        // that was not part of this save keeps the edits the reader is still
        // making in it.
        const fresh = draftOf(settingsResult.value);
        setDraft((current) => withGroups(current, fresh, keys));
      }
      // The panels derive their fields from the fetched row, so dropping the
      // edits is what makes the server's answer the thing on screen.
      if (savedOffice) office.reset();
      if (savedWindow) accessWindow.reset();

      // PRD §6.6: the toast repeats the action the button named — and names
      // only what actually saved. A failure is rendered above the fields it
      // did not save, not in a corner the reader has already looked away from.
      const savedNames = [savedSettings ? 'Settings' : null, savedOffice ? 'office location' : null, savedWindow ? 'access window' : null].filter((name): name is string => name !== null);
      if (savedNames.length > 0) {
        const first = savedNames[0] ?? 'Settings';
        const title = savedNames.length === 1 ? `${first.charAt(0).toUpperCase()}${first.slice(1)} saved` : `${first.charAt(0).toUpperCase()}${first.slice(1)} and ${savedNames.slice(1).join(' and ')} saved`;
        toast.add({
          type: 'success',
          title,
          description: 'The change is recorded in the audit log.',
        });
      }
    })();
  }

  function submit() {
    if (!dirty || saving) return;
    persist(DRAFT_KEYS, officeWrite, windowWrite);
  }

  function saveGroups(keys: readonly DraftKey[]) {
    persist(keys, null, null);
  }

  function resetGroups(keys: readonly DraftKey[]) {
    setDraft((current) => withGroups(current, draftOf(saved), keys));
    save.reset();
  }

  // The patch in flight names the groups it carries, so a panel shows its own
  // spinner rather than every panel spinning for one save.
  function inFlight(keys: readonly DraftKey[]): boolean {
    const sent = save.variables;
    return save.isPending && sent !== undefined && keys.some((key) => sent[key] !== undefined);
  }

  /** The footer of a panel that owns `keys`, and nothing else on the screen. */
  function panelProps(keys: readonly DraftKey[]): { status: string; footer: ReactNode } {
    const panelDirty = keys.some((key) => patch[key] !== undefined);
    return {
      status: panelDirty ? 'Unsaved changes' : 'Saved',
      footer: (
        <SaveFooter
          dirty={panelDirty}
          saving={inFlight(keys)}
          busy={saving}
          onCancel={() => {
            resetGroups(keys);
          }}
          onSave={() => {
            saveGroups(keys);
          }}
        />
      ),
    };
  }

  // PRD §6.4: Ctrl+A is Accept / Save, and it fires from inside a field.
  useShortcut({
    id: 'settings.save',
    keys: 'ctrl+a',
    label: 'Accept / Save',
    scope: 'screen',
    allowInInput: true,
    when: () => dirty && !saving,
    run: submit,
  });

  function patchOrganisation(next: Partial<OrgProfile>) {
    setDraft((current) => ({ ...current, organisation: { ...current.organisation, ...next } }));
  }
  function patchAttendance(next: Partial<AttendancePolicy>) {
    setDraft((current) => ({ ...current, attendance: { ...current.attendance, ...next } }));
  }
  function patchAppearance(next: Partial<Appearance>) {
    setDraft((current) => ({ ...current, appearance: { ...current.appearance, ...next } }));
  }
  function patchLocale(next: Partial<WorkspaceLocale>) {
    setDraft((current) => ({ ...current, locale: { ...current.locale, ...next } }));
  }
  function patchRetention(next: Partial<RetentionPolicy>) {
    setDraft((current) => ({ ...current, retention: { ...current.retention, ...next } }));
  }
  function patchReturns(next: Partial<ReturnReasonsPolicy>) {
    setDraft((current) => ({ ...current, returns: { ...current.returns, ...next } }));
  }
  function patchDuplicates(next: Partial<DuplicatesPolicy>) {
    setDraft((current) => ({ ...current, duplicates: { ...current.duplicates, ...next } }));
  }
  function patchInterest(next: Partial<InterestPolicy>) {
    setDraft((current) => ({ ...current, interest: { ...current.interest, ...next } }));
  }
  function patchSecurity(next: Partial<SecurityPolicy>) {
    setDraft((current) => ({ ...current, security: { ...current.security, ...next } }));
  }
  function patchPhoto(next: Partial<PhotoPolicy>) {
    setDraft((current) => ({ ...current, photo: { ...current.photo, ...next } }));
  }
  function patchLeave(next: Partial<LeavePolicy>) {
    setDraft((current) => ({ ...current, leave: { ...current.leave, ...next } }));
  }

  // The two security panels share one group, so either footer sends the whole
  // group; what each one reports as dirty is only its own rows, so an edit to
  // the session length does not light "Unsaved changes" under two-step sign-in.
  const mfaDirty = draft.security.mfaPolicy !== saved.security.mfaPolicy;
  const sessionsDirty =
    draft.security.sessionHours !== saved.security.sessionHours || draft.security.endSessionOnClose !== saved.security.endSessionOnClose;
  const securitySaving = inFlight(['security']);

  return (
    <div className="flex flex-col gap-8">
      {saved.unreadableKeys.length > 0 ? (
        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>Some stored settings could not be read</AlertTitle>
          <AlertDescription>
            The default is shown instead for {saved.unreadableKeys.join(', ')}. Saving this screen
            replaces the stored value with a valid one.
          </AlertDescription>
        </Alert>
      ) : null}

      {save.isError ? (
        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>
            {save.error instanceof ApiError &&
            (save.error.code === 'NETWORK_ERROR' || save.error.status === 404)
              ? 'Not saved: the settings endpoint is not connected yet'
              : 'Could not save these settings'}
          </AlertTitle>
          <AlertDescription>
            {save.error instanceof ApiError && save.error.code === 'VALIDATION_FAILED'
              ? save.error.message
              : 'Your edits are still here. Nothing was sent to the server, so nothing changed.'}
          </AlertDescription>
        </Alert>
      ) : null}

      {tab === 'organisation' ? (
        <>
          <SettingsSection
            title="Organisation profile"
            note="These decide how every date on every screen and export is written."
          >
            <SettingsPanel {...panelProps(['organisation'])}>
              <SettingsRow label="Name" htmlFor="org-name" description="Shown in the header and on every export.">
                <Input
                  id="org-name"
                  value={draft.organisation.name}
                  onChange={(event) => {
                    patchOrganisation({ name: event.target.value });
                  }}
                />
              </SettingsRow>

              <SettingsRow
                label="Legal name"
                htmlFor="org-legal-name"
                description="The registered entity name, if it differs. Leave empty to use the name above."
              >
                <Input
                  id="org-legal-name"
                  value={draft.organisation.legalName ?? ''}
                  onChange={(event) => {
                    const next = event.target.value.trim();
                    patchOrganisation({ legalName: next.length === 0 ? null : event.target.value });
                  }}
                />
              </SettingsRow>

              <PolicyChoiceField
                id="org-timezone"
                label="Timezone"
                value={draft.organisation.timezone}
                options={TIMEZONE_OPTIONS.map((zone) => ({ value: zone, label: zone }))}
                help="Every attendance date is decided in this zone unless a location overrides it."
                onValueChange={(next) => {
                  patchOrganisation({ timezone: next });
                }}
              />

              <PolicyChoiceField
                id="org-date-format"
                label="Date format"
                value={draft.organisation.dateFormat}
                // A rendered sample, not the pattern: a day past 12 shows the day/month order.
                options={DATE_FORMATS.map((value) => ({ value, label: format(new Date(2026, 11, 31), value) }))}
                help="How dates are written on screen and in exports."
                onValueChange={(next) => {
                  patchOrganisation({ dateFormat: next });
                }}
              />

              <PolicyChoiceField
                id="org-week-start"
                label="Week starts on"
                value={String(draft.organisation.weekStart)}
                options={WEEKDAY_LABELS.map((day) => ({
                  value: String(day.value),
                  label: day.label,
                }))}
                help="The first column of every calendar and the first day of a weekly-off pattern."
                onValueChange={(next) => {
                  patchOrganisation({ weekStart: Number(next) });
                }}
              />

              <PolicyChoiceField
                id="org-leave-year"
                label="Leave year starts in"
                value={String(draft.organisation.leaveYearStartMonth)}
                options={MONTH_LABELS.map((month) => ({
                  value: String(month.value),
                  label: month.label,
                }))}
                help="Accruals, carry-forward and lapse are all measured from here."
                onValueChange={(next) => {
                  patchOrganisation({ leaveYearStartMonth: Number(next) });
                }}
              />
            </SettingsPanel>
          </SettingsSection>

          <SettingsSection title="Numbers and money" note="How every figure is written on screen and in exports.">
            <SettingsPanel {...panelProps(['locale'])}>
              <PolicyChoiceField
                id="org-number-format"
                label="Grouping"
                value={draft.locale.numberFormat}
                options={NUMBER_FORMATS.map((value) => ({ value, label: NUMBER_FORMAT_LABELS[value] }))}
                enforcedBy={saved.enforcement.locale.numberFormat}
                onValueChange={(next) => {
                  patchLocale({ numberFormat: next });
                }}
              />
              <PolicyChoiceField
                id="org-currency"
                label="Currency symbol"
                value={draft.locale.currencySymbol}
                options={CURRENCY_SYMBOLS.map((value) => ({ value, label: value }))}
                enforcedBy={saved.enforcement.locale.currencySymbol}
                onValueChange={(next) => {
                  patchLocale({ currencySymbol: next });
                }}
              />
            </SettingsPanel>
          </SettingsSection>

          <SettingsSection
            title="Data retention"
            note="Punch photos have their own retention under Attendance. The audit trail is append-only and is not retained by policy."
          >
            <SettingsPanel {...panelProps(['retention'])}>
              <PolicyNumberField
                id="retention-exports"
                label="Keep downloads for"
                unit="days"
                help="An export in the Downloads tray is removed after this."
                min={1}
                max={365}
                value={draft.retention.exportsDays}
                enforcedBy={saved.enforcement.retention.exportsDays}
                onValueChange={(next) => {
                  patchRetention({ exportsDays: next });
                }}
              />
            </SettingsPanel>
          </SettingsSection>

          <SettingsSection
            title="Return reasons"
            note="What the return desk may choose from. Free text is always allowed beside the reason, never in place of it — a list of six is what makes the reason report readable."
          >
            <SettingsPanel {...panelProps(['returns'])}>
              <ReturnReasonsField
                reasons={draft.returns.reasons}
                enforcedBy={saved.enforcement.returns.reasons}
                onValueChange={(reasons) => {
                  patchReturns({ reasons });
                }}
              />
            </SettingsPanel>
          </SettingsSection>

          <SettingsSection
            title="Duplicate detection"
            note="After each pull the detector clusters parties and items Tally holds twice. A shared GSTIN or PAN is always a certain match; this is the floor for the rest."
          >
            <SettingsPanel {...panelProps(['duplicates'])}>
              <PolicyNumberField
                id="duplicates-confidence"
                label="Show a cluster from"
                unit="% sure"
                help="Below this the pair is not shown anywhere. 75 is the default; lower finds more, higher finds surer."
                min={50}
                max={100}
                value={Math.round(draft.duplicates.confidenceMin * 100)}
                enforcedBy={saved.enforcement.duplicates.confidenceMin}
                onValueChange={(next) => {
                  patchDuplicates({ confidenceMin: Math.min(1, Math.max(0.5, next / 100)) });
                }}
              />
            </SettingsPanel>
          </SettingsSection>

          <SettingsSection
            title="Interest cost"
            note="What blocked working capital costs, priced from the daily closing series (D-22). Receivables are voucher-grain until Tally bill marks arrive; stock is on a purchase cost basis."
          >
            <SettingsPanel {...panelProps(['interest'])}>
              <PolicyNumberField
                id="interest-annual-rate"
                label="Annual rate"
                unit="% per annum"
                help="Applied to every rupee-day of blocked working capital. Seeded at 12.00; a party override beats it."
                min={0}
                max={100}
                value={draft.interest.annualRatePct}
                enforcedBy={saved.enforcement.interest.annualRatePct}
                onValueChange={(next) => {
                  patchInterest({ annualRatePct: next });
                }}
              />

              <PolicyChoiceField
                id="interest-day-basis"
                label="Days in the interest year"
                value={String(draft.interest.dayBasis)}
                options={INTEREST_DAY_BASES.map((value) => ({
                  value: String(value),
                  label: value === 360 ? '360 (bank convention)' : '365',
                }))}
                enforcedBy={saved.enforcement.interest.dayBasis}
                onValueChange={(next) => {
                  patchInterest({ dayBasis: next === '360' ? 360 : 365 });
                }}
              />

              <PolicyChoiceField
                id="interest-receivable-base"
                label="A receivable bill is"
                value={draft.interest.receivableBase}
                options={INTEREST_RECEIVABLE_BASES.map((value) => ({
                  value,
                  label: INTEREST_RECEIVABLE_BASE_LABELS[value],
                }))}
                help="Bill-wise marks have no writer yet, so vouchers settled oldest-first are the honest grain today."
                enforcedBy={saved.enforcement.interest.receivableBase}
                onValueChange={(next) => {
                  patchInterest({ receivableBase: next });
                }}
              />

              <PolicyChoiceField
                id="interest-stock-clock"
                label="Stock starts costing interest"
                value={draft.interest.stockClockStart}
                options={INTEREST_STOCK_CLOCK_STARTS.map((value) => ({
                  value,
                  label: INTEREST_STOCK_CLOCK_LABELS[value],
                }))}
                help="Until the vendor is due, their money funds the shelf, not yours."
                enforcedBy={saved.enforcement.interest.stockClockStart}
                onValueChange={(next) => {
                  patchInterest({ stockClockStart: next });
                }}
              />

              <PolicyToggleField
                id="interest-include-gst"
                label="Fund GST paid on purchases"
                help="Off in v1 (D-22): interest is computed on the purchase value alone."
                value={draft.interest.includeGstInStock}
                enforcedBy={saved.enforcement.interest.includeGstInStock}
                onValueChange={(next) => {
                  patchInterest({ includeGstInStock: next });
                }}
              />

              <PolicyNumberField
                id="interest-recompute-window"
                label="Recompute window"
                unit="days back"
                help="The nightly build recomputes this far back, so a backdated voucher is caught rather than trusted to a stale snapshot."
                min={7}
                max={365}
                value={draft.interest.recomputeWindowDays}
                enforcedBy={saved.enforcement.interest.recomputeWindowDays}
                onValueChange={(next) => {
                  patchInterest({ recomputeWindowDays: next });
                }}
              />

              <PolicyNumberField
                id="interest-non-moving"
                label="Non-moving after"
                unit="days"
                help="Days without outward movement before an item is flagged non-moving in the stock interest report."
                min={7}
                max={365}
                value={draft.interest.nonMovingDays}
                enforcedBy={saved.enforcement.interest.nonMovingDays}
                onValueChange={(next) => {
                  patchInterest({ nonMovingDays: next });
                }}
              />
            </SettingsPanel>
            {canConfigureInterest ? (
              <p className="text-muted-foreground text-xs">
                Per-party overrides — rate and credit days — live on{' '}
                <Link to="/interest-overrides" className="text-foreground font-medium underline-offset-4 hover:underline">
                  their own screen
                </Link>
                , beside the parties whose credit terms are missing.
              </p>
            ) : null}
          </SettingsSection>
        </>
      ) : null}

      {tab === 'appearance' ? (
        <AppearancePanel
          value={draft.appearance}
          saved={saved.appearance}
          enforcedBy={saved.enforcement.appearance.accentHue}
          onChange={patchAppearance}
          {...panelProps(['appearance'])}
        />
      ) : null}

      {tab === 'office' ? (
        <OfficeLocationPanel
          office={office}
          behaviour={{
            value: draft.attendance.geofenceBehaviour,
            enforcedBy: saved.enforcement.attendance.geofenceBehaviour,
          }}
          saveError={saveOffice.error}
          status={
            officeBlocked
              ? 'Nothing to save. The office location has a problem to fix first.'
              : officeWrite !== null
                ? 'Unsaved changes'
                : 'Saved'
          }
          footer={
            <SaveFooter
              dirty={officeWrite !== null}
              canCancel={officeWrite !== null || officeBlocked}
              saving={saveOffice.isPending}
              busy={saving}
              onCancel={() => {
                office.reset();
                saveOffice.reset();
              }}
              onSave={() => {
                persist([], officeWrite, null);
              }}
            />
          }
        />
      ) : null}

      {tab === 'attendance' ? (
        <>
          <SettingsSection title="Attendance policy" note="Changing a value here alters behaviour without a redeploy.">
            <SettingsPanel {...panelProps(['attendance'])}>
              <PolicyChoiceField
                id="policy-geofence"
                label="Punch outside the location radius"
                value={draft.attendance.geofenceBehaviour}
                options={GEOFENCE_BEHAVIOURS.map((value) => ({
                  value,
                  label: GEOFENCE_LABELS[value],
                }))}
                enforcedBy={saved.enforcement.attendance.geofenceBehaviour}
                onValueChange={(next) => {
                  patchAttendance({ geofenceBehaviour: next });
                }}
              >
                <FieldDescription>
                  The centre and radius are on the Office location tab, per location. Punch
                  currently blocks outside the radius whatever this says.
                </FieldDescription>
              </PolicyChoiceField>

              <PolicyChoiceField
                id="policy-device-binding"
                label="Punch from an unrecognised device"
                value={draft.attendance.deviceBindingMode}
                options={DEVICE_BINDING_MODES.map((value) => ({
                  value,
                  label: DEVICE_BINDING_LABELS[value],
                }))}
                enforcedBy={saved.enforcement.attendance.deviceBindingMode}
                onValueChange={(next) => {
                  patchAttendance({ deviceBindingMode: next });
                }}
              />

              <PolicyToggleField
                id="policy-early-arrival"
                label="Celebrate early arrivals"
                help="A punch in ahead of shift start by the threshold gets a moment of confetti and counts toward a streak."
                value={draft.attendance.earlyArrivalEnabled}
                enforcedBy={saved.enforcement.attendance.earlyArrivalEnabled}
                onValueChange={(next) => {
                  patchAttendance({ earlyArrivalEnabled: next });
                }}
              />

              <PolicyDurationField
                id="policy-early-threshold"
                label="Early means at least"
                help="Before shift start. The streak resets on a worked day that misses it; days off carry it forward."
                value={draft.attendance.earlyArrivalThresholdMinutes}
                enforcedBy={saved.enforcement.attendance.earlyArrivalThresholdMinutes}
                disabled={!draft.attendance.earlyArrivalEnabled}
                onValueChange={(next) => {
                  patchAttendance({ earlyArrivalThresholdMinutes: Math.max(5, next) });
                }}
              />

              <PolicyNumberField
                id="policy-max-work"
                label="Maximum worked time in a day"
                unit="minutes"
                help="Worked minutes are capped here, so a missing OUT punch cannot produce a 30-hour day."
                min={60}
                max={1440}
                value={draft.attendance.maxWorkMinutes}
                enforcedBy={saved.enforcement.attendance.maxWorkMinutes}
                onValueChange={(next) => {
                  patchAttendance({ maxWorkMinutes: next });
                }}
              />

              <PolicyNumberField
                id="policy-regularization-window"
                label="Regularization window"
                unit="days back"
                help="How far back an employee may raise a correction."
                min={1}
                max={90}
                value={draft.attendance.regularizationWindowDays}
                enforcedBy={saved.enforcement.attendance.regularizationWindowDays}
                onValueChange={(next) => {
                  patchAttendance({ regularizationWindowDays: next });
                }}
              />

              <PolicyNumberField
                id="policy-regularization-count"
                label="Regularizations allowed"
                unit="per month"
                help="Zero switches regularization off without removing the permission from a role."
                min={0}
                max={31}
                value={draft.attendance.regularizationMaxPerMonth}
                enforcedBy={saved.enforcement.attendance.regularizationMaxPerMonth}
                onValueChange={(next) => {
                  patchAttendance({ regularizationMaxPerMonth: next });
                }}
              />

              <PolicyToggleField
                id="policy-regularization-auto-file"
                label="Auto-file a correction for a late or out-of-window punch"
                help="Instead of waiting for the employee to notice and raise it, a draft correction is started for them automatically — they only add why before it goes to their approver."
                value={draft.attendance.regularizationAutoFile}
                enforcedBy={saved.enforcement.attendance.regularizationAutoFile}
                onValueChange={(next) => {
                  patchAttendance({ regularizationAutoFile: next });
                }}
              />

              <PolicyNumberField
                id="policy-escalation"
                label="Escalate an untouched approval after"
                unit="days"
                help="An approval nobody has actioned moves to HR."
                min={1}
                max={30}
                value={draft.attendance.autoEscalationDays}
                enforcedBy={saved.enforcement.attendance.autoEscalationDays}
                onValueChange={(next) => {
                  patchAttendance({ autoEscalationDays: next });
                }}
              />
            </SettingsPanel>
          </SettingsSection>

          <SettingsSection
            title="Leave policy"
            note="Read by the leave engine on every application, accrual and grant. The month here is the one accruals actually follow (OS-1)."
          >
            <SettingsPanel {...panelProps(['leave'])}>
              <PolicyChoiceField
                id="leave-year-start"
                label="Leave year starts in"
                value={String(draft.leave.yearStartMonth)}
                options={MONTH_LABELS.map((month) => ({
                  value: String(month.value),
                  label: month.label,
                }))}
                help="Accrual, carry-forward and lapse are all measured from here."
                enforcedBy={saved.enforcement.leave.yearStartMonth}
                onValueChange={(next) => {
                  patchLeave({ yearStartMonth: Number(next) });
                }}
              />

              <PolicyNumberField
                id="leave-comp-off-expiry"
                label="Comp-off credits expire after"
                unit="days"
                help="Counted from the day the credit was earned. An unexpired credit is spendable; past this it lapses."
                min={1}
                max={365}
                value={draft.leave.compOffExpiryDays}
                enforcedBy={saved.enforcement.leave.compOffExpiryDays}
                onValueChange={(next) => {
                  patchLeave({ compOffExpiryDays: next });
                }}
              />

              <PolicyNumberField
                id="leave-concurrent-absence"
                label="Warn when absences in a department reach"
                unit="people"
                help="The leave calendar flags a day this many of one department are away. Zero switches the warning off."
                min={0}
                max={100}
                value={draft.leave.concurrentAbsenceThreshold}
                enforcedBy={saved.enforcement.leave.concurrentAbsenceThreshold}
                onValueChange={(next) => {
                  patchLeave({ concurrentAbsenceThreshold: next });
                }}
              />
            </SettingsPanel>
          </SettingsSection>

          <SettingsSection
            title="Punch photos"
            note="Retention decides how long a face is kept, so it is a privacy setting as much as a storage one."
          >
            <SettingsPanel {...panelProps(['photo'])}>
              <PolicyNumberField
                id="photo-retention"
                label="Keep punch photos for"
                unit="months"
                help="The consent notice shown at the first punch quotes this number."
                // The server's floor: a regularization window can reach 90
                // days, and a shorter retention would purge a photo while its
                // punch is still disputable.
                min={3}
                max={120}
                value={draft.photo.retentionMonths}
                enforcedBy={saved.enforcement.photo.retentionMonths}
                onValueChange={(next) => {
                  patchPhoto({ retentionMonths: next });
                }}
              >
                {draft.photo.retentionMonths !== saved.photo.retentionMonths ? (
                  <Alert variant={draft.photo.retentionMonths < saved.photo.retentionMonths ? 'destructive' : 'default'} className="mt-2">
                    <WarningCircleIcon />
                    <AlertTitle>
                      {draft.photo.retentionMonths < saved.photo.retentionMonths
                        ? 'Shortening retention removes photos permanently'
                        : 'Retention is being extended'}
                    </AlertTitle>
                    <AlertDescription>
                      {draft.photo.retentionMonths < saved.photo.retentionMonths
                        ? `From ${String(saved.photo.retentionMonths)} months to ${String(draft.photo.retentionMonths)}. The purge job deletes the object and the thumbnail; a purged photo cannot be recovered, and any dispute that relied on it will have no evidence.`
                        : `From ${String(saved.photo.retentionMonths)} months to ${String(draft.photo.retentionMonths)}. Photos already past their old window may already have been purged.`}
                    </AlertDescription>
                  </Alert>
                ) : null}
              </PolicyNumberField>

              <PolicyNumberField
                id="photo-min-bytes"
                label="Smallest stored photo"
                unit="KB"
                help="Below this the burnt-in stamp stops being legible."
                min={1}
                max={2048}
                value={Math.round(draft.photo.minBytes / KB)}
                enforcedBy={saved.enforcement.photo.minBytes}
                onValueChange={(next) => {
                  patchPhoto({ minBytes: next * KB });
                }}
              />

              <PolicyNumberField
                id="photo-max-bytes"
                label="Largest stored photo"
                unit="KB"
                help="Above this the image is re-encoded at a lower quality band."
                min={1}
                max={2048}
                value={Math.round(draft.photo.maxBytes / KB)}
                enforcedBy={saved.enforcement.photo.maxBytes}
                onValueChange={(next) => {
                  patchPhoto({ maxBytes: next * KB });
                }}
              >
                {draft.photo.minBytes > draft.photo.maxBytes ? (
                  <Alert variant="destructive" className="mt-2">
                    <WarningCircleIcon />
                    <AlertTitle>The size band is inverted</AlertTitle>
                    <AlertDescription>
                      The smallest photo cannot be larger than the largest. The server refuses this,
                      so Save will fail until one of the two moves.
                    </AlertDescription>
                  </Alert>
                ) : null}
              </PolicyNumberField>
            </SettingsPanel>
          </SettingsSection>
        </>
      ) : null}

      {tab === 'sales' ? <SalesSettingsPanel /> : null}
      {tab === 'purchase' ? <PurchaseSettingsPanel /> : null}

      {tab === 'email' ? <EmailTab settings={saved} /> : null}

      {tab === 'access' ? (
        <>
          <SettingsSection
            title="Two-step sign-in"
            note="An authenticator app after the password. Anyone may turn it on from their profile; this is who must."
          >
            <SettingsPanel
              status={mfaDirty ? 'Unsaved changes' : 'Saved'}
              footer={
                <SaveFooter
                  dirty={mfaDirty}
                  saving={securitySaving}
                  busy={saving}
                  onCancel={() => {
                    patchSecurity({ mfaPolicy: saved.security.mfaPolicy });
                    save.reset();
                  }}
                  onSave={() => {
                    saveGroups(['security']);
                  }}
                />
              }
            >
              <PolicyChoiceField
                id="policy-mfa"
                label="Required for"
                value={draft.security.mfaPolicy}
                options={MFA_POLICIES.map((value) => ({ value, label: MFA_POLICY_LABELS[value] }))}
                enforcedBy={saved.enforcement.security.mfaPolicy}
                onValueChange={(next) => {
                  patchSecurity({ mfaPolicy: next });
                }}
              >
                <FieldDescription>
                  A person whose role is named here is asked to set up the app at their next sign-in, before any screen.
                </FieldDescription>
              </PolicyChoiceField>
            </SettingsPanel>
          </SettingsSection>

          <SettingsSection title="Sessions" note="How long a sign-in lasts, and whether closing the browser ends it.">
            <SettingsPanel
              status={sessionsDirty ? 'Unsaved changes' : 'Saved'}
              footer={
                <SaveFooter
                  dirty={sessionsDirty}
                  saving={securitySaving}
                  busy={saving}
                  onCancel={() => {
                    patchSecurity({ sessionHours: saved.security.sessionHours, endSessionOnClose: saved.security.endSessionOnClose });
                    save.reset();
                  }}
                  onSave={() => {
                    saveGroups(['security']);
                  }}
                />
              }
            >
              <PolicyNumberField
                id="policy-session-hours"
                label="A sign-in lasts"
                unit="hours"
                help="Renewed by use: an active person is not signed out mid-shift. 720 is thirty days."
                min={SESSION_HOURS_MIN}
                max={SESSION_HOURS_MAX}
                value={draft.security.sessionHours}
                enforcedBy={saved.enforcement.security.sessionHours}
                onValueChange={(next) => {
                  patchSecurity({ sessionHours: next });
                }}
              />
              <PolicyToggleField
                id="policy-session-close"
                label="Sign out when the browser closes"
                help="The sign-in cookie lasts the browser session instead of the hours above. A shared computer wants this on."
                value={draft.security.endSessionOnClose}
                enforcedBy={saved.enforcement.security.endSessionOnClose}
                onValueChange={(next) => {
                  patchSecurity({ endSessionOnClose: next });
                }}
              />
            </SettingsPanel>
          </SettingsSection>

          <AccessWindowPanel
            window={accessWindow}
            saveError={saveWindow.error}
            status={windowWrite !== null ? 'Unsaved changes' : 'Saved'}
            footer={
              <SaveFooter
                dirty={windowWrite !== null}
                saving={saveWindow.isPending}
                busy={saving}
                onCancel={() => {
                  accessWindow.reset();
                  saveWindow.reset();
                }}
                onSave={() => {
                  persist([], null, windowWrite);
                }}
              />
            }
          />
        </>
      ) : null}

      {tab === 'documents' ? <DocumentsPanel /> : null}
      {tab === 'classes' ? <CustomerClassesTab canEdit={canEditClasses} /> : null}
    </div>
  );
}

/** A value the screen can only report, at the far right of its row. */
function ReadOnlyRow({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <SettingsRow layout="end" label={label}>
      <span className={cn('text-xs font-medium tabular-nums', className)}>{children}</span>
    </SettingsRow>
  );
}

/**
 * REQ-L-04.
 *
 * Read-only, and that is the honest rendering: SMTP is deployment
 * configuration, not a row in a table, so an editable form here would be a set
 * of fields that silently do nothing. What the screen can do is show what the
 * server is actually configured with, and prove it works.
 */
function EmailTab({ settings }: { settings: OrgSettings }) {
  const test = useTestEmail();

  return (
    <SettingsSection
      title="Outbound email"
      note="Read from the server's own configuration; change it where the service is deployed."
    >
      {settings.email.transport === 'log' ? (
        <Alert>
          <EnvelopeSimpleIcon />
          <AlertTitle>Mail is off, and that is the default</AlertTitle>
          <AlertDescription>
            The server writes messages to its log instead of sending them. Invitations and password
            resets are unaffected: both hand their link back on screen, for you to send however you
            like. What is not delivered is everything else — reminders and approval notices. Set the
            transport to SMTP to turn those on.
          </AlertDescription>
        </Alert>
      ) : null}

      <SettingsPanel
        status="The message goes to your own address and nowhere else. A test send that accepted any recipient would be a mail relay behind an admin login."
        footer={
          <Button
            variant="outline"
            size="sm"
            disabled={test.isPending}
            onClick={() => {
              test.mutate();
            }}
          >
            {test.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <PaperPlaneTiltIcon data-icon="inline-start" />
            )}
            {test.isPending ? 'Sending' : 'Send a test message'}
          </Button>
        }
      >
        <ReadOnlyRow label="Transport">
          {settings.email.transport === 'smtp' ? 'SMTP' : 'Log only, nothing is delivered'}
        </ReadOnlyRow>
        <ReadOnlyRow label="Host">
          {settings.email.host}:{settings.email.port}
        </ReadOnlyRow>
        <ReadOnlyRow label="TLS">{settings.email.secure ? 'On' : 'Off'}</ReadOnlyRow>
        {/* Capped and broken rather than hugging the edge: a From with a
            display name is the one value here long enough to push a phone
            sideways. */}
        <ReadOnlyRow label="From" className="max-w-64 break-all text-right">
          {settings.email.from}
        </ReadOnlyRow>
        <ReadOnlyRow label="Credentials">
          {settings.email.credentialsConfigured ? 'Configured' : 'None set'}
        </ReadOnlyRow>
      </SettingsPanel>

      {test.isSuccess ? (
        <Alert>
          <EnvelopeSimpleIcon />
          <AlertTitle>Test message sent to {test.data.sentTo}</AlertTitle>
          <AlertDescription>
            {test.data.transport === 'smtp'
              ? 'The mail server accepted it. If it does not arrive, the problem is downstream of this application.'
              : 'The transport is set to log, so the message was written to the server log rather than delivered.'}
          </AlertDescription>
        </Alert>
      ) : null}

      {test.isError ? (
        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>
            {test.error instanceof ApiError &&
            (test.error.code === 'NETWORK_ERROR' || test.error.status === 404)
              ? 'The test-send endpoint is not connected yet'
              : 'The message could not be sent'}
          </AlertTitle>
          <AlertDescription>
            {test.error instanceof ApiError && test.error.status !== 404
              ? test.error.message
              : 'Nothing was delivered. Check the transport settings above.'}
          </AlertDescription>
        </Alert>
      ) : null}
    </SettingsSection>
  );
}
