import { useState, type ReactNode } from 'react';
import {
  BuildingsIcon,
  LockKeyIcon,
  MapPinAreaIcon,
  MapPinIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';

import { RecordPicker } from '@/components/shared/record-picker';
import { SettingsPanel, SettingsPanelSkeleton, SettingsRow, SettingsSection } from '@/components/shared/settings-panel';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { formatCoordinate, parseMapsLink, type MapsLinkResult } from '@/features/org-masters/maps-link';
import { ApiError } from '@/lib/api/client';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS, type LocationSummary } from '@vyuha/shared';

import {
  DEFAULT_GEOFENCE_RADIUS_M,
  MAX_RADIUS_M,
  MIN_RADIUS_M,
  draftHasNoCentre,
  isGeofenced,
} from './office-location';
import { GEOFENCE_LABELS, type GeofenceBehaviour } from './types';
import type { OfficeDraft } from './office-location';
import type { OfficeGeofence } from './use-office-location';

/**
 * Where the office is (REQ-D-08), from Settings.
 *
 * It was only ever reachable at Organisation → Locations → Actions → Edit,
 * inside a form about names, codes and timezones. Three levels down is not
 * where anybody looks for "where is our office", and the value decides whether
 * an employee standing in the building is allowed to punch — so it gets a
 * page of its own.
 *
 * Its own page rather than a block inside Organisation because it edits a
 * different record: the organisation page is a profile, this is a `locations`
 * row, and the two are saved through different routes. The panel's own footer
 * saves it, and Ctrl+A saves it with everything else on the screen.
 *
 * Everything the panel knows arrives through `OfficeGeofence`; the only state
 * it owns is the pasted link, which is a shortcut for filling two fields and
 * is never stored.
 */

const EMPTY_LINK: MapsLinkResult = { kind: 'empty' };

/** True while the two fields still hold exactly what the link was read as. */
function linkStillShown(
  parsed: Extract<MapsLinkResult, { kind: 'found' }>,
  draft: OfficeDraft,
): boolean {
  return (
    draft.latitude === formatCoordinate(parsed.latitude) &&
    draft.longitude === formatCoordinate(parsed.longitude)
  );
}

interface OfficeLocationPanelProps {
  office: OfficeGeofence;
  /** The Attendance page's outcome setting, and whether anything reads it yet. */
  behaviour: { value: GeofenceBehaviour; enforcedBy: string | null | undefined };
  /** The last failure from saving this panel, if any. */
  saveError: unknown;
  /** The panel footer, from the screen that owns the writer. */
  status?: ReactNode;
  footer?: ReactNode;
}

