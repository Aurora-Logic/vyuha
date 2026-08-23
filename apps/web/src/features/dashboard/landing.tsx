import { Navigate } from 'react-router';
import { PERMISSIONS } from '@vyuha/shared';

import { usePermission } from '@/lib/session/permissions';


/**
 * Where "/" goes, decided by what the person can actually do.
 *
 * It was the attendance dashboard for everybody, which is right for most of
 * the company and wrong for whoever runs it: an owner signing in got their own
 * punch card and a chart of their own attendance, then navigated away every
 * time. The first screen should be the one you would have opened anyway.
 *
 * Keyed on `receivables.view` rather than on a role name. PRD §2 forbids
 * branching on a role -- "Admin" is a name somebody can rename, and roles are
 * editable (REQ-B-07) -- and this permission is the honest test of the
 * question being asked: can this person see the money. Accounts holds it too,
 * and Accounts should also land on the books rather than on a punch card.
 *
 * A redirect rather than a different component, so the address bar says where
 * you are and the page is linkable, bookmarkable and refreshable like any
 * other. `replace` keeps Back going to wherever you came from rather than
 * bouncing through here.
 */
export function LandingPage() {
  const seesTheBooks = usePermission(PERMISSIONS.RECEIVABLES_VIEW);
  // Both branches redirect. "/" is the entry and nothing else -- rendering a
  // screen here as well as at its own address is what let the two meanings
  // drift apart in the first place.
  return <Navigate to={seesTheBooks ? '/reports/dashboard' : '/dashboard'} replace />;
}
