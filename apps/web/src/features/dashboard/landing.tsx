import { Navigate } from 'react-router';

/**
 * Where "/" goes.
 *
 * It once branched on `receivables.view` and sent the money-minded to the
 * reports dashboard; that module was removed (owner, 26 Aug 2026), so
 * everybody lands on the attendance dashboard until a successor front page
 * exists. A redirect rather than a component, so the address bar says where
 * you are and the page is linkable, bookmarkable and refreshable like any
 * other. `replace` keeps Back going to wherever you came from rather than
 * bouncing through here.
 */
export function LandingPage() {
  return <Navigate to="/dashboard" replace />;
}
