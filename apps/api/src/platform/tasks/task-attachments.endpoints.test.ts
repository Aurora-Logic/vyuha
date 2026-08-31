import { PERMISSIONS, SYSTEM_ROLES, type TaskAttachmentView, type TaskView } from '@vyuha/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiHarness, scopedEmail } from '../../test-support/api-harness.js';

/**
 * REQ-V-12: documents and photographs on a task.
 *
 * Two properties are worth the round trip. A filename is never the evidence
 * — an executable called `invoice.pdf` is refused by its bytes, not admitted
 * by its extension. And an attachment is not a way into a task the caller
 * cannot already read: the scope is checked before the file is touched.
 */

const ORG_ID = '01900000-0000-7000-8000-00000000f1c9';

let harness: ApiHarness;
let adminToken = '';
let selfToken = '';

/** A real multipart upload, because that is what the browser sends. */
async function upload(
  taskId: string,
  token: string,
  bytes: Buffer,
  filename: string,
  type: string,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), filename);
  const response = await fetch(`${harness.baseUrl}/tasks/${taskId}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as Record<string, unknown>) };
}

const PDF = Buffer.concat([Buffer.from('%PDF-1.7', 'latin1'), Buffer.alloc(2048, 0x20)]);
/** A 1x1 PNG: the smallest thing the image pipeline will actually re-encode. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(async () => {
  harness = await ApiHarness.start(ORG_ID, 'Task Attachments Fixture Org');
  const adminRoleId = await harness.createSystemRole(SYSTEM_ROLES.ADMIN, { isSystem: true });
  const selfRoleId = await harness.createRole('Attachments self', [
    PERMISSIONS.CRM_TASK_VIEW_SELF,
    PERMISSIONS.CRM_TASK_MANAGE,
  ]);

  const raviId = await harness.createEmployee({ code: 'TAT-001', firstName: 'Ravi', lastName: 'Kumar' });
  const meeraId = await harness.createEmployee({ code: 'TAT-002', firstName: 'Meera', lastName: 'Iyer' });
  const admin = await harness.createUser({ email: scopedEmail('tat-admin'), roleIds: [adminRoleId], employeeId: raviId });
  const self = await harness.createUser({ email: scopedEmail('tat-self'), roleIds: [selfRoleId], employeeId: meeraId });
  adminToken = (await harness.login(admin.email, admin.password)).token;
  selfToken = (await harness.login(self.email, self.password)).token;
});

afterAll(async () => {
  await harness.close();
});

async function makeTask(token: string, title: string): Promise<TaskView> {
  const response = await harness.post<TaskView>('/tasks', { token, body: { title } });
  expect(response.status).toBe(201);
  return response.body;
}

describe('a document on a task', () => {
  it('takes a PDF, lists it, mints a link for it and lets it be removed', async () => {
    const task = await makeTask(selfToken, 'Attachment probe');
    const added = await upload(task.id, selfToken, PDF, 'challan.pdf', 'application/pdf');
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body?.filename).toBe('challan.pdf');
    expect(added.body?.mime).toBe('application/pdf');
    expect(await harness.waitForAuditAction('task.attachment_added')).toBe(true);

    const listed = await harness.get<TaskAttachmentView[]>(`/tasks/${task.id}/attachments`, { token: selfToken });
    expect(listed.body.map((a) => a.filename)).toEqual(['challan.pdf']);
    // The contract says number and raw SQL hands back text. The deal list hit
    // exactly this and the sheet refused the shape, so it is asserted here.
    expect(typeof listed.body[0]?.bytes).toBe('number');
    expect(listed.body[0]?.uploadedByName).toBe('Meera Iyer');

    const url = await harness.get<{ url: string; expiresInSeconds: number }>(
      `/tasks/${task.id}/attachments/${listed.body[0]?.id ?? ''}/url`,
      { token: selfToken },
    );
    expect(url.status).toBe(200);
    expect(url.body.url).toContain('http');
    expect(url.body.expiresInSeconds).toBeGreaterThan(0);

    const removed = await harness.del(`/tasks/${task.id}/attachments/${listed.body[0]?.id ?? ''}`, { token: selfToken });
    expect(removed.status).toBe(204);
    expect((await harness.get<unknown[]>(`/tasks/${task.id}/attachments`, { token: selfToken })).body).toEqual([]);
  });

  it('takes an image through the picture pipeline', async () => {
    const task = await makeTask(selfToken, 'Photograph probe');
    const added = await upload(task.id, selfToken, PNG, 'damaged-crate.png', 'image/png');
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    // Re-encoded rather than stored as it came: the mime is the pipeline's
    // answer, not the browser's claim.
    expect(String(added.body?.mime)).toContain('image/');
    expect(Number(added.body?.bytes)).toBeGreaterThan(0);
  });

  it('refuses what only claims to be a document, by its bytes', async () => {
    const task = await makeTask(selfToken, 'Hostile upload probe');
    // An executable wearing a PDF name and a PDF content-type.
    const disguised = Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(2048, 0x41)]);
    expect((await upload(task.id, selfToken, disguised, 'invoice.pdf', 'application/pdf')).status).toBe(400);
    expect((await upload(task.id, selfToken, Buffer.alloc(0), 'nothing.pdf', 'application/pdf')).status).toBe(400);
    const listed = await harness.get<unknown[]>(`/tasks/${task.id}/attachments`, { token: selfToken });
    expect(listed.body, 'nothing was stored').toEqual([]);
  });
});

describe('an attachment is not a way into a task', () => {
  it('refuses to attach to a task the caller cannot see', async () => {
    // The self-scoped user holds view.self, so a task owned and assigned by
    // the admin to nobody they can reach is outside their scope.
    const theirs = await makeTask(adminToken, 'Somebody else task');
    const refused = await upload(theirs.id, selfToken, PDF, 'sneak.pdf', 'application/pdf');
    expect([403, 404]).toContain(refused.status);
  });

  it('refuses to list or link an attachment on a task the caller cannot see', async () => {
    const theirs = await makeTask(adminToken, 'Somebody else task, listing');
    const added = await upload(theirs.id, adminToken, PDF, 'private.pdf', 'application/pdf');
    expect(added.status).toBe(201);

    const listed = await harness.get(`/tasks/${theirs.id}/attachments`, { token: selfToken });
    expect([403, 404]).toContain(listed.status);

    const link = await harness.get(`/tasks/${theirs.id}/attachments/${String(added.body?.id)}/url`, { token: selfToken });
    expect([403, 404]).toContain(link.status);
  });

  it('refuses an unauthenticated upload and an unauthenticated read', async () => {
    const task = await makeTask(selfToken, 'Anonymous probe');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(PDF)], { type: 'application/pdf' }), 'x.pdf');
    const anonymous = await fetch(`${harness.baseUrl}/tasks/${task.id}/attachments`, { method: 'POST', body: form });
    expect(anonymous.status).toBe(401);
    expect((await harness.get(`/tasks/${task.id}/attachments`)).status).toBe(401);
  });

  it('refuses an attachment id that belongs to another task', async () => {
    const mine = await makeTask(selfToken, 'Mine with a file');
    const other = await makeTask(selfToken, 'Mine without one');
    const added = await upload(mine.id, selfToken, PDF, 'mine.pdf', 'application/pdf');
    expect(added.status).toBe(201);
    // The id exists, but not on that task: it must not resolve.
    const crossed = await harness.get(`/tasks/${other.id}/attachments/${String(added.body?.id)}/url`, {
      token: selfToken,
    });
    expect(crossed.status).toBe(404);
  });
});
