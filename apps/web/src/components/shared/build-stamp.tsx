import { buildInfo, buildLabel } from '@/lib/build-info';
import { formatDate } from '@/lib/format';

/**
 * The line that answers "what are you running".
 *
 * It sits on the updates screen because that is where someone already goes to
 * ask what changed, and the next question is always which of it they have.
 * Before this, nothing in the product could say: every package.json read
 * 0.0.0, the changelog named its own version, and the one git tag named a
 * third. A support conversation began with a guess.
 *
 * Selectable text, not a badge: the point is that it can be copied into a bug
 * report.
 */
export function BuildStamp() {
  const { builtAt, commit } = buildInfo();
  return (
    <p className="text-muted-foreground -mt-2 font-mono text-xs">
      <span className="select-all">{buildLabel()}</span>
      {builtAt === null ? null : (
        <>
          {' · built '}
          {formatDate(builtAt.toISOString().slice(0, 10))}
        </>
      )}
      {commit === 'dev' ? ' · development build' : null}
    </p>
  );
}
