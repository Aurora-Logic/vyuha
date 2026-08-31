/**
 * A reader for the Mailpit instance the development stack runs (docs
 * OPEN-QUESTIONS P0-3, SMTP on 51025 with its API on 58025).
 *
 * This exists so a mail test can assert against the *server's* view of what
 * arrived rather than against the sender's belief that it sent something.
 * Asserting on a resolved promise from `sendMail` proves the socket was
 * written to; asserting that Mailpit holds a message with the right subject,
 * recipient, and body proves it was delivered.
 */

const MAILPIT_API = 'http://localhost:58025/api/v1';

interface MailpitSummary {
  readonly ID: string;
  readonly Subject: string;
  readonly To: readonly { readonly Address: string }[];
  readonly From: { readonly Address: string } | null;
}

interface MailpitListing {
  readonly messages: readonly MailpitSummary[];
}

export interface CapturedMessage {
  readonly id: string;
  readonly subject: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly text: string;
}

interface MailpitMessage {
  readonly ID: string;
  readonly Subject: string;
  readonly Text: string;
  readonly To: readonly { readonly Address: string }[];
  readonly From: { readonly Address: string } | null;
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${MAILPIT_API}${path}`, init);
  if (!response.ok) {
    throw new Error(`Mailpit ${path} answered ${String(response.status)}.`);
  }
  return (await response.json()) as T;
}

/**
 * Polls until a message with this subject arrives. SMTP acceptance and the
 * message becoming visible in the API are two different moments, so reading
 * once immediately after `send` resolves is a race.
 */
export async function waitForMessage(
  subject: string,
  timeoutMs = 15_000,
): Promise<CapturedMessage | null> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    // Mailpit returns newest first, and it keeps history across runs, so the
    // page has to be deep enough that a busy mailbox does not push a message
    // sent seconds ago off the end.
    const listing = await readJson<MailpitListing>('/messages?limit=200');
    const found = listing.messages.find((message) => message.Subject === subject);

    if (found !== undefined) {
      const full = await readJson<MailpitMessage>(`/message/${found.ID}`);
      return {
        id: full.ID,
        subject: full.Subject,
        from: full.From?.Address ?? '',
        to: full.To.map((recipient) => recipient.Address),
        text: full.Text,
      };
    }

    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
