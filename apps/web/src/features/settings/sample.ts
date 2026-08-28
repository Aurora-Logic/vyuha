import type { OrgSettings } from './types';

/**
 * The settings payload a development build shows when `GET /settings` is not
 * deployed yet.
 *
 * Loaded through a dynamic import that sits inside `if (import.meta.env.DEV)`,
 * so Vite folds the branch away and rollup drops this chunk from a production
 * build. Every screen that can receive it renders the sample-data notice.
 *
 * The values are the real defaults from the PRD rather than invented ones. A
 * sample that disagreed with the shipped default would teach the reader the
 * wrong number, which is the one thing worse than showing no number.
 */
const KB = 1024;

export function sampleSettings(): OrgSettings {
  return {
    organisation: {
      id: '00000000-0000-0000-0000-000000000000',
      name: 'Sample Organisation',
      legalName: null,
      timezone: 'Asia/Kolkata',
      dateFormat: 'dd-MM-yyyy',
      weekStart: 1,
      leaveYearStartMonth: 4,
      logoKey: null,
    },
    attendance: {
      geofenceBehaviour: 'BLOCK',
      deviceBindingMode: 'WARN',
      maxWorkMinutes: 16 * 60,
      regularizationWindowDays: 7,
      regularizationMaxPerMonth: 3,
      regularizationAutoFile: false,
      earlyArrivalEnabled: true,
      earlyArrivalThresholdMinutes: 15,
      autoEscalationDays: 3,
    },
    photo: { retentionMonths: 12, minBytes: 80 * KB, maxBytes: 150 * KB },
    security: { mfaPolicy: 'admin_accounts', sessionHours: 720, endSessionOnClose: false },
    locale: { numberFormat: 'indian', currencySymbol: '₹' },
    retention: { exportsDays: 7 },
  duplicates: { confidenceMin: 0.75 },
  returns: { reasons: ['Damaged in transit', 'Wrong item', 'Wrong quantity', 'Quality rejection', 'Customer cancelled', 'Warranty'] },
  interest: {
    annualRatePct: 12,
    dayBasis: 365,
    rateSource: 'FIXED',
    receivableBase: 'VOUCHER',
    stockClockStart: 'AFTER_CREDIT_DAYS',
    includeGstInStock: false,
    recomputeWindowDays: 90,
    nonMovingDays: 90,
  },
    appearance: { accentHue: 277, accentChroma: 0.24, font: 'sans', base: 'stone', density: 'comfortable' },
    email: {
      transport: 'log',
      host: 'localhost',
      port: 1025,
      secure: false,
      from: 'no-reply@example.invalid',
      credentialsConfigured: false,
    },
    enforcement: {
      attendance: {
        geofenceBehaviour: null,
        deviceBindingMode: 'Punch',
        maxWorkMinutes: 'Day engine',
        regularizationWindowDays: null,
        regularizationMaxPerMonth: null,
        regularizationAutoFile: 'Regularization',
        earlyArrivalEnabled: 'Day engine',
        earlyArrivalThresholdMinutes: 'Day engine',
        autoEscalationDays: null,
      },
      photo: {
        retentionMonths: null,
        minBytes: 'Punch photo pipeline',
        maxBytes: 'Punch photo pipeline',
      },
      security: { mfaPolicy: 'Sign-in', sessionHours: 'Sign-in', endSessionOnClose: 'Sign-in' },
      locale: { numberFormat: 'Every figure', currencySymbol: 'Every figure' },
      retention: { exportsDays: 'Exports' },
    duplicates: { confidenceMin: null },
    returns: { reasons: 'Return receipt' },
    interest: {
      annualRatePct: 'Interest reports',
      dayBasis: 'Interest reports',
      rateSource: null,
      receivableBase: 'Interest snapshots',
      stockClockStart: 'Interest snapshots',
      includeGstInStock: 'Interest snapshots',
      recomputeWindowDays: 'Interest snapshots',
      nonMovingDays: 'Interest reports',
    },
      appearance: { accentHue: 'Shell', accentChroma: 'Shell', base: 'Shell', density: 'Shell' },
    },
    unreadableKeys: [],
  };
}
