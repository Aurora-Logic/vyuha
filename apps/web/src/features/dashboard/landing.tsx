import { Navigate } from 'react-router';

import { PERMISSIONS } from '@vyuha/shared';

import { usePermission } from '@/lib/session/permissions';

/**
 * Where "/" goes.
 *
 * The Reports overview is the front page for whoever holds report.view
 * (owner, 26 Aug 2026: the dashboard's job moved there); everyone else
 * lands on Punch, the one screen every employee owns. A redirect rather
 * than a component, so the address bar says where you are and the page is
 * linkable, bookmarkable and refreshable like any other. `replace` keeps
 * Back going to wherever you came from rather than bouncing through here.
 */
export function LandingPage() {
  const canReports = usePermission(PERMISSIONS.REPORT_VIEW);
  return <Navigate to={canReports ? '/reports' : '/punch'} replace />;
}
