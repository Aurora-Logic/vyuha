import type { RealtimeViewer } from '@vyuha/shared';

/**
 * What a screen reader is told about an avatar stack, which cannot hover to
 * read the tooltips the stack carries for everyone else.
 *
 * Its own module rather than a second export from `presence-avatars.tsx`:
 * a file that exports both a component and a plain function loses fast
 * refresh, and this is the half that wants a unit test anyway.
 */
export function presenceLabel(viewers: readonly RealtimeViewer[]): string {
  const names = viewers.map((viewer) => viewer.name);
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0] ?? ''} is working on this`;
  const last = names.at(-1) ?? '';
  return `${names.slice(0, -1).join(', ')} and ${last} are working on this`;
}
