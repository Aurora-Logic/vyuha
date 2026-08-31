import type { RealtimeViewer } from '@vyuha/shared';
import { Link } from 'react-router';

import { PersonChip } from '@/components/shared/person';
import { Skeleton } from '@/components/ui/skeleton';
import { useTaskPresence } from '@/lib/realtime/realtime-provider';

import { useTask } from './use-tasks';

/**
 * REQ-V-14: who has a task open, right now, on one screen.
 *
 * The board already puts an avatar on the card somebody is inside, but that
 * only answers the question if you happen to be looking at the lane they are
 * in. This is the same fact asked the other way round -- "who is working, and
 * on what" -- which is the question a manager opening a dashboard actually
 * has.
 *
 * Nothing here polls. The roster arrives on the live stream and this rerenders
 * when it changes, so somebody opening a task appears within a second and
 * disappears when they close it.
 */

function WorkingRow({ recordId, viewers }: { readonly recordId: string; readonly viewers: readonly RealtimeViewer[] }) {
  // Cached under ['tasks','one',id]: the sheet and the board have usually
  // fetched it already, and at most a handful of records are ever open.
  const task = useTask(recordId);

  return (
    <li className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {viewers.map((viewer) => (
          <PersonChip key={viewer.userId} name={viewer.name} tiny />
        ))}
      </span>
      <span className="text-muted-foreground">on</span>
      {task.isPending ? (
        <Skeleton className="h-3.5 w-32" />
      ) : task.data === undefined ? (
        // A record the reader may not open is still a record somebody is in.
        // Naming the person without naming the task is the honest half.
        <span className="text-muted-foreground">a task you cannot see</span>
      ) : (
        <Link
          to={`/tasks?task=${recordId}`}
          className="min-w-0 truncate font-medium underline-offset-4 hover:underline"
        >
          {task.data.title}
        </Link>
      )}
    </li>
  );
}

export function WorkingNow() {
  const records = useTaskPresence();

  if (records.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Nobody has a task open at the moment. Anyone who opens one appears here while they are in it.
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y text-sm">
      {records.map((record) => (
        <WorkingRow key={record.recordId} recordId={record.recordId} viewers={record.viewers} />
      ))}
    </ul>
  );
}
