import type { DocumentProfile } from '@vyuha/shared';

/**
 * REQ-AJ-05: the reminder a customer receives, composed from the same
 * open bills the ageing report and the statement read. Pure -- bills in,
 * subject/text/html out -- so the wording is unit-tested without a
 * mailbox, exactly as the dispatch notice is.
 *
 * It states the balance as of a date and lists the bills behind it,
 * oldest first, marking the overdue ones. It never says what the customer
 * "must" pay by when unless a promise exists; a reminder that invents
 * terms is one the accounts department has to disown.
 */

export interface ReminderBill {
  readonly billName: string;
  readonly billDate: string | null;
  readonly dueDate: string | null;
  readonly outstanding: string;
  readonly overdue: boolean;
}

export interface ReminderNoticeInput {
  readonly orgName: string;
  readonly profile: DocumentProfile;
  readonly partyName: string;
  readonly contactName: string | null;
  readonly asOf: string;
  readonly bills: readonly ReminderBill[];
  /** An open promise, when the customer has given one; the reminder refers to it rather than inventing a date. */
  readonly promise: { readonly amount: string; readonly promisedDate: string } | null;
}

export interface ReminderNotice {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly outstanding: string;
}

function esc(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

function longDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

function money(value: string | number): string {
  return Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function renderReminderNotice(input: ReminderNoticeInput): ReminderNotice {
  const { orgName, profile, partyName, contactName, asOf, bills, promise } = input;
  const name = profile.legalName.trim() === '' ? orgName : profile.legalName;
  const greeting = contactName === null || contactName.trim() === '' ? partyName : (contactName.split(/\s+/u)[0] ?? partyName);
  const total = bills.reduce((sum, bill) => sum + Number(bill.outstanding), 0);
  const overdue = bills.filter((bill) => bill.overdue);
  const overdueTotal = overdue.reduce((sum, bill) => sum + Number(bill.outstanding), 0);
  const address = profile.addressLines
    .split('\n')
    .filter((line) => line.trim() !== '')
    .join(', ');

  const subject = `${name}: account statement as of ${longDate(asOf)} — ${money(total)} outstanding`;

  const opening =
    overdue.length === 0
      ? `Your account with ${name} stands at ${money(total)} as of ${longDate(asOf)}. Nothing on it is past its due date.`
      : `Your account with ${name} stands at ${money(total)} as of ${longDate(asOf)}, of which ${money(overdueTotal)} across ${String(overdue.length)} bill${overdue.length === 1 ? '' : 's'} is past its due date.`;
  const promiseLine =
    promise === null ? null : `Against this we have noted your word for ${money(promise.amount)} by ${longDate(promise.promisedDate)}.`;
  const closing = `If any of this does not agree with your books, tell us which bill and we will look at it the same day. If a payment has crossed this note, please ignore it.`;

  const lines = bills.map(
    (bill) =>
      `  ${bill.billName.padEnd(20).slice(0, 20)}  ${bill.billDate === null ? '           ' : longDate(bill.billDate).padEnd(11).slice(0, 11)}  ${money(bill.outstanding).padStart(14)}${bill.overdue ? '   overdue' : ''}`,
  );

  const text = [
    `Dear ${greeting},`,
    '',
    opening,
    ...(promiseLine === null ? [] : ['', promiseLine]),
    '',
    'Bill                  Dated                 Outstanding',
    ...lines,
    '',
    `Total${' '.repeat(37)}${money(total)}`,
    '',
    closing,
    '',
    name,
    ...(address === '' ? [] : [address]),
    ...(profile.phone.trim() === '' ? [] : [profile.phone]),
  ].join('\n');

  const rows = bills
    .map(
      (bill) =>
        `<tr><td style="padding:6px 12px 6px 0;border-bottom:1px solid #e5e5e5">${esc(bill.billName)}</td><td style="padding:6px 12px 6px 0;border-bottom:1px solid #e5e5e5;color:#666">${bill.billDate === null ? '' : esc(longDate(bill.billDate))}</td><td style="padding:6px 0;border-bottom:1px solid #e5e5e5;text-align:right;font-variant-numeric:tabular-nums${bill.overdue ? ';color:#b91c1c' : ''}">${esc(money(bill.outstanding))}${bill.overdue ? ' &middot; overdue' : ''}</td></tr>`,
    )
    .join('');

  const html = [
    `<div style="font-family:ui-sans-serif,system-ui,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;line-height:1.6;color:#111">`,
    `<p>Dear ${esc(greeting)},</p>`,
    `<p>${esc(opening)}</p>`,
    promiseLine === null ? '' : `<p>${esc(promiseLine)}</p>`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:520px;margin:16px 0">`,
    `<tr><th align="left" style="padding:0 12px 6px 0;border-bottom:2px solid #111;font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#666">Bill</th><th align="left" style="padding:0 12px 6px 0;border-bottom:2px solid #111;font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#666">Dated</th><th align="right" style="padding:0 0 6px;border-bottom:2px solid #111;font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#666">Outstanding</th></tr>`,
    rows,
    `<tr><td colspan="2" style="padding:8px 12px 0 0;font-weight:600">Total</td><td style="padding:8px 0 0;text-align:right;font-weight:600;font-variant-numeric:tabular-nums">${esc(money(total))}</td></tr>`,
    `</table>`,
    `<p>${esc(closing)}</p>`,
    `<p style="color:#666;font-size:13px">${esc(name)}${address === '' ? '' : `<br>${esc(address)}`}${profile.phone.trim() === '' ? '' : `<br>${esc(profile.phone)}`}</p>`,
    `</div>`,
  ]
    .filter((part) => part !== '')
    .join('');

  return { subject, text, html, outstanding: total.toFixed(2) };
}
