import { useState } from 'react';
import {
  CheckIcon,
  CopyIcon,
  EyeIcon,
  EyeSlashIcon,
  KeyIcon,
  PaperPlaneTiltIcon,
  SparkleIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { format, parseISO } from 'date-fns';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { CopyField } from '@/components/shared/copy-field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { ApiError } from '@/lib/api/client';
import {
  INVITATION_TTL_HOURS,
  PASSWORD_RESET_TTL_MINUTES,
  employeeDisplayName,
  type EmployeeListItem,
  type SignInAccount,
} from '@vyuha/shared';

import {
  useCreateInvitation,
  useIssuePasswordResetLink,
  useSetCredentials,
  useSignInAccount,
} from './use-sign-in-access';

/**
 * REQ-B-03: how somebody gets an account, on the record of the person who is
 * getting one.
 *
 * Until this existed there was no invite screen anywhere in the product — an
 * account could only be created by calling `POST /auth/invitations` by hand —
 * and the link it minted was only ever sent by email. With no mail server
 * configured that is nobody signing in, ever, which is why the endpoint now
 * returns the link and why this dialog exists to show it.
 *
 * The dialog reads `/employees/:id/access` before offering anything, because
 * what a person needs depends on what they already have, and the register's row
 * does not carry it:
 *
 *   * no account            — invite them
 *   * invited, not accepted — issue a fresh link; the previous one dies
 *   * active                — no second login (REQ-B-02 is 1:1). A password
 *                             reset link is the thing they actually want
 *   * suspended             — neither, until it is reactivated
 *
 * Every one of those refusals is also enforced server-side; this states the
 * reason before the press rather than after a 409.
 */

interface InviteDialogProps {
  employee: EmployeeListItem | null;
  onOpenChange: (open: boolean) => void;
}

export function EmployeeInviteDialog({ employee, onOpenChange }: InviteDialogProps) {
  return (
    <Dialog open={employee !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* Remounted per person, so a link minted for one employee can never
            still be on screen while another one's record is open. */}
        {employee === null ? null : (
          <InviteBody
            key={employee.id}
            employee={employee}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * "this link stops working on Sunday 17 August at 12:04".
 *
 * Long form, not the dd-MM-yyyy the tables use. This sentence is read once, by
 * somebody deciding whether it is worth sending now or in the morning, and
 * "17-08-2026" makes that arithmetic rather than reading. The time is included
 * because 72 hours does not land at midnight.
 */
function expiryInWords(iso: string): string {
  const at = parseISO(iso);
  if (Number.isNaN(at.getTime())) return 'shortly';
  return format(at, "EEEE d MMMM 'at' HH:mm");
}

function AccessSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Checking this employee's account" className="space-y-2 py-4">
      <Skeleton aria-hidden className="h-4 w-48" />
      <Skeleton aria-hidden className="h-9 w-full" />
    </div>
  );
}

function generateRandomPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%&*';
  let password = '';
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

function InviteBody({ employee, onClose }: { employee: EmployeeListItem; onClose: () => void }) {
  const name = employeeDisplayName(employee.firstName, employee.lastName);
  const access = useSignInAccount(employee.id);
  const invite = useCreateInvitation();
  const reset = useIssuePasswordResetLink();
  const setCreds = useSetCredentials();

  const account = access.data?.account ?? null;
  const defaultEmail =
    employee.workEmail ||
    `${employee.firstName.toLowerCase()}.${(employee.lastName || 'emp').toLowerCase()}@company.local`;

  const [tab, setTab] = useState<'direct' | 'link'>('direct');
  const [emailInput, setEmailInput] = useState(account?.email || defaultEmail);
  const [passwordInput, setPasswordInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [copiedCreds, setCopiedCreds] = useState(false);

  const [savedCreds, setSavedCreds] = useState<{ email: string; password: string } | null>(null);
  const [issuedLink, setIssuedLink] = useState<{ kind: 'invitation' | 'reset'; url: string; expiresAt: string } | null>(
    null,
  );

  function handleSetDirectCredentials(e: React.FormEvent) {
    e.preventDefault();
    if (!emailInput || !passwordInput) return;

    setCreds.mutate(
      {
        employeeId: employee.id,
        email: emailInput,
        password: passwordInput,
        reason: 'Direct credential provisioning by admin',
      },
      {
        onSuccess: () => {
          setSavedCreds({ email: emailInput, password: passwordInput });
          void access.refetch();
          toast.add({
            type: 'success',
            title: `Credentials saved for ${name}`,
            description: 'Employee can now log in immediately with this email and password.',
          });
        },
      },
    );
  }

  function handleSendInvitationLink() {
    if (!emailInput) return;
    invite.mutate(
      { employeeId: employee.id, email: emailInput },
      {
        onSuccess: (result) => {
          setIssuedLink({ kind: 'invitation', url: result.acceptUrl, expiresAt: result.expiresAt });
          void access.refetch();
        },
      },
    );
  }

  function handleIssueResetLink() {
    reset.mutate(
      { employeeId: employee.id },
      {
        onSuccess: (result) => {
          setIssuedLink({ kind: 'reset', url: result.resetUrl, expiresAt: result.expiresAt });
        },
      },
    );
  }

  function handleCopyCreds() {
    if (!savedCreds) return;
    const text = `Vyuha Login Credentials:\nEmail: ${savedCreds.email}\nPassword: ${savedCreds.password}`;
    void navigator.clipboard.writeText(text);
    setCopiedCreds(true);
    setTimeout(() => { setCopiedCreds(false); }, 2000);
  }

  const isPending = invite.isPending || reset.isPending || setCreds.isPending;
  const failure = invite.error ?? reset.error ?? setCreds.error;

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {savedCreds !== null
            ? `Credentials Ready for ${name}`
            : issuedLink !== null
              ? `Send Link to ${name}`
              : `Manage Login Credentials · ${name}`}
        </DialogTitle>
        <DialogDescription>
          {savedCreds !== null
            ? 'The login account is active. Share these credentials with the employee.'
            : issuedLink !== null
              ? 'Nothing was emailed. Copy the link and send it directly to the employee.'
              : `Set a direct login password or generate a self-serve activation link for ${employee.employeeCode}.`}
        </DialogDescription>
      </DialogHeader>

      {access.isPending ? <AccessSkeleton /> : null}

      {access.isError ? (
        <QueryErrorAlert
          error={access.error}
          subject="this employee's account"
          onRetry={() => {
            void access.refetch();
          }}
        />
      ) : null}

      {failure != null ? (
        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>{failureCopy(failure).title}</AlertTitle>
          <AlertDescription>{failureCopy(failure).description}</AlertDescription>
        </Alert>
      ) : null}

      {savedCreds !== null ? (
        <div className="flex flex-col gap-4 py-2">
          <div className="rounded border bg-muted/40 p-4 space-y-3">
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Sign in Email</span>
              <p className="font-mono text-sm font-medium select-all">{savedCreds.email}</p>
            </div>
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Password</span>
              <p className="font-mono text-sm font-medium select-all">{savedCreds.password}</p>
            </div>
          </div>

          <Button variant="outline" className="w-full gap-2" onClick={handleCopyCreds}>
            {copiedCreds ? <CheckIcon className="text-success" /> : <CopyIcon />}
            {copiedCreds ? 'Copied to clipboard!' : 'Copy Email & Password'}
          </Button>
        </div>
      ) : issuedLink !== null ? (
        <IssuedLink issued={issuedLink} name={name} />
      ) : access.isSuccess ? (
        <div className="py-2">
          <Tabs
            value={tab}
            onValueChange={(val: string) => {
              if (val === 'direct' || val === 'link') setTab(val);
            }}
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="direct">Direct Password</TabsTrigger>
              <TabsTrigger value="link">Invite / Reset Link</TabsTrigger>
            </TabsList>

            <TabsContent value="direct" className="space-y-4 pt-3">
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="cred-email">Login Email</Label>
                  <Input
                    id="cred-email"
                    type="email"
                    required
                    value={emailInput}
                    onChange={(e) => { setEmailInput(e.target.value); }}
                    placeholder="name@company.com"
                  />
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="cred-password">
                      {account !== null ? 'New Password' : 'Set Password'}
                    </Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="text-primary hover:underline h-auto p-0 text-[11px]"
                      onClick={() => {
                        setPasswordInput(generateRandomPassword());
                        setShowPassword(true);
                      }}
                    >
                      <SparkleIcon size={12} data-icon="inline-start" />
                      Generate random
                    </Button>
                  </div>
                  <div className="relative">
                    <Input
                      id="cred-password"
                      type={showPassword ? 'text' : 'password'}
                      required
                      minLength={8}
                      value={passwordInput}
                      onChange={(e) => { setPasswordInput(e.target.value); }}
                      placeholder="Min 8 characters"
                      className="pr-8"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      onClick={() => { setShowPassword(!showPassword); }}
                    >
                      {showPassword ? <EyeSlashIcon /> : <EyeIcon />}
                    </Button>
                  </div>
                </div>

                {account !== null ? (
                  <p className="text-[11px] text-muted-foreground">
                    This will immediately update the login password for {account.email} and unlock the account if locked.
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    This creates an active login account linked to {name} ({employee.employeeCode}) with the default Employee role.
                  </p>
                )}
              </div>
            </TabsContent>

            <TabsContent value="link" className="space-y-4 pt-3">
              <Offer
                account={account}
                name={name}
                workEmail={emailInput}
                failure={null}
              />
            </TabsContent>
          </Tabs>
        </div>
      ) : null}

      <DialogFooter className="flex-row justify-end gap-2 pt-2">
        <Button variant="outline" className="flex-1 sm:flex-none" onClick={onClose}>
          <ACTION_ICONS.cancel data-icon="inline-start" />
          {savedCreds !== null || issuedLink !== null ? 'Done' : 'Cancel'}
        </Button>

        {savedCreds === null && issuedLink === null && access.isSuccess ? (
          tab === 'direct' ? (
            <Button
              className="flex-1 sm:flex-none"
              disabled={isPending || !emailInput || !passwordInput}
              onClick={handleSetDirectCredentials}
            >
              {isPending ? <Spinner data-icon="inline-start" /> : <KeyIcon data-icon="inline-start" />}
              {isPending ? 'Saving...' : account === null ? 'Create Credentials' : 'Update Password'}
            </Button>
          ) : (
            <PrimaryAction
              account={account}
              workEmail={emailInput}
              pending={isPending}
              onInvite={handleSendInvitationLink}
              onReset={handleIssueResetLink}
            />
          )
        ) : null}
      </DialogFooter>
    </>
  );
}

type Account = SignInAccount['account'];

/**
 * What is about to happen, or the stated reason nothing can.
 *
 * No buttons here: the one action lives in the footer, nearest the thumb and
 * in the same place every other dialog in the product puts it. A second copy
 * beside the explanation would be two controls for one press.
 */
function Offer({
  account,
  name,
  workEmail,
  failure,
}: {
  account: Account;
  name: string;
  workEmail: string | null;
  failure: unknown;
}) {
  return (
    <div className="flex flex-col gap-3">
      {failure != null ? (
        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>{failureCopy(failure).title}</AlertTitle>
          <AlertDescription>{failureCopy(failure).description}</AlertDescription>
        </Alert>
      ) : null}

      {account !== null && account.status === 'ACTIVE' ? (
        <Alert>
          <KeyIcon />
          <AlertTitle>{name} already has an account</AlertTitle>
          <AlertDescription>
            They sign in as {account.email}. You can generate a password reset link below ({PASSWORD_RESET_TTL_MINUTES} mins), or switch to the Direct Password tab to set it immediately.
          </AlertDescription>
        </Alert>
      ) : null}

      {account !== null && account.status === 'SUSPENDED' ? (
        <Alert>
          <WarningCircleIcon />
          <AlertTitle>{name}&rsquo;s account is suspended</AlertTitle>
          <AlertDescription>
            A suspended account cannot sign in. Reactivate the account first.
          </AlertDescription>
        </Alert>
      ) : null}

      {account !== null && account.status === 'INVITED' ? (
        <Alert>
          <PaperPlaneTiltIcon />
          <AlertTitle>{name} was previously invited</AlertTitle>
          <AlertDescription>
            Their invitation to {account.email} was never accepted. Issuing a new link will invalidate the old one.
          </AlertDescription>
        </Alert>
      ) : null}

      {account === null ? (
        <ul className="text-muted-foreground flex list-disc flex-col gap-1 pl-5 text-xs">
          <li>
            An invitation link will be created for <span className="font-medium">{workEmail}</span>.
          </li>
          <li>
            The link works once and expires in {INVITATION_TTL_HOURS} hours.
          </li>
          <li>
            Copy the link after creation and share it with the employee.
          </li>
        </ul>
      ) : null}
    </div>
  );
}

function PrimaryAction({
  account,
  workEmail,
  pending,
  onInvite,
  onReset,
}: {
  account: Account;
  workEmail: string | null;
  pending: boolean;
  onInvite: () => void;
  onReset: () => void;
}) {
  if (account !== null && account.status === 'SUSPENDED') return null;

  if (account !== null && account.status === 'ACTIVE') {
    return (
      <Button className="flex-1 sm:flex-none" disabled={pending} onClick={onReset}>
        {pending ? <Spinner data-icon="inline-start" /> : <KeyIcon data-icon="inline-start" />}
        {pending ? 'Generating...' : 'Generate Reset Link'}
      </Button>
    );
  }

  return (
    <Button
      className="flex-1 sm:flex-none"
      disabled={pending || !workEmail}
      onClick={onInvite}
    >
      {pending ? <Spinner data-icon="inline-start" /> : <PaperPlaneTiltIcon data-icon="inline-start" />}
      {pending ? 'Creating...' : account === null ? 'Create Invitation Link' : 'Issue New Link'}
    </Button>
  );
}

function IssuedLink({
  issued,
  name,
}: {
  issued: { kind: 'invitation' | 'reset'; url: string; expiresAt: string };
  name: string;
}) {
  return (
    <div className="flex flex-col gap-3 py-2">
      <CopyField
        id="issued-link"
        value={issued.url}
        label={issued.kind === 'invitation' ? 'Invitation link' : 'Password reset link'}
      />

      <ul className="text-muted-foreground flex list-disc flex-col gap-1 pl-5 text-xs">
        <li>
          This link stops working on{' '}
          <span className="text-foreground font-medium">{expiryInWords(issued.expiresAt)}</span>.
        </li>
        <li>
          It can be used once. Send it directly to {name}.
        </li>
      </ul>
    </div>
  );
}

function failureCopy(error: unknown): { title: string; description: string } {
  if (!(error instanceof ApiError)) {
    return { title: 'That did not go through', description: 'Something went wrong on the way.' };
  }

  switch (error.code) {
    case 'NETWORK_ERROR':
      return {
        title: 'Could not reach the server',
        description: 'Check the connection and try again.',
      };
    case 'FORBIDDEN':
      return {
        title: 'The server refused this',
        description: 'Managing credentials needs the employee.manage permission.',
      };
    case 'EMPLOYEE_ALREADY_LINKED':
    case 'CONFLICT':
      return { title: 'Refused', description: error.message };
    case 'VALIDATION_FAILED':
      return { title: 'The server would not accept that', description: error.message };
    default:
      return { title: 'That did not go through', description: error.message };
  }
}
