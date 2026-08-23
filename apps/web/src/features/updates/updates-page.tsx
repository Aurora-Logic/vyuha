import { useEffect } from 'react';
import { ArrowRightIcon, CompassIcon } from '@phosphor-icons/react';
import { useNavigate } from 'react-router';

import { PageHeader } from '@/components/shared/page-header';
import { BuildStamp } from '@/components/shared/build-stamp';
import { SectionHeading } from '@/components/shared/section-heading';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { useGuideStore } from '@/lib/guide-store';
import { formatDate } from '@/lib/format';
import { usePermissions } from '@/lib/session/permissions';

import { LATEST_VERSION, visibleReleases, type ChangeKind } from './changelog';

/**
 * What changed, and when.
 *
 * Off the sidebar on purpose. PRD §6.1 fixes the navigation to Work, Records,
 * Reports and Setup, and a changelog belongs to none of them — so it takes the
 * same treatment `/profile` already takes and is reached from the account menu,
 * with its name declared in `OFF_NAV_LABELS` so the breadcrumb can render it.
 *
 * Opening the page is what clears the unread dot. There is no "mark all read"
 * control, because having looked at the page is the only evidence worth acting
 * on and a second control would only let the two disagree.
 */

const KIND_LABELS: Record<ChangeKind, string> = {
  added: 'Added',
  changed: 'Changed',
  fixed: 'Fixed',
};

/**
 * Colour is not the only signal — each badge carries its word. A palette that
 * distinguishes three states by hue alone fails for the readers who most need
 * the distinction.
 */
const KIND_VARIANTS: Record<ChangeKind, 'default' | 'secondary' | 'outline'> = {
  added: 'default',
  changed: 'secondary',
  fixed: 'outline',
};

export function UpdatesPage() {
  const navigate = useNavigate();
  const granted = usePermissions();
  const markUpdatesSeen = useGuideStore((s) => s.markUpdatesSeen);
  const armTour = useGuideStore((s) => s.arm);

  const releases = visibleReleases(granted);

  useEffect(() => {
    markUpdatesSeen(LATEST_VERSION);
  }, [markUpdatesSeen]);

  if (releases.length === 0) {
    return (
      <>
        <PageHeader description="What changed in the product, and when." />
      <BuildStamp />
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CompassIcon />
            </EmptyMedia>
            <EmptyTitle>No updates yet</EmptyTitle>
            <EmptyDescription>
              Changes that affect the screens you can open will be listed here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader description="What changed in the product, and when." />
      <BuildStamp />

      {releases.map((release) => (
        <section key={release.version} className="flex flex-col gap-1">
          <SectionHeading title={release.version} note={formatDate(release.date)} />

          <div className="flex flex-col">
            {release.entries.map((entry) => (
              <div
                key={entry.title}
                // Rows separated by a rule rather than wrapped in cards. A card
                // per entry inside a section is the box-in-box CLAUDE.md §3
                // rule 3 forbids.
                className="flex flex-col gap-1.5 border-b py-4 last:border-b-0 sm:flex-row sm:gap-4"
              >
                <div className="sm:w-24 sm:shrink-0 sm:pt-0.5">
                  <Badge variant={KIND_VARIANTS[entry.kind]}>{KIND_LABELS[entry.kind]}</Badge>
                </div>

                <div className="flex min-w-0 flex-col gap-1.5">
                  <h3 className="text-sm font-medium">{entry.title}</h3>
                  <p className="text-muted-foreground max-w-prose text-sm">{entry.body}</p>

                  {entry.reqs || entry.route || entry.guideStep ? (
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                      {entry.route ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            void navigate(entry.route ?? '/');
                          }}
                        >
                          Take me there
                          <ArrowRightIcon data-icon="inline-end" />
                        </Button>
                      ) : null}

                      {entry.guideStep ? (
                        // Reuses the main tour rather than a second registry of
                        // its own: the step already exists, already knows which
                        // route it lives on and already carries its permission,
                        // so "show me this" is "start there".
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            // Scope 'all', not 'page': the step lives on a
                            // different route than this one, so a page-scoped
                            // run would compose a guide for Updates instead.
                            armTour({ scope: 'all', fromStepId: entry.guideStep });
                          }}
                        >
                          <CompassIcon data-icon="inline-start" />
                          Show me
                        </Button>
                      ) : null}

                      {entry.reqs?.length ? (
                        <span className="text-muted-foreground font-mono text-xs">
                          {entry.reqs.join(', ')}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
