import { Suspense, lazy, useEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router';

import { Spinner } from '@/components/ui/spinner';
import { LoginPage } from '@/features/auth/login-page';
import { setPasswordRoute } from '@/features/auth/set-password-route';
import { portalRoute } from '@/features/portal/portal-route';
import { legalRoute } from '@/features/legal/legal-route';
import { useSessionStore } from '@/lib/session/session-store';
import { useMe, useRevalidateSessionOnReconnect } from '@/lib/session/use-session';

/*
 * P-23: four of the five screens this gate can show were imported eagerly, so
 * every cold load carried all of them and used one. The enrolment screen was
 * the expensive one -- it brings a QR renderer with it, 14.7 kB gzipped, for a
 * screen most people never see. They are lazy now; the sign-in screen stays
 * eager because an anonymous cold load is the common way in and a spinner
 * before the password field is worse than the bytes.
 *
 * The route matchers stay eager on purpose: they are a few lines each and the
 * gate has to consult them before it can decide which screen to load.
 */
const MfaRequiredPage = lazy(() => import('@/features/auth/mfa-required-page').then((m) => ({ default: m.MfaRequiredPage })));
const SetPasswordPage = lazy(() => import('@/features/auth/set-password-page').then((m) => ({ default: m.SetPasswordPage })));
const LegalPage = lazy(() => import('@/features/legal/legal-page').then((m) => ({ default: m.LegalPage })));
const PortalPage = lazy(() => import('@/features/portal/portal-page').then((m) => ({ default: m.PortalPage })));

/** The same centred spinner the gate shows while the session resolves. */
function GateFallback() {
  return (
    <div className="flex min-h-dvh items-center justify-center" role="status" aria-label="Loading">
      <Spinner className="size-6" />
    </div>
  );
}

/**
 * Decides whether the visitor sees the application or the sign-in screen.
 *
 * Three states, not two. "Still resolving" is distinct from "anonymous"
 * because the access token lives in memory only and a cold load has to try
 * the refresh cookie first — collapsing the two would flash the login screen
 * at every signed-in user on every page refresh.
 *
 * Four, now. An invitation link (REQ-B-03) and a password-reset link
 * (REQ-B-04) are answered by the token in the URL rather than by a session, and
 * every one of them used to land on the sign-in form — a screen with nowhere to
 * set a password, which meant an invited person could never become a signed-in
 * one. Those routes cannot live in `App.tsx` either: everything there renders
 * inside `AppShell`, which is behind this very gate.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const { data: me, isPending } = useMe();
  const pathname = useLocation().pathname;
  const setPassword = setPasswordRoute(pathname);
  const legal = legalRoute(pathname);
  const portal = portalRoute(pathname);
  const setFromMe = useSessionStore((s) => s.setFromMe);
  const clear = useSessionStore((s) => s.clear);

  // Mounted here because this is the component that decides between the app
  // and the sign-in screen, so it is where a revoked session has to land.
  useRevalidateSessionOnReconnect();

  useEffect(() => {
    if (isPending) return;
    if (me) {
      const name = me.employee
        ? [me.employee.firstName, me.employee.lastName].filter(Boolean).join(' ')
        : me.user.email;
      setFromMe({
        displayName: name,
        roleLabel: me.roles.map((r) => r.name).join(', ') || 'No role',
        employeeId: me.user.employeeId,
        permissions: [...me.permissions],
      });
    } else {
      clear();
    }
  }, [me, isPending, setFromMe, clear]);

  // Before the session is even consulted: the token is the credential, and
  // somebody following an invitation has no session by definition. An
  // administrator who is signed in and opens the link gets the same screen,
  // which is correct — the token names the account, not the reader.
  if (setPassword !== null) {
    return (
      <Suspense fallback={<GateFallback />}>
        <SetPasswordPage mode={setPassword.mode} token={setPassword.token} />
      </Suspense>
    );
  }

  // 15 REQ-AL-01/AL-02: the customer portal. The key in the path is the
  // credential and the reader has no account, so this is decided before the
  // session is consulted -- a customer who lands on a sign-in form has been
  // sent to a screen they can never get past. A signed-in member of staff
  // opening the same link sees the same page, which is correct: the key
  // names the customer, not the reader.
  if (portal !== null) {
    return (
      <Suspense fallback={<GateFallback />}>
        <PortalPage portalKey={portal} />
      </Suspense>
    );
  }

  // Readable without a session, and with one: the terms are accepted by
  // signing in, so they cannot sit behind the sign-in they are accepted at.
  if (legal !== null) {
    return (
      <Suspense fallback={<GateFallback />}>
        <LegalPage slug={legal} />
      </Suspense>
    );
  }

  if (isPending) {
    return (
      <div
        className="flex min-h-dvh items-center justify-center"
        role="status"
        aria-label="Loading"
      >
        <Spinner className="size-6" />
      </div>
    );
  }

  if (!me) return <LoginPage />;

  // REQ-B-09: the policy names this person's role and no authenticator is
  // confirmed yet. The session is real; the shell waits for the first code.
  if (me.mfa?.enrolmentRequired === true) {
    return (
      <Suspense fallback={<GateFallback />}>
        <MfaRequiredPage />
      </Suspense>
    );
  }

  return <>{children}</>;
}
