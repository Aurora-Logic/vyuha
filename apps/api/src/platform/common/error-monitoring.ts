import { captureException, type ErrorEvent } from '@sentry/node';

/** Keep diagnostics without exporting credentials, SQL, user data or request bodies. */
export function sanitizeMonitoringEvent(event: ErrorEvent): ErrorEvent {
  return {
    type: event.type,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    release: event.release,
    environment: event.environment,
    tags: {
      requestId: event.tags?.requestId,
      code: event.tags?.code,
      status: event.tags?.status,
    },
    exception: {
      values: event.exception?.values?.map((value) => ({
        type: 'ServerError',
        value: 'Unexpected server failure. Correlate requestId with protected application logs.',
        stacktrace: {
          frames: value.stacktrace?.frames?.map((frame) => ({
            filename: frame.filename?.split('?', 1)[0],
            function: frame.function,
            lineno: frame.lineno,
            colno: frame.colno,
            in_app: frame.in_app,
          })),
        },
      })),
    },
  };
}

export function captureUnexpectedError(exception: unknown, requestId: string, status: number, code: string): void {
  // With no configured client this SDK call is a no-op. beforeSend applies
  // the same allowlist to handled errors and SDK-captured bootstrap failures.
  captureException(exception, { tags: { requestId, status, code } });
}
