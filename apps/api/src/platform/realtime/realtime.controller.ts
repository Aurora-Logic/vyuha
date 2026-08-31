import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { PRESENCE_HEARTBEAT_MS, presenceHeartbeatSchema, type RealtimeEvent } from '@vyuha/shared';
import type { Request, Response } from 'express';

import { AuditContext } from '../audit/audit-context.js';
import { createZodDto } from '../common/zod-validation.pipe.js';
import { ActorNameService } from '../people/actor-name.service.js';
import { CurrentUser, type Principal } from '../rbac/principal.js';
import { Authenticated } from '../rbac/route-policy.js';
import { RealtimeService } from './realtime.service.js';

class PresenceHeartbeatDto extends createZodDto(presenceHeartbeatSchema) {}

/**
 * How often a comment line goes down an idle stream. Proxies and load
 * balancers close a connection that has said nothing for a minute, and a
 * closed stream is invisible to the client until it next tries to read --
 * so the quiet case is the one that has to be kept alive, not the busy one.
 */
const KEEPALIVE_MS = 25_000;

/**
 * `/api/v1/realtime/*` -- the live channel every module publishes onto.
 *
 * Server-sent events rather than a WebSocket, for three reasons. It is one
 * ordinary authenticated GET, so the access guard, the org scope and the
 * error envelope all apply unchanged instead of needing a parallel
 * implementation on a socket handshake. It needs no dependency, and the
 * constitution requires asking before adding one. And the traffic is
 * one-way: the server tells clients what changed, and the one thing a client
 * has to say back -- "I still have this open" -- is a POST that costs a few
 * bytes every fifteen seconds.
 *
 * The stream is read with `fetch`, not the browser's `EventSource`, because
 * `EventSource` cannot carry an `Authorization` header and this app holds
 * its access token in memory rather than a cookie precisely so injected
 * script cannot read it.
 */
@Controller('realtime')
export class RealtimeController {
  constructor(
    private readonly realtime: RealtimeService,
    private readonly names: ActorNameService,
    private readonly auditContext: AuditContext,
  ) {}

  /**
   * The stream. Resolves only when the client goes away, which is what keeps
   * the response open; Nest writes nothing itself because `@Res()` hands the
   * response over whole.
   */
  @Get('stream')
  @Authenticated()
  async stream(
    @CurrentUser() principal: Principal,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const name = await this.names.of(principal);

    response.status(HttpStatus.OK);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    // `no-transform` matters as much as `no-cache`: a proxy that gzips this
    // buffers it, and a buffered stream delivers nothing until it ends.
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    // nginx's opt-out, ignored elsewhere and harmless there.
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    const send = (event: RealtimeEvent): boolean => {
      if (response.writableEnded) return false;
      // The boolean `write` returns is backpressure, not death: a client on a
      // slow link would be dropped for being slow if it were read as death.
      response.write(`data: ${JSON.stringify(event)}\n\n`);
      return true;
    };

    const unsubscribe = this.realtime.subscribe(principal.orgId, {
      userId: principal.userId,
      name,
      send,
    });

    // Both halves of the opening state: the client learns the heartbeat it
    // owes, and gets the roster as it stands rather than waiting for someone
    // else to move before any avatar appears.
    send({ kind: 'ready', heartbeatMs: PRESENCE_HEARTBEAT_MS });
    send({ kind: 'presence', records: this.realtime.roster(principal.orgId) });

    const keepalive = setInterval(() => {
      if (response.writableEnded) return;
      // A comment line: valid SSE, ignored by every client, enough traffic to
      // stop an idle connection being reaped.
      response.write(': keepalive\n\n');
    }, KEEPALIVE_MS);
    // Nothing else is waiting on this process; an open stream must not be the
    // reason a deploy cannot shut down.
    keepalive.unref();

    await new Promise<void>((resolve) => {
      const close = (): void => {
        clearInterval(keepalive);
        unsubscribe();
        resolve();
      };
      request.on('close', close);
      response.on('close', close);
    });
  }

  /**
   * "I still have this open." No audit row: presence is not state, it is a
   * few seconds of an avatar, and one row per person per fifteen seconds
   * would bury the trail that matters under noise nobody would ever read.
   * The sync agent's heartbeat is suppressed for the same reason.
   */
  @Post('presence')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  async presence(
    @CurrentUser() principal: Principal,
    @Body() body: PresenceHeartbeatDto,
  ): Promise<void> {
    const name = await this.names.of(principal);
    this.realtime.heartbeat(
      principal.orgId,
      { userId: principal.userId, name },
      body.resource,
      body.recordId,
    );
    this.auditContext.suppress();
  }
}
