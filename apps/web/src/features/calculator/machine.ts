import {
  DISPLAY_DIGITS,
  ZERO,
  add,
  divide,
  fromText,
  isZero,
  multiply,
  negate,
  overflows,
  subtract,
  toDisplay,
  toText,
  typedDigitCount,
  type Decimal,
} from './decimal';

/**
 * The calculator itself (REQ-N-03), as a pure reducer.
 *
 * Nothing here touches React or the DOM, so the behaviour a person actually
 * complains about -- "it forgot my operand", "the tape is wrong", "0.1 + 0.2
 * printed something absurd" -- is testable without rendering anything.
 *
 * It behaves like a four-function desk calculator rather than an expression
 * evaluator: there is no precedence and no brackets, because `2 + 3 × 4` on a
 * Casio is 20 and anybody reaching for this expects the machine on their desk,
 * not a spreadsheet formula bar.
 */

export type Operator = 'add' | 'subtract' | 'multiply' | 'divide';

export const OPERATOR_SYMBOLS: Record<Operator, string> = {
  add: '+',
  subtract: '−',
  multiply: '×',
  divide: '÷',
};

export interface TapeLine {
  readonly id: number;
  /** The value as it was entered or computed. */
  readonly value: string;
  /** The key that produced the line: an operator symbol, `=`, or a memory key. */
  readonly marker: string;
  /** Totals are set apart from operands, as they are on a printed tape. */
  readonly total: boolean;
}

type NewLine = Omit<TapeLine, 'id'>;

export interface CalculatorState {
  /** What the display shows. Always the truth, error included. */
  readonly display: string;
  /** The digits typed so far, or null when the display holds a result. */
  readonly typing: string | null;
  readonly accumulator: Decimal;
  readonly pending: Operator | null;
  /** The last operator and operand, so pressing `=` again repeats it. */
  readonly repeat: { readonly operator: Operator; readonly operand: Decimal } | null;
  readonly memory: Decimal;
  readonly tape: readonly TapeLine[];
  /**
   * Set on divide-by-zero and on overflow. Every key except AC is ignored while
   * it holds, exactly as a physical calculator locks up until it is cleared --
   * the alternative is a machine that keeps computing from a value it has
   * already said is wrong.
   */
  readonly error: string | null;
  readonly nextLineId: number;
}

export type CalculatorAction =
  | { readonly kind: 'digit'; readonly digit: string }
  | { readonly kind: 'point' }
  | { readonly kind: 'operator'; readonly operator: Operator }
  | { readonly kind: 'equals' }
  | { readonly kind: 'percent' }
  | { readonly kind: 'gstAdd' }
  | { readonly kind: 'gstReverse' }
  | { readonly kind: 'sign' }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'clearEntry' }
  | { readonly kind: 'clearAll' }
  | { readonly kind: 'memoryAdd' }
  | { readonly kind: 'memorySubtract' }
  | { readonly kind: 'memoryRecall' }
  | { readonly kind: 'memoryClear' };

export const DIVIDE_BY_ZERO = 'Cannot divide by zero';
export const TOO_LARGE = 'Number too large';

/**
 * The GST keys of a desk calculator, at the single Indian rate this business
 * bills at (D-01 forbids money math elsewhere; this is the calculator, where a
 * figure is scratch, not a posted amount). 1.18 adds 18%, dividing by it strips
 * a tax already inside a figure.
 */
export const GST_MULTIPLIER = '1.18';

/** The tape is capped so a long session cannot grow the panel without bound. */
export const TAPE_LIMIT = 100;

export const INITIAL_STATE: CalculatorState = {
  display: '0',
  typing: null,
  accumulator: ZERO,
  pending: null,
  repeat: null,
  memory: ZERO,
  tape: [],
  error: null,
  nextLineId: 1,
};

/**
 * What a half-typed entry looks like on the display.
 *
 * An entry can legitimately be empty (everything backspaced) or a lone minus
 * (sign pressed before any digit), and neither is a number. A physical
 * calculator shows `0` and `-0`; the first version of this file showed the
 * empty string and a bare `-`, found by the fuzz in `machine.test.ts` rather
 * than by any case anybody thought to write.
 */
function displayFor(typing: string): string {
  if (typing === '') return '0';
  if (typing === '-') return '-0';
  return typing;
}

