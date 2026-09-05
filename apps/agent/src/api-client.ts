import {
  agentClaimResponseSchema,
  agentErrorAckSchema,
  agentHeartbeatAckSchema,
  agentResultsAckSchema,
  type AgentClaimResponse,
  type AgentErrorAck,
  type AgentErrorInput,
  type AgentHeartbeatAck,
  type AgentHeartbeatInput,
  type AgentResultsAck,
  type AgentResultsInput,
} from '@vyuha/shared';
import type { z } from 'zod';

/**
 * How long one call to the server may take. Generous, because a results
 * post can carry a chunk of rows; bounded, because a request with no limit
 * hung the tick, and the tick is what SIGTERM waits for (H-11).
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The four `/sync/agent/*` calls, typed by the shared contract (09 §5).
 *
 * Plain fetch, no retry layer: retry policy belongs to the loop, which knows
 * whether a call is idempotent (results are, by the writer's construction)
 * and what giving up means for the job it is holding.
 */

export class AgentApiError extends Error {
  constructor(
    readonly status: number,
    readonly serverMessage: string,
    call: string,
  ) {
    super(`${call} answered ${String(status)}: ${serverMessage}`);
    this.name = 'AgentApiError';
  }
}

export class AgentApiClient {
  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {}

  heartbeat(input: AgentHeartbeatInput): Promise<AgentHeartbeatAck> {
    return this.post('/sync/agent/heartbeat', input, agentHeartbeatAckSchema);
  }

  claim(input: { agentInstanceId: string; openCompanyGuid?: string }): Promise<AgentClaimResponse> {
    return this.post('/sync/agent/jobs/claim', input, agentClaimResponseSchema);
  }

  results(input: AgentResultsInput): Promise<AgentResultsAck> {
    return this.post('/sync/agent/results', input, agentResultsAckSchema);
  }

  reportError(input: AgentErrorInput): Promise<AgentErrorAck> {
    return this.post('/sync/agent/errors', input, agentErrorAckSchema);
  }

  private async post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}/api/v1${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`${path} did not answer within ${String(this.timeoutMs)}ms.`, { cause: error });
      }
      throw error;
    }

    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } };
        message = parsed.error?.message ?? text;
      } catch {
        // The body was not the API's envelope; the raw text is the message.
      }
      throw new AgentApiError(response.status, message, path);
    }
    // Parsed against the contract, not cast to it: a proxy's error page or
    // a server mid-deploy answers 200 with something else, and the loop
    // must not act on it.
    const parsed = schema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(`${path} answered 200 with a body that does not match the contract: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    }
    return parsed.data;
  }
}
