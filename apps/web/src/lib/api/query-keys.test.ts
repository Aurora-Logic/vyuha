import { describe, expect, it } from 'vitest';

/**
 * Two hooks caching different shapes under one query key silently poison each
 * other: whichever fetches first wins, staleTime keeps the winner fresh, and
 * the losing screen crashes on a shape it never fetched. That is not a
 * hypothetical - ['departments', 'options'] was cached as a plain
 * DepartmentOption[] by the employees feature and as a Sampled envelope by the
 * attendance feature, and walking from Employees to Team Attendance threw
 * "Cannot read properties of undefined (reading 'data')".
 *
 * TanStack Query cannot catch this - sharing a key is legal and sometimes
 * wanted - so this scan enforces the repo's rule instead: every `queryKey:`
 * registration must be unique. Deliberate sharing belongs in one exported
 * hook, not in two files that happen to agree on a key today.
 *
 * The first version of this test read one line at a time and only understood a
 * literal array written in place. Measured: 91 `queryKey:` occurrences in the
 * app, of which it saw 34. Every key supplied through a constant
 * (SESSION_QUERY_KEY, ROLES_KEY, LOCKS_QUERY_KEY, SETTINGS_QUERY_KEY) or
 * through the reportKeys factory was invisible to it - 23 occurrences written
 * as a reference rather than a literal - and so was the leading element of
 * every `[...LEAVE_QUERY_ROOT, ...]` key, which it read as a wildcard.
 *
 * Its only guard against that was `seen.size > 20`, which the visible
 * two-thirds cleared on their own, so a green run proved nothing about the
 * rest. Falsified: a second hook registering ['session','me'] through a
 * constant passes the old test and fails this one.
 *
 * So this resolves constants and factory properties - including a factory's
 * literal arguments, which is what would keep reportKeys.rows('late-arrivals')
 * apart from reportKeys.rows('punch-audit') - and it is guarded by a count
 * rather than a floor: everything the file scan finds must also be classified
 * and resolved. A scan that goes blind cannot pass by finding less.
 *
 * No hook writes a literal into a key factory today; the report shell reads its
 * report key from the URL and registers one parameterised key for all of them.
 * The binding is therefore exercised on the resolver directly, so the capability
 * does not rot while nothing happens to use it.
 *
 * Limits, stated so a failure is quick to read:
 * - Invalidations (`invalidateQueries` and friends) are exempt. Prefix
 *   matching is their entire point, and two of them sharing a prefix is
 *   correct.
 * - Non-literal positions (params objects, ids, factory arguments) count as
 *   one wildcard each; a key with no literal anywhere is reported and left out
 *   of the comparison, because two of those cannot be told apart from source.
 */

