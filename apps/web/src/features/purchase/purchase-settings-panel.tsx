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
import type { PurchaseSettings } from '@vyuha/shared';

import { usePurchaseSettings, useSavePurchaseSettings } from './use-purchase';

/**
 * The two purchasing thresholds (REQ-X-16, REQ-AA-15), on the Settings
 * screen's Purchase page (owner, 22 Aug 2026: every module's settings in
 * one place). Its own endpoint and its own Save, because the line belongs
 * to the purchase approver, who may not hold settings.manage.
 */

const AMOUNT = /^\d{1,12}(\.\d{1,2})?$/u;

export function PurchaseSettingsPanel() {
  const settings = usePurchaseSettings();
  const save = useSavePurchaseSettings();
  return (
    <SettingsSection title="Purchase" note="Where approval starts, and how long packed goods may wait for an invoice.">
      {settings.isPending ? <SettingsPanelSkeleton label="Loading purchase settings" rows={2} /> : null}
      {settings.isError ? (
        <QueryErrorAlert
          error={settings.error}
          subject="purchase settings"
          onRetry={() => {
            void settings.refetch();
          }}
        />
      ) : null}
      {settings.isSuccess ? <PurchaseSettingsForm key={JSON.stringify(settings.data)} saved={settings.data} save={save} /> : null}
    </SettingsSection>
  );
}

function PurchaseSettingsForm({ saved, save }: { saved: PurchaseSettings; save: ReturnType<typeof useSavePurchaseSettings> }) {
  const [threshold, setThreshold] = useState(saved.approvalThreshold ?? '');
  const [hours, setHours] = useState(String(saved.invoiceWaitingHours));

  const thresholdOk = threshold.trim() === '' || AMOUNT.test(threshold.trim());
  const hoursOk = /^\d{1,3}$/u.test(hours.trim()) && Number(hours) <= 720;
  const next: PurchaseSettings = { approvalThreshold: threshold.trim() === '' ? null : threshold.trim(), invoiceWaitingHours: hoursOk ? Number(hours.trim()) : saved.invoiceWaitingHours };
  const dirty = next.approvalThreshold !== saved.approvalThreshold || next.invoiceWaitingHours !== saved.invoiceWaitingHours;
  const canSubmit = dirty && thresholdOk && hoursOk && !save.isPending;

  function submit() {
    if (!canSubmit) return;
    save.mutate(next, {
      onSuccess: (result) => {
        toast.add({
          type: 'success',
          title: 'Purchase settings saved',
          description: result.approvalThreshold === null ? 'No PO needs approval by value.' : `POs at or above ${result.approvalThreshold} wait for approval.`,
        });
      },
    });
  }

  const copy = actionErrorCopy(save.error, 'Saving purchase settings');

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
                    setThreshold(saved.approvalThreshold ?? '');
                    setHours(String(saved.invoiceWaitingHours));
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
            label="Approval threshold"
            htmlFor="purchase-threshold"
            description="POs at or above this amount wait for approval in the inbox; leave empty for none."
            invalid={!thresholdOk}
          >
            <Input
              id="purchase-threshold"
              inputMode="decimal"
              className="tabular-nums"
              placeholder="None"
              aria-invalid={thresholdOk ? undefined : true}
              value={threshold}
              onChange={(event) => {
                setThreshold(event.target.value);
              }}
            />
          </SettingsRow>
          <SettingsRow
            label="Invoice waiting hours"
            htmlFor="purchase-invoice-hours"
            description="Hours packed goods may wait for an invoice before accounts is told; 0 disables."
            invalid={!hoursOk}
          >
            <Input
              id="purchase-invoice-hours"
              inputMode="numeric"
              className="tabular-nums"
              aria-invalid={hoursOk ? undefined : true}
              value={hours}
              onChange={(event) => {
                setHours(event.target.value);
              }}
            />
          </SettingsRow>
        </SettingsPanel>
      </Form>
    </>
  );
}
