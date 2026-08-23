import type { ApiErrorBody, ErrorCode } from '@vyuha/shared';

/**
 * The one way this app talks to the API.
 *
 * Two decisions worth stating, because both are security choices rather than
 * style:
 *
 * The access token is held in a module variable, never in localStorage. A
 * token in localStorage is readable by any script that gets injected into the
 * page, and it survives the tab; one in memory dies with the tab and is
 * invisible to injected script that cannot already read this closure. The
 * refresh token is an httpOnly cookie the browser sends automatically, which
 * is why `credentials: 'include'` is on every request and why the client never
 * touches it.
 *
 * On a 401 the client refreshes exactly once and retries. Once, because the
 * server rotates refresh tokens and treats a replayed one as theft
 * (REQ-B-05) - a client that retried in a loop would revoke the user's own
 * session family and log them out for no reason.
 */

const BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000/api/v1';

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** An error the API described in its own envelope, with the code preserved. */
export class ApiError extends Error {
  readonly code: ErrorCode | 'NETWORK_ERROR';
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly requestId: string | undefined;

  constructor(input: {
    code: ErrorCode | 'NETWORK_ERROR';
    message: string;
    status: number;
    details?: Record<string, unknown>;
    requestId?: string;
  }) {
    super(input.message);
    this.name = 'ApiError';
    this.code = input.code;
    this.status = input.status;
    this.details = input.details;
    this.requestId = input.requestId;
  }
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const { error } = value;
  return typeof error === 'object' && error !== null && 'code' in error && 'message' in error;
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A response that is not JSON is still a failure; it just cannot explain
    // itself. Reporting the status beats reporting a parse error.
    body = undefined;
  }

  if (isErrorBody(body)) {
    return new ApiError({
      code: body.error.code,
      message: body.error.message,
      status: response.status,
      ...(body.error.details === undefined ? {} : { details: body.error.details }),
      ...(body.error.requestId === undefined ? {} : { requestId: body.error.requestId }),
    });
  }

  return new ApiError({
    code: 'INTERNAL_ERROR',
    message: `The server returned ${String(response.status)}.`,
    status: response.status,
  });
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /**
   * Suppresses the refresh-and-retry. Set on the refresh call itself so it
   * cannot recurse, and on public auth endpoints - login, and any future
   * password-reset or invitation-accept call - where a 401 is the endpoint's
   * verdict rather than an expired token, and a retry would replay the very
   * request being refused.
   */
  skipRefresh?: boolean;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  return fetch(`${BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'include',
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * 'unauthenticated' is the server's answer; 'network-error' is no answer at
 * all. The two must stay distinct: treating an unreachable server as "signed
 * out" is how an offline reload ends up hiding a queued punch behind a login
 * form (REQ-D-10).
 */
export type RefreshOutcome = 'refreshed' | 'unauthenticated' | 'network-error';

async function performRefresh(): Promise<RefreshOutcome> {
  let response: Response;
  try {
    response = await send('/auth/refresh', { method: 'POST', skipRefresh: true });
  } catch {
    // The server never answered, so nothing is known about the session and
    // nothing is torn down.
    return 'network-error';
  }
  if (!response.ok) {
    setAccessToken(null);
    return 'unauthenticated';
  }
  const body = (await response.json()) as { accessToken?: unknown };
  if (typeof body.accessToken !== 'string') return 'unauthenticated';
  setAccessToken(body.accessToken);
  return 'refreshed';
}

/**
 * The one refresh this document has in the air, shared by everyone who wants
 * one.
 *
 * The refresh cookie is single-use and rotating, and the server treats a
 * replay as theft (REQ-B-05). Two refreshes started before either has landed
 * therefore present the *same* cookie, and the second is read as a stolen
 * token: the whole session family is revoked and the person is signed out.
 * Nothing on the server is wrong when that happens - the client has forged its
 * own theft signal.
 *
 * The window is easy to hit and does not need a slow network. On a document
 * loaded from the service worker there is no access token in memory at all, so
 * the moment the connection returns, `useMe` refetches and the punch queue
 * drains, and both discover they need a token within the same few
 * milliseconds. Measured before this guard: refresh 200 at +11ms, sync 401 at
 * +16ms, refresh 401 at +24ms, family revoked, the queued punch stranded.
 */
let refreshInFlight: Promise<RefreshOutcome> | null = null;

/**
 * The same guard, across documents.
 *
 * The cookie is shared by every tab of this origin, but the promise above is a
 * module variable and a module is per document - so the guard stopped one tab
 * racing itself and did nothing at all about two tabs racing each other. That
 * is not a rare case: Chrome's "continue where you left off" restores every
 * tab at once, and each restored document holds no access token, so each one
 * reaches for the cookie within the same few milliseconds. Measured against
 * the running API before this: eleven cold-load pairs produced four
 * `session.reuse_detected` rows, and each of those revoked every live session
 * and put both tabs on the sign-in form.
 *
 * A Web Lock decides which document performs the exchange; a BroadcastChannel
 * carries its answer back to the ones that did not. One exchange, one
 * rotation, and everybody signed in - rather than one rotation per document
 * and a coin toss over whether the server reads the second as theft.
 *
 * Deliberately client-side only. Softening the server's reuse detection with a
 * rotation-tolerance window would trade a security control for a symptom and
 * is the owner's open decision (OPEN-QUESTIONS P1-6); a genuine replayed token
 * must still revoke the family, and it still does - nothing here touches the
 * server.
 *
 * The access token travels over the channel. That is not a new exposure: a
 * BroadcastChannel is same-origin, and any script that could read a message on
 * it could equally send its own `/auth/refresh` with the httpOnly cookie and
 * read the token out of the reply. It is still never written to storage.
 */
const REFRESH_LOCK = 'vyuha.auth.refresh';
const REFRESH_CHANNEL = 'vyuha.auth';

/**
 * How long a document that lost the lock waits for the winner's answer before
 * giving up on it.
 *
 * Generous, because the cost of being wrong is asymmetric: waiting too long
 * costs a slow sign-in, giving up too early costs a second exchange and the
 * race this exists to remove. A tab that is closed mid-refresh releases the
 * lock immediately, so the common failure does not wait this out.
 */
const ANNOUNCEMENT_TIMEOUT_MS = 5000;

type Announcement =
  | { readonly type: 'refreshed'; readonly accessToken: string }
  | { readonly type: 'signed-out' }
  | { readonly type: 'no-answer' };

const OUTCOME_BY_ANNOUNCEMENT: Record<Announcement['type'], RefreshOutcome> = {
  refreshed: 'refreshed',
  'signed-out': 'unauthenticated',
  'no-answer': 'network-error',
};

let channel: BroadcastChannel | null = null;
let lastAnnouncement: { outcome: RefreshOutcome; at: number } | null = null;
const announcementWaiters = new Set<(outcome: RefreshOutcome) => void>();

/** Narrowed by hand: this arrives from another document and is untrusted. */
function toAnnouncement(data: unknown): Announcement | null {
  if (typeof data !== 'object' || data === null || !('type' in data)) return null;
  const { type } = data;
  if (type === 'signed-out' || type === 'no-answer') return { type };
  if (type === 'refreshed' && 'accessToken' in data) {
    const token: unknown = data.accessToken;
    if (typeof token === 'string' && token.length > 0) return { type, accessToken: token };
  }
  return null;
}

function receive(announcement: Announcement): void {
  if (announcement.type === 'refreshed') accessToken = announcement.accessToken;
  if (announcement.type === 'signed-out') accessToken = null;
  const outcome = OUTCOME_BY_ANNOUNCEMENT[announcement.type];
  lastAnnouncement = { outcome, at: Date.now() };
  for (const waiter of [...announcementWaiters]) waiter(outcome);
}

/**
 * Opened once, lazily. Not at module load: this file is imported by tests and
 * by tooling that has no `BroadcastChannel`, and an eager constructor would
 * make importing the client a runtime error there rather than here.
 */
function openChannel(): BroadcastChannel | null {
  if (channel !== null) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  channel = new BroadcastChannel(REFRESH_CHANNEL);
  channel.addEventListener('message', (event: MessageEvent<unknown>) => {
    const announcement = toAnnouncement(event.data);
    if (announcement !== null) receive(announcement);
  });
  return channel;
}

function waitForAnnouncement(since: number): Promise<RefreshOutcome | null> {
  // An answer that landed while we were losing the lock is still our answer.
  if (lastAnnouncement !== null && lastAnnouncement.at >= since) {
    return Promise.resolve(lastAnnouncement.outcome);
  }
  return new Promise((resolve) => {
    const waiter = (outcome: RefreshOutcome): void => {
      clearTimeout(timer);
      announcementWaiters.delete(waiter);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      announcementWaiters.delete(waiter);
      resolve(null);
    }, ANNOUNCEMENT_TIMEOUT_MS);
    announcementWaiters.add(waiter);
  });
}

function announce(outcome: RefreshOutcome, broadcast: BroadcastChannel): void {
  if (outcome === 'refreshed' && accessToken !== null) {
    broadcast.postMessage({ type: 'refreshed', accessToken } satisfies Announcement);
    return;
  }
  broadcast.postMessage({
    type: outcome === 'unauthenticated' ? 'signed-out' : 'no-answer',
  } satisfies Announcement);
}

/**
 * Performs the exchange in whichever document got there first, and hands the
 * answer to the rest.
 *
 * `ifAvailable` rather than a plain wait, because the two are different
 * questions. A plain wait would serialise the documents - safe, but each would
 * then perform an exchange of its own with the cookie the previous one just
 * rotated, which is N rotations for N tabs and N chances for the next race.
 * Asking whether the lock is free answers "am I the one doing this?", and a
 * document that is not simply listens.
 *
 * The fallback path matters: a browser with no Web Locks or no
 * BroadcastChannel keeps exactly the behaviour that existed before this, which
 * is the per-document guard above. It is also the path the jsdom unit tests
 * take.
 */
async function coordinatedRefresh(): Promise<RefreshOutcome> {
  const broadcast = openChannel();
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (broadcast === null || locks === undefined) return performRefresh();

  const startedAt = Date.now();

  const mine = await locks.request(REFRESH_LOCK, { ifAvailable: true }, async (lock) => {
    if (lock === null) return null;
    const outcome = await performRefresh();
    announce(outcome, broadcast);
    return outcome;
  });
  if (mine !== null) return mine;

  const announced = await waitForAnnouncement(startedAt);
  if (announced !== null) return announced;

  // The holder never answered - a tab closed mid-flight, or a message that
  // never arrived. Take the lock properly and do it here. Safe rather than a
  // replay: whatever the holder did, it is finished, so the cookie in the jar
  // is the current one.
  return locks.request(REFRESH_LOCK, async () => {
    const outcome = await performRefresh();
    announce(outcome, broadcast);
    return outcome;
  });
}

/**
 * Exchanges the refresh cookie for a new access token, once.
 *
 * Concurrent callers all receive the outcome of the single request that is
 * already in flight rather than starting one of their own. The slot is cleared
 * as that request settles, so a later 401 - a token that has since expired, or
 * a cookie the server has rotated in the meantime - still gets a fresh
 * exchange rather than a cached verdict.
 *
 * Two layers, and both are needed. This one collapses the callers inside one
 * document into a single attempt; `coordinatedRefresh` collapses the documents
 * into a single exchange.
 */
export function refreshAccessToken(): Promise<RefreshOutcome> {
  refreshInFlight ??= coordinatedRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Makes sure there is something to authenticate with before a request goes out.
 *
 * A cold document holds no access token - it deliberately does not survive the
 * tab - so a request sent before the refresh cookie has been exchanged cannot
 * succeed. Sending it anyway costs a guaranteed 401, and, worse, moves the
 * refresh to a moment nobody controls: the 401 comes back after some other
 * refresh has already rotated the cookie, and the retry is what races. Asking
 * first funnels every caller into the one in-flight exchange above.
 *
 * `useMe` has always done this; the two senders now do it too, for the same
 * reason and through the same promise.
 */
export async function ensureAccessToken(): Promise<boolean> {
  if (accessToken !== null) return true;
  return (await refreshAccessToken()) === 'refreshed';
}

/**
 * 15 REQ-AL-01: a request from a reader who has no account.
 *
 * The customer portal's key is in the path, and the reader has no session,
 * no refresh cookie and nothing to exchange. Going through `apiRequest`
 * would make every portal view attempt a refresh first, fail it, and then
 * retry the whole request on the 401 the server correctly returned —
 * three round trips on a phone for one page. `skipRefresh` says the plain
 * truth: there is no token here and a 401 is the answer, not a hint.
 */
export function publicApiRequest<T>(path: string, options: Omit<RequestOptions, 'skipRefresh'> = {}): Promise<T> {
  return apiRequest<T>(path, { ...options, skipRefresh: true });
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  // Every path through this function except the public auth endpoints needs a
  // bearer token, so a cold document exchanges the cookie before it asks
  // rather than after it has been refused.
  const refreshedBeforeSending =
    !options.skipRefresh && accessToken === null ? await ensureAccessToken() : false;

  let response: Response;
  try {
    response = await send(path, options);
  } catch (cause) {
    // fetch only rejects when the request never completed, so this is a dead
    // server or a dropped connection - not an API error, and worth saying so
    // rather than reporting a misleading status.
    throw new ApiError({
      code: 'NETWORK_ERROR',
      message: 'Could not reach the server.',
      status: 0,
      ...(cause instanceof Error ? { details: { cause: cause.message } } : {}),
    });
  }

  // Not after a refresh this call already made: the token is seconds old, so a
  // 401 is the server's verdict on the request rather than an expired token,
  // and exchanging the cookie again would only rotate it for nothing.
  if (response.status === 401 && !options.skipRefresh && !refreshedBeforeSending) {
    if ((await refreshAccessToken()) === 'refreshed') {
      return apiRequest<T>(path, { ...options, skipRefresh: true });
    }
  }

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;

  return (await response.json()) as T;
}