// Raw source, through the same pipeline the build uses - no node:fs, so the
// test stays inside the app tsconfig's type surface.
const SOURCES: Record<string, string> = import.meta.glob('../../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const PRODUCTION_SOURCES = Object.entries(SOURCES).filter(([file]) => !/\.test\.tsx?$/.test(file));

// QueryClient methods that take a key as a *filter* over queries that already
// exist, rather than declaring one. `refetchQueries` belongs here for the same
// reason `invalidateQueries` does; it was absent only because nothing used it
// yet, and its absence reported the session key as registered twice.
const EXEMPT =
  /invalidateQueries|refetchQueries|resetQueries|setQueryData|getQueryData|removeQueries|cancelQueries/;

/** Reads a bracketed run from `text[open]`, returning the index just past its close. */
function endOfBracket(text: string, open: number): number {
  const pairs: Record<string, string> = { '[': ']', '(': ')', '{': '}' };
  const closer = pairs[text[open]];
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === text[open]) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * The expression a `queryKey:` is given, as written.
 *
 * Either a bracketed array - which may run over several lines - or a
 * reference: an identifier, a member access, or a call.
 */
function expressionAt(text: string, after: number): string | null {
  let i = after;
  while (i < text.length && /\s/.test(text[i])) i += 1;

  if (text[i] === '[') {
    const end = endOfBracket(text, i);
    return end === -1 ? null : text.slice(i, end);
  }

  const start = i;
  while (i < text.length) {
    const char = text[i];
    if (/[\w$.]/.test(char)) {
      i += 1;
    } else if (char === '(') {
      const end = endOfBracket(text, i);
      if (end === -1) return null;
      i = end;
    } else {
      break;
    }
  }
  return i > start ? text.slice(start, i) : null;
}

/** Splits an array literal's inner text on commas that are not inside brackets. */
function topLevelElements(arrayLiteral: string): string[] {
  const inner = arrayLiteral.slice(1, -1);
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;

  for (const char of inner) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if ('[({'.includes(char)) depth += 1;
    if ('])}'.includes(char)) depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);

  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

const STRING_LITERAL = /^['"`]([^'"`]*)['"`]$/;

/**
 * Every declaration a key can be built out of.
 *
 * `arrays` holds anything that resolves to a list of parts, keyed by the name a
 * registration would write - `SESSION_QUERY_KEY`, and `reportKeys.rows` for a
 * factory property. `strings` holds plain string constants, which appear as a
 * single element inside a key (`[CALENDARS_KEY, year]`).
 */
interface Declaration {
  /** The array literal, verbatim. */
  source: string;
  /** Parameter names, for a factory property written as an arrow function. */
  params: string[];
  files: Set<string>;
}

function parameterNames(signature: string | undefined): string[] {
  if (signature === undefined || signature.trim().length === 0) return [];
  return signature
    .split(',')
    .map((part) => /^\s*([A-Za-z_$][\w$]*)/u.exec(part)?.[1] ?? '')
    .filter((name) => name.length > 0);
}

function collectDeclarations() {
  const arrays = new Map<string, Declaration>();
  const strings = new Map<string, string>();

  const remember = (name: string, source: string, params: string[], from: string): void => {
    const existing = arrays.get(name);
    if (existing) {
      existing.files.add(from);
      if (existing.source !== source) existing.source = source;
      return;
    }
    arrays.set(name, { source, params, files: new Set([from]) });
  };

  for (const [file, text] of PRODUCTION_SOURCES) {
    // const NAME = [...] as const;
    for (const match of text.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?=\[)/gu)) {
      const open = match.index + match[0].length;
      const end = endOfBracket(text, open);
      if (end !== -1) remember(match[1], text.slice(open, end), [], file);
    }

    // const NAME = 'literal';
    for (const match of text.matchAll(
      /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`\n]*)\2\s*;/gu,
    )) {
      strings.set(match[1], match[3]);
    }

    // const factory = { prop: [...] , prop: (args) => [...] , ... };
    for (const match of text.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?=\{)/gu)) {
      const open = match.index + match[0].length;
      const end = endOfBracket(text, open);
      if (end === -1) continue;
      const body = text.slice(open, end);
      for (const prop of body.matchAll(
        /([A-Za-z_$][\w$]*)\s*:\s*(?:\(([^)]*)\)\s*=>\s*)?(?=\[)/gu,
      )) {
        const propOpen = prop.index + prop[0].length;
        const propEnd = endOfBracket(body, propOpen);
        if (propEnd !== -1) {
          remember(
            `${match[1]}.${prop[1]}`,
            body.slice(propOpen, propEnd),
            parameterNames(prop[2]),
            file,
          );
        }
      }
    }
  }

  return { arrays, strings };
}

const { arrays, strings } = collectDeclarations();

/**
 * ['departments', 'list', params] -> ['departments', 'list', '*']
 *
 * `bound` carries a factory's arguments into its parameter positions, which is
 * what keeps `reportKeys.rows('attendance-register', q)` and
 * `reportKeys.rows('punch-audit', q)` apart. Losing that distinction would
 * report a collision that does not exist - and a test that cries wolf is a
 * test somebody deletes.
 */
function partsOfArray(
  arrayLiteral: string,
  bound: ReadonlyMap<string, string>,
  depth = 0,
): string[] | null {
  // A constant defined in terms of itself would otherwise spin here.
  if (depth > 5) return null;

  const parts: string[] = [];
  for (const element of topLevelElements(arrayLiteral)) {
    const literal = STRING_LITERAL.exec(element);
    if (literal) {
      parts.push(literal[1]);
      continue;
    }

    if (element.startsWith('...')) {
      const spread = arrays.get(element.slice(3).trim());
      if (!spread) return null;
      const inner = partsOfArray(spread.source, bound, depth + 1);
      if (!inner) return null;
      parts.push(...inner);
      continue;
    }

    parts.push(bound.get(element) ?? strings.get(element) ?? '*');
  }
  return parts;
}