/** `.5` and `-.5` are legal to type but not to parse; `-` alone means nothing yet. */
function normaliseTyped(typing: string): string {
  const negative = typing.startsWith('-');
  const body = negative ? typing.slice(1) : typing;
  const filled = body === '' || body === '.' ? '0' : body.startsWith('.') ? `0${body}` : body;
  const trimmed = filled.endsWith('.') ? filled.slice(0, -1) : filled;
  return `${negative ? '-' : ''}${trimmed}`;
}

/** The value the display currently stands for. */
export function currentValue(state: CalculatorState): Decimal {
  return fromText(state.typing === null ? state.display : normaliseTyped(state.typing));
}

function appended(
  state: CalculatorState,
  lines: readonly NewLine[],
): Pick<CalculatorState, 'tape' | 'nextLineId'> {
  let nextLineId = state.nextLineId;
  const tape = [...state.tape];
  for (const line of lines) {
    tape.push({ ...line, id: nextLineId });
    nextLineId += 1;
  }
  return { tape: tape.slice(-TAPE_LIMIT), nextLineId };
}

function apply(operator: Operator, left: Decimal, right: Decimal): Decimal | null {
  switch (operator) {
    case 'add':
      return add(left, right);
    case 'subtract':
      return subtract(left, right);
    case 'multiply':
      return multiply(left, right);
    case 'divide':
      return divide(left, right);
  }
}

function failed(state: CalculatorState, message: string): CalculatorState {
  return { ...state, display: message, error: message, typing: null };
}

