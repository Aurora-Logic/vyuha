import { PIVOT_METRICS, type PivotMetric } from '@vyuha/shared';

/**
 * S1.2: calculated fields are expressions over registered measures only --
 * never raw SQL, never a table name. The grammar is four operators and
 * parentheses; units are checked (adding money to a count is refused, a
 * money÷money ratio renders as a percentage); and division is guarded:
 * a cell whose denominator is zero is null, never Infinity and never a
 * silent zero.
 */

export type ExprUnit = 'money' | 'count' | 'ratio';

export type ExprNode =
  | { kind: 'measure'; measure: PivotMetric }
  | { kind: 'number'; value: number }
  | { kind: 'op'; op: '+' | '-' | '*' | '/'; left: ExprNode; right: ExprNode };

const MEASURE_UNITS: Record<PivotMetric, 'money' | 'count'> = {
  net: 'money',
  gross: 'money',
  discount: 'money',
  returns: 'money',
  landed: 'money',
  margin: 'money',
  qty: 'count',
  vouchers: 'count',
};

export class ExprError extends Error {}

type Token = { t: 'measure'; v: PivotMetric } | { t: 'number'; v: number } | { t: 'op'; v: '+' | '-' | '*' | '/' } | { t: '(' } | { t: ')' };

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const src = input.trim();
  if (src.length === 0) throw new ExprError('The expression is empty.');
  if (src.length > 200) throw new ExprError('The expression is too long.');
  while (i < src.length) {
    const c = src[i] ?? '';
    if (/\s/u.test(c)) { i += 1; continue; }
    if (c === '(') { out.push({ t: '(' }); i += 1; continue; }
    if (c === ')') { out.push({ t: ')' }); i += 1; continue; }
    if (c === '+' || c === '-' || c === '*' || c === '/') { out.push({ t: 'op', v: c }); i += 1; continue; }
    const num = /^\d+(\.\d+)?/u.exec(src.slice(i));
    if (num) { out.push({ t: 'number', v: Number(num[0]) }); i += num[0].length; continue; }
    const word = /^[a-z_]+/u.exec(src.slice(i));
    if (word) {
      const name = word[0];
      if (!(PIVOT_METRICS as readonly string[]).includes(name)) {
        throw new ExprError(`"${name}" is not a registered measure. The measures are: ${PIVOT_METRICS.join(', ')}.`);
      }
      out.push({ t: 'measure', v: name as PivotMetric });
      i += name.length;
      continue;
    }
    throw new ExprError(`Unexpected character "${c}".`);
  }
  return out;
}

/** expr := term (('+'|'-') term)* ; term := factor (('*'|'/') factor)* ; factor := number | measure | '(' expr ')' */
export function parseExpression(input: string): ExprNode {
  const tokens = tokenize(input);
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const take = (): Token => {
    const token = tokens[pos];
    if (token === undefined) throw new ExprError('The expression ends unexpectedly.');
    pos += 1;
    return token;
  };
  const factor = (): ExprNode => {
    const token = take();
    if (token.t === 'number') return { kind: 'number', value: token.v };
    if (token.t === 'measure') return { kind: 'measure', measure: token.v };
    if (token.t === '(') {
      const inner = expr();
      const close = take();
      if (close.t !== ')') throw new ExprError('A bracket is never closed.');
      return inner;
    }
    throw new ExprError('Expected a measure, a number, or a bracket.');
  };
  const term = (): ExprNode => {
    let left = factor();
    while (peek()?.t === 'op' && ((peek() as { v: string }).v === '*' || (peek() as { v: string }).v === '/')) {
      const op = (take() as { t: 'op'; v: '*' | '/' }).v;
      left = { kind: 'op', op, left, right: factor() };
    }
    return left;
  };
  const expr = (): ExprNode => {
    let left = term();
    while (peek()?.t === 'op' && ((peek() as { v: string }).v === '+' || (peek() as { v: string }).v === '-')) {
      const op = (take() as { t: 'op'; v: '+' | '-' }).v;
      left = { kind: 'op', op, left, right: term() };
    }
    return left;
  };
  const tree = expr();
  if (pos !== tokens.length) throw new ExprError('The expression has trailing content.');
  // Parsing includes the unit check: a shape that cannot mean anything is
  // refused here, not discovered cell by cell.
  unitOf(tree);
  return tree;
}

export function measuresOf(node: ExprNode): PivotMetric[] {
  if (node.kind === 'measure') return [node.measure];
  if (node.kind === 'number') return [];
  return [...new Set([...measuresOf(node.left), ...measuresOf(node.right)])];
}

/** Unit algebra: same-unit ± keeps the unit; ÷ of like units is a ratio; a number scales anything. */
export function unitOf(node: ExprNode): ExprUnit | 'number' {
  if (node.kind === 'number') return 'number';
  if (node.kind === 'measure') return MEASURE_UNITS[node.measure];
  const left = unitOf(node.left);
  const right = unitOf(node.right);
  if (node.op === '+' || node.op === '-') {
    if (left === right) return left;
    throw new ExprError(`Adding ${left} to ${right} has no unit. Divide instead, or keep like measures together.`);
  }
  if (node.op === '*') {
    if (left === 'number') return right;
    if (right === 'number') return left;
    throw new ExprError('Multiplying two measures has no unit here; scale by a number instead.');
  }
  // Division.
  if (right === 'number') return left;
  if (left === right) return 'ratio';
  if (left === 'money' && right === 'count') return 'money';
  throw new ExprError(`Dividing ${left} by ${right} has no unit here.`);
}

/** Evaluate over one cell's measure sums; null wherever a guard trips (Q1.2's honest hole). */
export function evaluate(node: ExprNode, values: Partial<Record<PivotMetric, number | null>>): number | null {
  if (node.kind === 'number') return node.value;
  if (node.kind === 'measure') {
    const v = values[node.measure];
    return v === undefined || v === null ? null : v;
  }
  const left = evaluate(node.left, values);
  const right = evaluate(node.right, values);
  if (left === null || right === null) return null;
  switch (node.op) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    case '/': return right === 0 ? null : left / right;
  }
}