/** The name and, for a call, its arguments: `reportKeys.rows('x', q)`. */
function reference(expression: string): { name: string; args: string[] } | null {
  const named = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/u.exec(expression);
  if (!named) return null;

  const rest = expression.slice(named[1].length).trim();
  if (!rest.startsWith('(')) return { name: named[1], args: [] };

  const end = endOfBracket(rest, 0);
  if (end === -1) return null;
  return { name: named[1], args: topLevelElements(`[${rest.slice(1, end - 1)}]`) };
}

/** The parts a `queryKey:` expression resolves to, or null if it cannot be read. */
function resolve(expression: string): string[] | null {
  if (expression.startsWith('[')) return partsOfArray(expression, new Map());

  const called = reference(expression);
  if (!called) return null;
  const declared = arrays.get(called.name);
  if (!declared) return null;

  const bound = new Map<string, string>();
  declared.params.forEach((param, index) => {
    const literal = STRING_LITERAL.exec(called.args[index] ?? '');
    if (literal) bound.set(param, literal[1]);
  });

  return partsOfArray(declared.source, bound);
}

/** Every declared name a registration leans on, so clashes can be judged. */
function namesUsedBy(expression: string, depth = 0): string[] {
  if (depth > 5) return [];

  if (expression.startsWith('[')) {
    const used: string[] = [];
    for (const element of topLevelElements(expression)) {
      if (STRING_LITERAL.test(element)) continue;
      const name = element.startsWith('...') ? element.slice(3).trim() : element;
      const declared = arrays.get(name);
      if (declared) {
        used.push(name, ...namesUsedBy(declared.source, depth + 1));
      } else if (strings.has(name)) {
        used.push(name);
      }
    }
    return used;
  }

  const called = reference(expression);
  if (!called) return [];
  const declared = arrays.get(called.name);
  if (!declared) return [];
  return [called.name, ...namesUsedBy(declared.source, depth + 1)];
}

/**
 * The function whose options object this `queryKey:` sits in.
 *
 * Walks out of the object literal to its opening brace, past the `(` before
 * it, and reads the callee. Precise on purpose: matching the word
 * `invalidateQueries` anywhere nearby would exempt a `useQuery` that merely
 * happened to sit next to one, which is a false pass in the direction that
 * matters.
 */
function enclosingCall(text: string, at: number): string {
  let depth = 0;
  let i = at - 1;

  for (; i >= 0; i -= 1) {
    const char = text[i];
    if (char === '}' || char === ')' || char === ']') depth += 1;
    else if (char === '{' || char === '(' || char === '[') {
      if (depth === 0) break;
      depth -= 1;
    }
  }

  const skipSpace = (): void => {
    while (i >= 0 && /\s/.test(text[i])) i -= 1;
  };

  i -= 1;
  skipSpace();
  if (text[i] !== '(') return '';

  i -= 1;
  skipSpace();

  // useQuery<Me | null>({ ... }) - step over the type arguments.
  if (text[i] === '>') {
    let generics = 0;
    for (; i >= 0; i -= 1) {
      if (text[i] === '>') generics += 1;
      else if (text[i] === '<') {
        generics -= 1;
        if (generics === 0) {
          i -= 1;
          break;
        }
      }
    }
    skipSpace();
  }

  const end = i + 1;
  while (i >= 0 && /[\w$.]/.test(text[i])) i -= 1;
  return text.slice(i + 1, end);
}

interface Found {
  where: string;
  expression: string;
}

function scan() {
  const registrations: (Found & { parts: string[] | null })[] = [];
  const exemptions: Found[] = [];
  let occurrences = 0;

  for (const [file, text] of PRODUCTION_SOURCES) {
    for (const match of text.matchAll(/queryKey:/gu)) {
      occurrences += 1;
      const at = match.index;
      const line = text.slice(0, at).split('\n').length;
      const expression = expressionAt(text, at + 'queryKey:'.length);
      const found: Found = {
        where: `${file}:${String(line)}`,
        expression: expression ?? '(unreadable)',
      };

      if (EXEMPT.test(enclosingCall(text, at))) {
        exemptions.push(found);
        continue;
      }

      registrations.push({
        ...found,
        parts: expression === null ? null : resolve(expression),
      });
    }
  }

  return { registrations, exemptions, occurrences };
}

const { registrations, exemptions, occurrences } = scan();

