import { useTaskPresence } from '@/lib/realtime/realtime-provider';

/**
 * How many tasks somebody has open right now.
 *
 * Its own module rather than a second export from `working-now.tsx`: a file
 * that exports both a component and a plain hook loses fast refresh, and the
 * block's header wants the count without rendering the list.
 */
export function useWorkingNowCount(): number {
  return useTaskPresence().length;
}
