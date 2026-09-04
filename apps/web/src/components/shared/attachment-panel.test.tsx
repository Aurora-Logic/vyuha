import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test-support/render-shell';

import { AttachmentPanel, type AttachmentRow } from './attachment-panel';

/**
 * The preview is the point of this panel (owner, 1 Sep 2026), and a preview
 * that silently renders nothing looks exactly like one that was never asked
 * for. These pin that a picture is on screen — as a thumbnail in the row, as
 * the full image in the dialog, and from the local file while it uploads —
 * and that a document is still handed to the browser rather than framed.
 */

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiRequest: vi.fn() };
});

const { apiRequest } = await import('@/lib/api/client');
const request = vi.mocked(apiRequest);

const SIGNED = 'https://objects.example/crate.jpg?signature=abc';

// Bound, so putting them back is putting back something that still works.
const realOpen = window.open.bind(window);
const realCreateObjectURL = URL.createObjectURL.bind(URL);
const realRevokeObjectURL = URL.revokeObjectURL.bind(URL);

function row(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: 'a-1',
    filename: 'damaged-crate.jpg',
    mime: 'image/jpeg',
    bytes: 240_000,
    uploadedAt: '2026-09-01T04:00:00Z',
    uploadedByName: 'Meera Iyer',
    ...overrides,
  };
}

function panel(props: Partial<React.ComponentProps<typeof AttachmentPanel>> = {}) {
  return (
    <AttachmentPanel
      title="Attachments"
      note="Drawings and photographs."
      accept="image/jpeg,image/png,.pdf"
      basePath="/tasks/t-1/attachments"
      attachments={[row()]}
      isPending={false}
      canManage
      uploadLabel="Attach a file to this task"
      onUpload={() => Promise.resolve()}
      onRemove={() => Promise.resolve()}
      {...props}
    />
  );
}

beforeEach(() => {
  request.mockImplementation(() => Promise.resolve({ url: SIGNED, expiresInSeconds: 300 }));
});

afterEach(() => {
  request.mockReset();
  // Restored by hand, not with unstubAllGlobals: setup.ts installs matchMedia
  // and the observers through vi.stubGlobal at module scope, so unstubbing
  // everything here strips them for every test after this one.
  window.open = realOpen;
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
});

describe('AttachmentPanel', () => {
  it('shows a picture as a picture, not as a paperclip and a filename', async () => {
    renderWithProviders(panel());

    // The frame is a real control, so it is reachable by keyboard and says
    // what it does; the picture lives inside it.
    const frame = await screen.findByRole('button', { name: 'View damaged-crate.jpg full size' });
    expect(within(frame).getByAltText('').getAttribute('src')).toBe(SIGNED);
  });

  it('opens the full image in a dialog rather than sending the reader to a tab', async () => {
    const open = vi.fn();
    window.open = open;
    renderWithProviders(panel());

    await userEvent.click(await screen.findByRole('button', { name: 'View damaged-crate.jpg full size' }));

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect(within(dialog).getByAltText('damaged-crate.jpg').getAttribute('src')).toBe(SIGNED);
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('hands a document to the browser, and frames nothing', async () => {
    const open = vi.fn();
    window.open = open;
    renderWithProviders(panel({ attachments: [row({ filename: 'quote.pdf', mime: 'application/pdf' })] }));

    expect(screen.queryByAltText('')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'quote.pdf' }));
    await waitFor(() => {
      expect(open).toHaveBeenCalledWith(SIGNED, '_blank', 'noopener');
    });
  });

  it('shows the picture being uploaded while it is still uploading', async () => {
    URL.createObjectURL = () => 'blob:local-preview';
    URL.revokeObjectURL = () => {};
    // Held open so the upload is still in flight when we look.
    let finish = () => {};
    const onUpload = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));

    renderWithProviders(panel({ attachments: [], onUpload }));

    const file = new File(['bytes'], 'site-visit.png', { type: 'image/png' });
    await userEvent.upload(screen.getByLabelText('Attach a file to this task'), file);

    const preview = await screen.findByAltText('');
    expect(preview.getAttribute('src')).toBe('blob:local-preview');
    expect(screen.getByText('Uploading site-visit.png')).toBeTruthy();

    finish();
    await waitFor(() => {
      expect(screen.queryByText('Uploading site-visit.png')).toBeNull();
    });
  });

  it('says nothing is attached only when nothing is, and never over an error', () => {
    const { rerender } = renderWithProviders(panel({ attachments: [] }));
    expect(screen.getByText('Nothing attached yet.')).toBeTruthy();

    rerender(panel({ attachments: [], errorSlot: <p>The list could not be read</p> }));
    expect(screen.queryByText('Nothing attached yet.')).toBeNull();
  });
});
