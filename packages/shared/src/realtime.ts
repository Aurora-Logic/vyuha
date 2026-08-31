import { z } from 'zod';

/**
 * The live channel: what changed, and who is looking at what.
 *
 * Two people working the same pipeline used to overwrite each other in
 * silence. One would move a deal, the other would keep the stale board on
 * screen until they happened to reload, and whoever saved last won. This
 * carries both halves of the fix -- a change notice so every open screen
 * refetches, and a presence roster so you can see a colleague is already
 * inside a record before you start editing it.
 *
 * The events say *what* changed, never the changed row itself. A payload
 * would have to be filtered per recipient against that person's scope, and
 * a mistake there leaks a record to someone whose role forbids it. A bare
 * identifier leaks nothing: the client refetches through the same endpoint
 * it always did, and the server applies the same scope it always did.
 *
 * The resource strings are a published contract in the same sense as the
 * notification catalogue -- the client keys its query invalidation off them.
 * Add resources; do not rename them.
 */

export const REALTIME_RESOURCES = {
  CRM_DEAL: 'crm.deal',
  CRM_PIPELINE: 'crm.pipeline',
  CRM_CONTACT: 'crm.contact',
  CRM_COMPANY: 'crm.company',
  CRM_ACTIVITY: 'crm.activity',
  TASK: 'task',
} as const;

export type RealtimeResource = (typeof REALTIME_RESOURCES)[keyof typeof REALTIME_RESOURCES];

export const REALTIME_RESOURCE_VALUES = Object.values(REALTIME_RESOURCES) as [
  RealtimeResource,
  ...RealtimeResource[],
];

export const realtimeResourceSchema = z.enum(REALTIME_RESOURCE_VALUES);

/** Someone with a record open. Name and initials, never an email or an id the UI would show. */
export const realtimeViewerSchema = z.object({
  userId: z.string().uuid(),
  name: z.string(),
});

export type RealtimeViewer = z.infer<typeof realtimeViewerSchema>;

/**
 * A record changed. `recordId` is null when the change is broader than one
 * row -- reordering a pipeline's stages moves every deal's column, and
 * naming a single row would leave the rest stale.
 */
export const realtimeChangeSchema = z.object({
  kind: z.literal('change'),
  resource: realtimeResourceSchema,
  action: z.enum(['created', 'updated', 'deleted']),
  recordId: z.string().uuid().nullable(),
  /** Who did it, so the client can skip its own echo and avoid a needless refetch. */
  actorUserId: z.string().uuid(),
  actorName: z.string(),
  at: z.string(),
});

export type RealtimeChange = z.infer<typeof realtimeChangeSchema>;

/**
 * The whole org's roster in one message rather than a per-record one.
 *
 * A board shows fifty deals at once, so a client that had to subscribe per
 * record would open fifty subscriptions to render one screen. The roster is
 * bounded by the number of people signed in with a record open, which is
 * tens, not thousands -- small enough that resending all of it on every
 * change is cheaper than the bookkeeping to send a delta.
 */
export const realtimePresenceSchema = z.object({
  kind: z.literal('presence'),
  records: z.array(
    z.object({
      resource: realtimeResourceSchema,
      recordId: z.string().uuid(),
      viewers: z.array(realtimeViewerSchema),
    }),
  ),
});

export type RealtimePresence = z.infer<typeof realtimePresenceSchema>;

/**
 * Sent once when a stream opens, so a client that reconnects after a dropped
 * connection knows to refetch rather than trusting a cache that may have gone
 * stale while it was away.
 */
export const realtimeReadySchema = z.object({
  kind: z.literal('ready'),
  /** Milliseconds between presence heartbeats the server expects; below its own expiry. */
  heartbeatMs: z.number().int().positive(),
});

export const realtimeEventSchema = z.discriminatedUnion('kind', [
  realtimeChangeSchema,
  realtimePresenceSchema,
  realtimeReadySchema,
]);

export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

/**
 * "I still have this open." `recordId` null means the person left the record
 * and is on no record at all -- sent on close so the roster empties at once
 * instead of waiting out the expiry.
 */
export const presenceHeartbeatSchema = z.object({
  resource: realtimeResourceSchema,
  recordId: z.string().uuid().nullable(),
});

export type PresenceHeartbeatInput = z.infer<typeof presenceHeartbeatSchema>;

/** How often a client says it is still there, and how long the server waits before forgetting it. */
export const PRESENCE_HEARTBEAT_MS = 15_000;
export const PRESENCE_EXPIRY_MS = 45_000;
