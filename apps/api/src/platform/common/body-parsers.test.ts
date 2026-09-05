import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';

import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { createBodyAdmission, isSyncDoor } from './body-parsers.js';

describe('body parser admission', () => {
  it.each([
    ['/api/v1/sync/agent/results', 'POST', true],
    ['/api/v1/SYNC/AGENT/RESULTS/?cursor=1', 'POST', true],
    ['/api/v1/sync/webhooks/opstally/01900000-0000-7000-8000-000000000000', 'POST', true],
    ['/api/v1/sync/agent/results', 'GET', false],
    ['/api/v1/sync/not-a-route', 'POST', false],
    ['/api/v1/sync/agent/heartbeat', 'POST', false],
  ])('admits large JSON only on %s %s: %s', (url, method, expected) => {
    expect(isSyncDoor({ url, method } as IncomingMessage)).toBe(expected);
  });

  it('caps concurrent bodies and releases exactly once on completion/abort', () => {
    const admission = createBodyAdmission(1, 1);
    const request = (): Request => Object.assign(new EventEmitter(), {
      url: '/api/v1/sync/agent/results', method: 'POST', headers: { 'content-type': 'application/json' },
    }) as Request;
    const response = (): Response => {
      const value = Object.assign(new EventEmitter(), { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() });
      value.status.mockReturnValue(value);
      return value as unknown as Response;
    };
    const firstReq = request();
    const first = response();
    const next = vi.fn();
    admission(firstReq, first, next);
    expect(next).toHaveBeenCalledTimes(1);
    const blocked = response();
    const blockedStatus = vi.spyOn(blocked, 'status');
    admission(request(), blocked, next);
    expect(blockedStatus).toHaveBeenCalledWith(429);
    expect(next).toHaveBeenCalledTimes(1);
    firstReq.emit('aborted');
    first.emit('close');
    const second = response();
    admission(request(), second, next);
    expect(next).toHaveBeenCalledTimes(2);
    const stillBlocked = response();
    const stillBlockedStatus = vi.spyOn(stillBlocked, 'status');
    admission(request(), stillBlocked, next);
    expect(stillBlockedStatus).toHaveBeenCalledWith(429);
    second.emit('finish');
  });
});