export function reduce(state: CalculatorState, action: CalculatorAction): CalculatorState {
  // AC is the only way out of an error, which is what makes the error mean
  // something: no half-cleared state can carry a wrong value forwards.
  if (state.error !== null && action.kind !== 'clearAll') return state;

  switch (action.kind) {
    case 'digit': {
      const typing = state.typing ?? '';
      if (typedDigitCount(typing) >= DISPLAY_DIGITS) return state;
      // A leading zero is replaced rather than appended, so 0 then 5 is 5.
      const next =
        typing === '0' ? action.digit : typing === '-0' ? `-${action.digit}` : typing + action.digit;
      return { ...state, typing: next, display: displayFor(next) };
    }

    case 'point': {
      const typing = state.typing ?? '0';
      if (typing.includes('.')) return state;
      const next = `${typing === '' || typing === '-' ? `${typing}0` : typing}.`;
      return { ...state, typing: next, display: displayFor(next) };
    }

    case 'sign': {
      if (state.typing !== null) {
        const next = state.typing.startsWith('-') ? state.typing.slice(1) : `-${state.typing}`;
        return { ...state, typing: next, display: displayFor(next) };
      }
      return { ...state, display: toDisplay(negate(currentValue(state))) };
    }

    case 'backspace': {
      // Only an entry being typed can be shortened. A result is not a string of
      // digits somebody put there, and rubbing a digit off one would produce a
      // number the tape above it does not explain.
      if (state.typing === null) return state;
      const next = state.typing.slice(0, -1);
      return { ...state, typing: next, display: displayFor(next) };
    }

    case 'clearEntry':
      return { ...state, typing: null, display: '0' };

    case 'clearAll':
      // Memory survives AC, as it does on a Casio: MC is its own key, and
      // losing a stored total to the key you press to start again is the single
      // most annoying thing a calculator can do.
      return { ...INITIAL_STATE, memory: state.memory, nextLineId: state.nextLineId };

    case 'percent': {
      // The iOS rule (owner, 23 Aug). Against a running + or −, the per cent is
      // OF the left operand and waits for = to be added or taken off, so
      // `100 + 10 %` holds 10 and `=` gives 110. Against × or ÷, or on its own,
      // it is a plain hundredth, so `5 × 20 %` holds 0.2 and `=` gives 1. The
      // pending operator and left operand (`accumulator`) are kept either way;
      // only the entry on the display is transformed, then held (typing = null).
      const entry = currentValue(state);
      const hundredth = divide(entry, fromText('100'), Math.max(entry.scale, 2) + 2);
      if (hundredth === null) return state;
      const value =
        state.pending === 'add' || state.pending === 'subtract'
          ? multiply(state.accumulator, hundredth)
          : hundredth;
      return { ...state, display: toDisplay(value), typing: null };
    }

    case 'gstAdd':
    case 'gstReverse': {
      // A physical calculator's tax keys: they act at once on the figure shown,
      // with no = to press. GST× multiplies by 1.18, GST÷ strips it. The figure
      // with (or without) tax is a fresh total, so any running sum is ended and
      // the next digit overwrites the display (typing = null, pending = null) --
      // exactly the reset a desk calculator does after its tax key.
      const entry = currentValue(state);
      const gst = fromText(GST_MULTIPLIER);
      const result =
        action.kind === 'gstAdd' ? multiply(entry, gst) : divide(entry, gst, Math.max(entry.scale, 2) + DISPLAY_DIGITS);
      if (result === null) return failed(state, DIVIDE_BY_ZERO);
      if (overflows(result)) return failed(state, TOO_LARGE);
      const marker = action.kind === 'gstAdd' ? '+GST' : '−GST';
      return {
        ...state,
        ...appended(state, [
          { value: toText(entry), marker, total: false },
          { value: toText(result), marker: '=', total: true },
        ]),
        display: toDisplay(result),
        typing: null,
        accumulator: result,
        pending: null,
        repeat: null,
      };
    }

    case 'operator': {
      const value = currentValue(state);
      const symbol = OPERATOR_SYMBOLS[action.operator];

      // Changing the operator before typing the next operand replaces it,
      // rather than computing something nobody asked for. The tape shows the
      // key that ended up being used, not the one pressed by mistake.
      if (state.pending !== null && state.typing === null) {
        const tape = state.tape.map((line, index) =>
          index === state.tape.length - 1 && !line.total ? { ...line, marker: symbol } : line,
        );
        return { ...state, pending: action.operator, tape };
      }

      if (state.pending === null) {
        return {
          ...state,
          ...appended(state, [{ value: toText(value), marker: symbol, total: false }]),
          accumulator: value,
          pending: action.operator,
          typing: null,
          repeat: null,
        };
      }

      const result = apply(state.pending, state.accumulator, value);
      if (result === null) return failed(state, DIVIDE_BY_ZERO);
      if (overflows(result)) return failed(state, TOO_LARGE);

      return {
        ...state,
        ...appended(state, [{ value: toText(value), marker: symbol, total: false }]),
        display: toDisplay(result),
        typing: null,
        accumulator: result,
        pending: action.operator,
        repeat: null,
      };
    }

    case 'equals': {
      const value = currentValue(state);

      if (state.pending === null && state.repeat === null) {
        // Nothing to fold: `=` on a bare entry just rules it off.
        return {
          ...state,
          ...appended(state, [{ value: toText(value), marker: '=', total: true }]),
          typing: null,
        };
      }

      const operator = state.pending ?? state.repeat?.operator;
      if (operator === undefined) return state;
      const left = state.pending === null ? value : state.accumulator;
      const right = state.pending === null ? (state.repeat?.operand ?? ZERO) : value;

      const result = apply(operator, left, right);
      if (result === null) return failed(state, DIVIDE_BY_ZERO);
      if (overflows(result)) return failed(state, TOO_LARGE);

      const lines: NewLine[] =
        state.pending === null
          ? [{ value: toText(result), marker: '=', total: true }]
          : [
              { value: toText(value), marker: '', total: false },
              { value: toText(result), marker: '=', total: true },
            ];

      return {
        ...state,
        ...appended(state, lines),
        display: toDisplay(result),
        typing: null,
        accumulator: result,
        pending: null,
        repeat: { operator, operand: right },
      };
    }

    case 'memoryAdd': {
      const value = currentValue(state);
      return {
        ...state,
        ...appended(state, [{ value: toText(value), marker: 'M+', total: false }]),
        memory: add(state.memory, value),
        typing: null,
      };
    }

    case 'memorySubtract': {
      const value = currentValue(state);
      return {
        ...state,
        ...appended(state, [{ value: toText(value), marker: 'M−', total: false }]),
        memory: subtract(state.memory, value),
        typing: null,
      };
    }

    case 'memoryRecall':
      return { ...state, display: toDisplay(state.memory), typing: null };

    case 'memoryClear':
      return { ...state, memory: ZERO };
  }
}

/** True when the M indicator on the display should be lit. */
export function hasMemory(state: CalculatorState): boolean {
  return !isZero(state.memory);
}
