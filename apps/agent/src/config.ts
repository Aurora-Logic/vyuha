import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

/**
 * The connector agent's configuration (REQ-Q-01, REQ-Q-07).
 *
 * A single JSON file beside the binary, not environment variables: the agent
 * is copied onto a Windows machine by a person who will never open a shell,
 * and "edit vyuha-agent.json, paste the token" is an instruction that
 * survives being given over the phone.
 */

/** Plain http reaches only the machine itself; the token goes over the wire otherwise (H-11). */
function httpsOrLoopback(url: string): boolean {
  const { protocol, hostname } = new URL(url);
  return protocol === 'https:' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

export const configSchema = z.object({
  /** The Vyuha API origin, e.g. https://vyuha.example.com — outbound only. */
  serverUrl: z.string().url().refine(httpsOrLoopback, 'serverUrl must be https:// -- http:// is allowed only for localhost'),
  /**
   * The fixture file this build reads in place of Tally (10 §8, D-05). No
   * default: a binary that quietly read demo data when this was missing was
   * a deployed agent simulating Tally (C-02).
   */
  fixture: z.string().min(1).optional(),
  /** The per-connection credential, pasted from the once-only dialog. */
  agentToken: z.string().startsWith('vyagt_'),
  /** Tally's XML port on this machine. The default is Tally's default. */
  tallyUrl: z.string().url().default('http://localhost:9000'),
  /** Seconds between heartbeats. The server's staleness threshold is 5 minutes. */
  heartbeatSeconds: z.number().int().min(15).max(120).default(60),
});

export type AgentConfig = z.infer<typeof configSchema> & {
  /** Stable per install, minted on first run; the lease is held under it. */
  readonly instanceId: string;
};

/**
 * The instance id lives in its own file so editing the config never changes
 * the agent's identity. Identity must survive a restart (REQ-Q-07): a fresh
 * id on every boot would look like a rival instance and fight its own lease.
 */
function loadOrMintInstanceId(path: string): string {
  if (existsSync(path)) {
    const stored = readFileSync(path, 'utf8').trim();
    if (/^agent-[a-f0-9]{16}$/u.test(stored)) return stored;
  }
  const minted = `agent-${randomBytes(8).toString('hex')}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${minted}\n`, 'utf8');
  return minted;
}

export function loadConfig(configPath: string): AgentConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    throw new Error(
      `No configuration at ${configPath}. Create it with: ` +
        `{"serverUrl": "https://…", "agentToken": "vyagt_…"}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(
      `${configPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`${configPath} is invalid: ${details}`);
  }

  const instanceId = loadOrMintInstanceId(join(dirname(configPath), 'vyuha-agent-id'));
  return { ...result.data, instanceId };
}
