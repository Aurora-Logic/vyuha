import { ERROR_CODES } from '@vyuha/shared';
import { z } from 'zod';

import { ApiError, ensureAccessToken, getAccessToken, refreshAccessToken } from '@/lib/api/client';

/**
 * `POST` of a `multipart/form-data` body.
 *
 * `apiRequest` speaks JSON only — it would `JSON.stringify` a FormData into
 * `{}` — so the multipart endpoints in this app (`POST /punches`,
 * `POST /punches/sync` and `POST /settings/logo`) need their own sender. Everything else about the call
 * is identical to `apiRequest`: the same bearer token, the same
 * `credentials: 'include'` for the refresh cookie, the same one-shot refresh on
 * a 401, and the same `ApiError` shape, so callers do not have to know there
 * are two senders.
 *
 * The 401 retry matters more here than anywhere else in the app. An access
 * token lives fifteen minutes; a queue that has been waiting offline for an
 * hour will always meet an expired one on its first drain, and without this the
 * drain would report "not signed in" and the punches would sit there for ever.
 */

const errorEnvelopeSchema = z.object({
  error: z.object({
    // Checked against the shared enum rather than accepted as any string: the
    // point of the envelope is that the client maps codes to behaviour, and an
    // unrecognised code should fall through to the generic message rather than
    // be cast into the union and quietly miss every branch.
    code: z.enum(ERROR_CODES),
    message: z.string(),
    requestId: z.string().optional(),
  }),
});

const BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000/api/v1';

async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A response that is not JSON is still a failure; it just cannot explain
    // itself. Reporting the status beats reporting a parse error.
    body = undefined;
  }

  const parsed = errorEnvelopeSchema.safeParse(body);
  if (parsed.success) {
    return new ApiError({
      code: parsed.data.error.code,
      message: parsed.data.error.message,
      status: response.status,
      ...(parsed.data.error.requestId === undefined
        ? {}
        : { requestId: parsed.data.error.requestId }),
    });
  }

  return new ApiError({
    code: 'INTERNAL_ERROR',
    message: `The server returned ${String(response.status)}.`,
    status: response.status,
  });
}

async function send(
  path: string,
  form: FormData,
  extraHeaders: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders };
  const token = getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  // Content-Type is left unset on purpose: fetch writes it, with the multipart
  // boundary, and setting it by hand produces a body the server cannot parse.

  try {
    return await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: form,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    if (signal?.aborted === true) throw cause;
    // fetch only rejects when the request never completed, so this is a dead
    // server or a dropped connection - not an API error. Callers depend on this
    // code to tell "nobody heard me, keep the punch" from "the server heard me
    // and said no".
    throw new ApiError({
      code: 'NETWORK_ERROR',
      message: 'Could not reach the server.',
      status: 0,
      ...(cause instanceof Error ? { details: { cause: cause.message } } : {}),
    });
  }
}

export async function postMultipart<T>(
  path: string,
  form: FormData,
  parse: (body: unknown) => T,
  extraHeaders: Readonly<Record<string, string>> = {},
  signal?: AbortSignal,
): Promise<T> {
  // A drain on a document restored by the service worker starts with no token
  // in memory, so this asks for one before sending rather than sending a
  // request that cannot succeed. It goes through `ensureAccessToken`, and so
  // through the single in-flight refresh in `client.ts`, which is what stops
  // this drain and the session refetch on the same reconnect presenting the
  // same rotating cookie twice and revoking the family (REQ-B-05).
  const refreshedBeforeSending = getAccessToken() === null ? await ensureAccessToken() : false;

  let response = await send(path, form, extraHeaders, signal);

  if (
    response.status === 401 &&
    !refreshedBeforeSending &&
    (await refreshAccessToken()) === 'refreshed'
  ) {
    // Once, not in a loop: the server rotates refresh tokens and treats a
    // replayed one as theft (REQ-B-05). The FormData is re-readable, so the
    // same body — and the same idempotency key — goes out again.
    response = await send(path, form, extraHeaders, signal);
  }

  if (!response.ok) throw await toApiError(response);

  return parse(await response.json());
}
