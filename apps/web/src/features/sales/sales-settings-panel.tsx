import { useState } from 'react';
import { WarningCircleIcon } from '@phosphor-icons/react';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { Form } from '@/components/shared/form';
import { SettingsPanel, SettingsPanelSkeleton, SettingsRow, SettingsSection } from '@/components/shared/settings-panel';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import type { SalesSettings } from '@vyuha/shared';

import { useSalesSettings, useSaveSalesSettings } from './use-estimates';

/**
 * The discount threshold (REQ-W-08), on the Settings screen's Sales page
 * (owner, 22 Aug 2026: every module's settings in one place). Its own
 * endpoint and its own Save, because the line belongs to whoever holds
 * sales.discount.approve, who may not hold settings.manage at all.
 */

const PERCENT = /^\d{1,3}(\.\d{1,2})?$/u;

export function SalesSettingsPanel() {
  const settings = useSalesSettings();
  const save = useSaveSalesSettings();
  return (
    <SettingsSection title="Sales" note="Where a discount stops being the salesperson’s call.">
      {settings.isPending ? <SettingsPanelSkeleton label="Loading sales settings" rows={1} /> : null}
      {settings.isError ? (
        <QueryErrorAlert
          error={settings.error}
          subject="sales settings"
          onRetry={() => {
            void settings.refetch();
          }}
        />
      ) : null}
      {settings.isSuccess ? <SalesSettingsForm key={JSON.stringify(settings.data)} saved={settings.data} save={save} /> : null}
    </SettingsSection>
  );
}

function pctOf(saved: SalesSettings): string {
  return saved.discountApprovalPct === null ? '' : String(saved.discountApprovalPct);
}

function SalesSettingsForm({ saved, save }: { saved: SalesSettings; save: ReturnType<typeof useSaveSalesSettings> }) {
  const [pct, setPct] = useState(() => pctOf(saved));
  const trimmed = pct.trim();
  const pctOk = trimmed === '' || (PERCENT.test(trimmed) && Number(trimmed) <= 100);
  const next: SalesSettings = { discountApprovalPct: trimmed === '' ? null : Number(trimmed) };
  const dirty = next.discountApprovalPct !== saved.discountApprovalPct;
  const canSubmit = dirty && pctOk && !save.isPending;

  function submit() {
    if (!canSubmit) return;
    save.mutate(next, {
      onSuccess: (result) => {
        toast.add({
          type: 'success',
          title: 'Sales settings saved',
          description: result.discountApprovalPct === null ? 'No discount needs approval.' : `Discounts above ${String(result.discountApprovalPct)}% wait for a Sales manager.`,
        });
      },
    });
  }

  const copy = actionErrorCopy(save.error, 'Saving sales settings');

  return (
    <>
      {save.isError ? (
        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>{copy.title}</AlertTitle>
          <AlertDescription>{copy.description}</AlertDescription>
        </Alert>
      ) : null}
      <Form onSubmit={submit}>
        <SettingsPanel
          status={dirty ? 'Unsaved changes' : 'Saved'}
          footer={
            <>
              {dirty ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={save.isPending}
                  onClick={() => {
                    setPct(pctOf(saved));
                    save.reset();
                  }}
                >
                  Cancel
                </Button>
              ) : null}
              <Button type="submit" size="sm" disabled={!canSubmit}>
                {save.isPending ? <Spinner data-icon="inline-start" /> : <ACTION_ICONS.save data-icon="inline-start" />}
                {save.isPending ? 'Saving' : 'Save changes'}
              </Button>
            </>
          }
        >
          <SettingsRow
            label="Discount approval threshold (%)"
            htmlFor="sales-discount-pct"
            description="An order with a line discounted above this waits in the Approvals inbox for sales.discount.approve; leave empty for none."
            invalid={!pctOk}
          >
            <Input
              id="sales-discount-pct"
              inputMode="decimal"
              className="tabular-nums"
              placeholder="None"
              aria-invalid={pctOk ? undefined : true}
              value={pct}
              onChange={(event) => {
                setPct(event.target.value);
              }}
            />
          </SettingsRow>
        </SettingsPanel>
      </Form>
    </>
  );
}