export function OfficeLocationPanel({ office, behaviour, saveError, status, footer }: OfficeLocationPanelProps) {
  const [link, setLink] = useState('');
  const [parsed, setParsed] = useState<MapsLinkResult>(EMPTY_LINK);
  // The screen around this one already refuses anybody without it, so this is
  // the panel stating its own rule rather than inheriting one: a location row
  // carries the geofence, and writing it is an Admin control (OPEN-QUESTIONS
  // P1-1).
  const canManage = usePermission(PERMISSIONS.SETTINGS_MANAGE);

  const { query, locations, total, location, draft, change } = office;
  const noCentre = draft !== null && draftHasNoCentre(draft);

  function pasteLink(text: string) {
    setLink(text);
    const result = parseMapsLink(text);
    setParsed(result);
    // A short link carries no coordinates and a wrong read has to be
    // correctable, so the two number fields below are filled rather than
    // replaced by this one.
    if (result.kind === 'found') {
      office.edit({
        latitude: formatCoordinate(result.latitude),
        longitude: formatCoordinate(result.longitude),
      });
    }
  }

  return (
    <SettingsSection
      title="Office location"
      note="The centre and radius that decide where a punch from a phone is accepted."
    >
      {query.isPending ? <SettingsPanelSkeleton label="Loading the office location" /> : null}

      {query.isError ? <LoadFailure error={query.error} onRetry={() => void query.refetch()} /> : null}

      {!query.isPending && !query.isError && location === null ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BuildingsIcon />
            </EmptyMedia>
            <EmptyTitle>There are no locations yet</EmptyTitle>
            <EmptyDescription>
              A geofence belongs to a place people work from. Add one under Organisation →
              Locations — it needs a name and a code — then set its centre here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {location !== null && draft !== null ? (
        <>
          <GeofenceStatus location={location} behaviour={behaviour} />

          {!canManage ? (
            <Alert>
              <LockKeyIcon />
              <AlertTitle>You can read this, but not change it</AlertTitle>
              <AlertDescription>
                Editing a location needs the settings.manage permission, because its centre decides
                from where a punch is accepted. Ask an administrator to make the change.
              </AlertDescription>
            </Alert>
          ) : null}

          {change.kind === 'invalid' ? (
            <Alert variant="destructive">
              <WarningCircleIcon />
              <AlertTitle>This will not be saved as it stands</AlertTitle>
              <AlertDescription>
                {change.message} Nothing on this tab is sent until it is fixed; the other tabs save
                as usual.
              </AlertDescription>
            </Alert>
          ) : null}

          {saveError ? <SaveFailure error={saveError} /> : null}

          <SettingsPanel status={status} footer={footer}>
            {locations.length > 1 ? (
              <SettingsRow
                label="Location"
                htmlFor="office-location-pick"
                description={`Each location has its own centre and radius.${
                  total > locations.length
                    ? ` Showing the first ${String(locations.length)} of ${String(total)}; the rest are under Organisation → Locations.`
                    : ''
                }`}
              >
                <RecordPicker
                  id="office-location-pick"
                  label="Location"
                  placeholder="Choose a location"
                  searchPlaceholder="Search locations"
                  emptyMessage="No location matches that."
                  disabled={!canManage}
                  icon={<BuildingsIcon className="text-muted-foreground shrink-0" />}
                  value={{ id: location.id, label: location.name, hint: location.code }}
                  options={locations.map((row) => ({
                    id: row.id,
                    label: row.name,
                    hint: row.code,
                  }))}
                  onValueChange={(next) => {
                    if (next === null) return;
                    office.select(next.id);
                    setLink('');
                    setParsed(EMPTY_LINK);
                  }}
                />
              </SettingsRow>
            ) : null}

            {/* The paste row comes first because it is how this gets filled
                in practice. Nobody types a latitude — they press Share in
                Google Maps and paste. */}
            <SettingsRow
              label="Paste a Google Maps link"
              htmlFor="office-maps-link"
              description="It fills the two fields below. The link itself is not stored, so check the numbers before saving."
              note={
                <>
                  {/* Only while the fields still hold what the link produced.
                      Discarding the draft, or correcting a wrong read by hand,
                      puts different numbers in the fields — and a read-back
                      that no longer describes the fields it points at is worse
                      than none. */}
                  {parsed.kind === 'found' && linkStillShown(parsed, draft) ? (
                    <Alert className="mt-2">
                      <MapPinIcon />
                      <AlertTitle>Read from the link</AlertTitle>
                      <AlertDescription>
                        {formatCoordinate(parsed.latitude)}, {formatCoordinate(parsed.longitude)} — check
                        it against the map before saving.
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  {parsed.kind === 'short-link' || parsed.kind === 'unrecognised' ? (
                    <Alert variant="destructive" className="mt-2">
                      <WarningCircleIcon />
                      <AlertTitle>
                        {parsed.kind === 'short-link'
                          ? 'That link hides its coordinates'
                          : 'No coordinates in that'}
                      </AlertTitle>
                      <AlertDescription>{parsed.message}</AlertDescription>
                    </Alert>
                  ) : null}
                </>
              }
            >
              <Input
                id="office-maps-link"
                placeholder="https://www.google.com/maps/@19.0759837,72.8776559,17z"
                disabled={!canManage}
                value={link}
                onChange={(event) => {
                  pasteLink(event.target.value);
                }}
              />
            </SettingsRow>

            <SettingsRow label="Latitude" htmlFor="office-latitude" description="North–south. Between -90 and 90.">
              <Input
                id="office-latitude"
                type="number"
                inputMode="decimal"
                step="any"
                min={-90}
                max={90}
                disabled={!canManage}
                className="tabular-nums"
                value={draft.latitude}
                onChange={(event) => {
                  office.edit({ latitude: event.target.value });
                }}
              />
            </SettingsRow>

            <SettingsRow
              label="Longitude"
              htmlFor="office-longitude"
              description="East–west. Both or neither: clearing both switches geofencing off."
            >
              <Input
                id="office-longitude"
                type="number"
                inputMode="decimal"
                step="any"
                min={-180}
                max={180}
                disabled={!canManage}
                className="tabular-nums"
                value={draft.longitude}
                onChange={(event) => {
                  office.edit({ longitude: event.target.value });
                }}
              />
            </SettingsRow>

            <SettingsRow
              label="Radius (metres)"
              htmlFor="office-radius"
              disabled={noCentre}
              description={
                noCentre
                  ? 'A radius does nothing until a centre is set above.'
                  : `Use about ${String(DEFAULT_GEOFENCE_RADIUS_M)} m. A phone indoors is routinely 30 to 50 metres out, and a tight circle plus a poor fix refuses a real employee standing in the office. The punch already allows for the accuracy the phone reports, so a generous radius is not a hole. Between ${MIN_RADIUS_M.toLocaleString('en-GB')} and ${MAX_RADIUS_M.toLocaleString('en-GB')}.`
              }
            >
              <Input
                id="office-radius"
                type="number"
                inputMode="numeric"
                min={MIN_RADIUS_M}
                max={MAX_RADIUS_M}
                // A radius does nothing without a centre, and a field that
                // accepts a number nothing will ever read is worse than one
                // that says so.
                disabled={!canManage || noCentre}
                className="tabular-nums"
                value={draft.radiusM}
                onChange={(event) => {
                  office.edit({ radiusM: event.target.value });
                }}
              />
            </SettingsRow>

            <AllowlistNote location={location} />
          </SettingsPanel>
        </>
      ) : null}
    </SettingsSection>
  );
}

/**
 * The sentence REQ-D-08 turns on, said rather than left to be inferred from an
 * empty field.
 *
 * It reads the saved row, not the draft: it answers "what happens if somebody
 * punches right now", and right now the server still has the old value.
 */
function GeofenceStatus({
  location,
  behaviour,
}: {
  location: LocationSummary;
  behaviour: { value: GeofenceBehaviour; enforcedBy: string | null | undefined };
}) {
  if (!isGeofenced(location)) {
    return (
      <Alert>
        <MapPinIcon />
        <AlertTitle>Geofencing is off for {location.name}</AlertTitle>
        <AlertDescription>
          No centre is set, so nothing checks where a punch comes from. A punch from a phone is
          accepted wherever the person is standing, and recorded with a flag saying the check was
          off. Paste a Google Maps link below to switch it on.
        </AlertDescription>
      </Alert>
    );
  }

  const outside =
    behaviour.enforcedBy === null || behaviour.enforcedBy === undefined
      ? 'A punch from further away is refused, after the accuracy the phone reports is subtracted from the distance — so a poor fix gets the benefit of the doubt. The "Punch outside the location radius" setting on the Attendance tab does not change that yet: the punch blocks whatever it says.'
      : `A punch from further away follows the "Punch outside the location radius" setting on the Attendance tab, currently "${GEOFENCE_LABELS[behaviour.value].toLowerCase()}", measured after the accuracy the phone reports is subtracted from the distance.`;

  return (
    <Alert>
      <MapPinAreaIcon />
      <AlertTitle>
        Geofencing is on for {location.name}: {String(location.geofenceRadiusM)} m around{' '}
        {location.geofenceLat === null ? '' : formatCoordinate(location.geofenceLat)},{' '}
        {location.geofenceLng === null ? '' : formatCoordinate(location.geofenceLng)}
      </AlertTitle>
      <AlertDescription>
        {outside} A punch with no location at all is accepted with a typed reason and flagged, and
        field staff are exempt.
      </AlertDescription>
    </Alert>
  );
}

/** REQ-D-09, stated and not editable here — see the panel's own comment. */
function AllowlistNote({ location }: { location: LocationSummary }) {
  const count = location.ipAllowlist.length;

  return (
    <SettingsRow
      layout="end"
      label="Office IP allowlist"
      description={`${
        count === 0
          ? `No addresses are listed for ${location.name}, so a punch from a browser is not restricted by network — it is accepted and flagged to say the check was off. Geofencing above is the control that decides where a punch may come from.`
          : `${String(count)} address${count === 1 ? '' : 'es'} listed, so a punch from a browser at ${location.name} is accepted only from ${count === 1 ? 'it' : 'them'}.`
      } It is set per location under Organisation → Locations, not here.`}
    >
      <span className="text-xs font-medium">{count === 0 ? 'Not enforced' : 'Enforced'}</span>
    </SettingsRow>
  );
}

/**
 * Reading the list takes `employee.view` while writing takes `settings.manage`
 * (OPEN-QUESTIONS P1-1), so an administrator without the read key reaches this
 * page and cannot load it. That is worth its own sentence: the shared error
 * alert would say the reader is out of scope, which is a different problem.
 */
function LoadFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const forbidden =
    error instanceof ApiError && (error.code === 'FORBIDDEN' || error.code === 'OUT_OF_SCOPE');

  if (!forbidden) return <QueryErrorAlert error={error} subject="locations" onRetry={onRetry} />;

  return (
    <Alert variant="destructive">
      <LockKeyIcon />
      <AlertTitle>The list of locations could not be read</AlertTitle>
      <AlertDescription>
        Reading locations needs the employee.view permission, which this account does not have —
        changing one needs settings.manage, which it does. Ask an administrator to add employee.view
        to your role, or set the geofence from Organisation → Locations.
      </AlertDescription>
    </Alert>
  );
}

function SaveFailure({ error }: { error: unknown }) {
  const api = error instanceof ApiError ? error : null;

  return (
    <Alert variant="destructive">
      <WarningCircleIcon />
      <AlertTitle>
        {api !== null && (api.code === 'NETWORK_ERROR' || api.status === 404)
          ? 'Not saved: the server could not be reached'
          : 'The office location was not saved'}
      </AlertTitle>
      <AlertDescription>
        {api !== null && api.code === 'VALIDATION_FAILED'
          ? api.message
          : 'Your edits are still here. The centre on the server is unchanged.'}
        {api?.requestId ? (
          <span className="mt-1 block font-mono text-[0.6875rem]">Request {api.requestId}</span>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