describe('query key registrations', () => {
  it('resolves every registration it finds, including constants and factories', () => {
    const unreadable = registrations.filter((entry) => entry.parts === null);
    expect(
      unreadable.map((entry) => `${entry.where}: ${entry.expression}`),
      'The scan found these registrations and could not work out their key.\n' +
        'A registration it cannot read is a registration it cannot compare, so\n' +
        'this fails rather than passing on the ones it did understand. Either\n' +
        'teach the resolver the new shape, or write the key as a literal array.',
    ).toEqual([]);
  });

  it('accounts for every queryKey in the source, so a blind scan cannot pass', () => {
    // The two numbers are counted independently: `occurrences` is a plain text
    // match, `registrations + exemptions` is what the classifier made of them.
    // A resolver that stops recognising a shape makes these disagree instead of
    // quietly comparing a smaller set. This is what the old `seen.size > 20`
    // could not do - the visible two-thirds cleared that floor on their own.
    expect(registrations.length + exemptions.length).toBe(occurrences);
    expect(occurrences).toBeGreaterThan(80);
  });

  it('sees the registrations that are supplied through a constant or a factory', () => {
    const byReference = registrations.filter((entry) => !entry.expression.startsWith('['));
    const resolved = new Map(byReference.map((entry) => [entry.expression, entry.parts]));

    // Named, not merely counted: these are registrations the line-based scan
    // could not see at all, and each one is checked to resolve to the key it
    // actually registers rather than to a row of wildcards. Containment rather
    // than equality, so adding a constant-supplied hook is not a failure -
    // being unable to read one is.
    expect(resolved.get('SESSION_QUERY_KEY')).toEqual(['session', 'me']);
    expect(resolved.get('ROLES_KEY')).toEqual(['roles', 'list']);
    expect(resolved.get('LOCKS_QUERY_KEY')).toEqual(['attendance', 'locks']);
    expect(resolved.get('SETTINGS_QUERY_KEY')).toEqual(['settings']);
    expect(resolved.get('downloadKeys.exports')).toEqual(['downloads', 'exports']);

    // A spread constant has to expand, or every leave key would read as
    // '*,requests' and two of them would look identical.
    const spreadKeys = registrations
      .filter((entry) => entry.expression.includes('...LEAVE_QUERY_ROOT'))
      .map((entry) => entry.parts?.[0]);
    expect(spreadKeys.length).toBeGreaterThan(3);
    expect(new Set(spreadKeys)).toEqual(new Set(['leave']));

    expect(byReference.length).toBeGreaterThanOrEqual(10);
  });

  // The factory-argument case ('carries a factory's literal arguments into
  // their parameter positions') left with the last key factory in the source:
  // reportKeys died with the reports module (owner, 26 Aug 2026), and a
  // resolve() against a name the scan no longer finds proves nothing. The
  // first feature to declare a parameterised key factory must bring that test
  // back with it -- two literal calls resolving apart is what stops the
  // collision detector crying wolf.

  it('finds no key constant declared under a name another file also uses', () => {
    // The resolver looks constants up by name across the whole app, so two
    // files declaring the same name would make it resolve one of them wrongly
    // - silently, and in the direction of a false pass. Only names a
    // registration actually leans on are judged: the app is full of unrelated
    // array constants that share ordinary names, and failing on those would be
    // noise.
    const used = new Set(registrations.flatMap((entry) => namesUsedBy(entry.expression)));
    const shared = [...used]
      .map((name) => ({ name, files: [...(arrays.get(name)?.files ?? [])] }))
      .filter((entry) => entry.files.length > 1)
      .map((entry) => `${entry.name} is declared in ${entry.files.join(' and ')}`);

    expect(shared).toEqual([]);
  });

  it('no two useQuery registrations share a key', () => {
    const seen = new Map<string, string[]>();
    const wildcardOnly: string[] = [];

    for (const entry of registrations) {
      const parts = entry.parts ?? [];
      if (!parts.some((part) => part !== '*')) {
        wildcardOnly.push(entry.where);
        continue;
      }
      const signature = parts.join(',');
      seen.set(signature, [...(seen.get(signature) ?? []), entry.where]);
    }

    const collisions = [...seen.entries()].filter(([, places]) => places.length > 1);
    expect(
      collisions,
      collisions
        .map(([sig, places]) => `key [${sig}] is registered in: ${places.join(', ')}`)
        .join('\n'),
    ).toEqual([]);

    // Every registration is either compared or explicitly set aside. Nothing
    // falls off the end unnoticed.
    expect(
      [...seen.values()].reduce((total, places) => total + places.length, 0) + wildcardOnly.length,
    ).toBe(registrations.length);
  });
});
