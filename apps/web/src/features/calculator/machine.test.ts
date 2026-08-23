import { describe, expect, it } from 'vitest';

import { toText } from './decimal';
import {
  DIVIDE_BY_ZERO,
  INITIAL_STATE,
  TAPE_LIMIT,
  TOO_LARGE,
  hasMemory,
  reduce,
  type CalculatorAction,
  type CalculatorState,
} from './machine';

/**
 * Drives the machine the way a person does: as a string of keys.
 *
 * `0-9 . + - * / = % ~ C A < m p q r` map to the keypad. Writing the tests
 * against key sequences rather than actions is deliberate -- a bug in the
 * mapping from a keypress to an action is a bug a person would hit, and an
 * action-level test would never see it.
 */
function press(keys: string, from: CalculatorState = INITIAL_STATE): CalculatorState {
  let state = from;
  for (const key of keys) {
    state = reduce(state, actionFor(key));
  }
  return state;
}

function actionFor(key: string): CalculatorAction {
  if (/^\d$/u.test(key)) return { kind: 'digit', digit: key };
  switch (key) {
    case '.':
      return { kind: 'point' };
    case '+':
      return { kind: 'operator', operator: 'add' };
    case '-':
      return { kind: 'operator', operator: 'subtract' };
    case '*':
      return { kind: 'operator', operator: 'multiply' };
    case '/':
      return { kind: 'operator', operator: 'divide' };
    case '=':
      return { kind: 'equals' };
    case '%':
      return { kind: 'percent' };
    case 'g':
      return { kind: 'gstAdd' };
    case 'G':
      return { kind: 'gstReverse' };
    case '~':
      return { kind: 'sign' };
    case '<':
      return { kind: 'backspace' };
    case 'C':
      return { kind: 'clearEntry' };
    case 'A':
      return { kind: 'clearAll' };
    case 'p':
      return { kind: 'memoryAdd' };
    case 'q':
      return { kind: 'memorySubtract' };
    case 'r':
      return { kind: 'memoryRecall' };
    case 'm':
      return { kind: 'memoryClear' };
    default:
      throw new Error(`No key "${key}"`);
  }
}

describe('arithmetic through the keypad', () => {
  it('gives 0.3 for 0.1 + 0.2', () => {
    expect(press('.1+.2=').display).toBe('0.3');
  });

  it('gives 3.3 for 1.1 * 3', () => {
    expect(press('1.1*3=').display).toBe('3.3');
  });

  it('chains left to right with no precedence, as a desk calculator does', () => {
    // 2 + 3 = 5, then 5 x 4 = 20. A parser with precedence would say 14.
    expect(press('2+3*4=').display).toBe('20');
  });

  it('folds the running total as each operator is pressed', () => {
    expect(press('2+3*').display).toBe('5');
  });

  it('repeats the last operation on a second equals', () => {
    expect(press('2+3=').display).toBe('5');
    expect(press('2+3==').display).toBe('8');
    expect(press('2+3===').display).toBe('11');
  });

  it('starts a new calculation from a result', () => {
    expect(press('2+3=*2=').display).toBe('10');
  });
});

describe('entry', () => {
  it('replaces the leading zero rather than appending to it', () => {
    expect(press('05').display).toBe('5');
  });

  it('opens a bare decimal with a zero', () => {
    expect(press('.5').display).toBe('0.5');
  });

  it('takes only one decimal point', () => {
    expect(press('1.2.3').display).toBe('1.23');
  });

  it('stops at the width of the display', () => {
    expect(press('1234567890123456').display).toBe('123456789012');
  });

  it('counts digits, not characters, towards that limit', () => {
    expect(press('1.2345678901234').display).toBe('1.23456789012');
  });

  it('backspaces an entry down to zero', () => {
    expect(press('123<<').display).toBe('1');
    expect(press('123<<<').display).toBe('0');
  });

  it('will not backspace a result, which is not something anybody typed', () => {
    // Rubbing a digit off a total would leave a number the tape above it does
    // not explain.
    expect(press('2+3=<').display).toBe('5');
  });

  it('toggles the sign of an entry and of a result', () => {
    expect(press('5~').display).toBe('-5');
    expect(press('5~~').display).toBe('5');
    expect(press('2+3=~').display).toBe('-5');
  });

  it('keeps the sign while more digits arrive', () => {
    expect(press('5~0').display).toBe('-50');
  });

  it('never shows a bare minus or an empty display', () => {
    // Found by the fuzz below, not by anybody writing the case: backspacing an
    // entry to nothing and then pressing ± showed "-", which is not a number
    // and is not something a calculator has ever displayed.
    expect(press('5<~').display).toBe('-0');
    expect(press('5<~<').display).toBe('0');
    expect(press('5~<').display).toBe('-0');
    expect(press('5<').display).toBe('0');
  });
});

describe('per cent', () => {
  it('divides a standalone entry by a hundred', () => {
    expect(press('50%').display).toBe('0.5');
  });

  it('is exact for a value a double would mangle', () => {
    expect(press('4.35%').display).toBe('0.0435');
  });

  // The iOS rule: against + or −, the per cent is OF the left operand and waits
  // for =; against × or ÷, or alone, it is a plain hundredth.
  it('adds a percentage of the left operand: 100 + 10% = 110', () => {
    expect(press('100+10%=').display).toBe('110');
  });

  it('subtracts a percentage of the left operand: 200 − 10% = 180', () => {
    expect(press('200-10%=').display).toBe('180');
  });

  it('holds the percentage until equals, not folding the + early', () => {
    expect(press('100+10%').display).toBe('10');
  });

  it('is a plain hundredth against ×: 5 × 20% = 1', () => {
    expect(press('5*20%=').display).toBe('1');
  });

  it('is a plain hundredth against ÷: 200 ÷ 50% = 400', () => {
    expect(press('200/50%=').display).toBe('400');
  });
});

describe('GST keys', () => {
  it('adds 18% at once, no equals: 100 becomes 118', () => {
    expect(press('100g').display).toBe('118');
  });

  it('strips 18% at once: 118 becomes 100', () => {
    expect(press('118G').display).toBe('100');
  });

  it('is exact where a double would drift: 1000 → 1180 → 1000', () => {
    expect(press('1000g').display).toBe('1180');
    expect(press('1180G').display).toBe('1000');
  });

  it('ends the running sum and overwrites on the next digit', () => {
    const afterGst = press('50+100g');
    // The + is abandoned; 100 with tax stands alone.
    expect(afterGst.display).toBe('118');
    expect(afterGst.pending).toBeNull();
    // The next digit starts a fresh number rather than appending to 118.
    expect(press('7', afterGst).display).toBe('7');
  });
});

describe('clearing', () => {
  it('CE drops the entry and keeps the pending operation', () => {
    expect(press('9+7C4=').display).toBe('13');
  });

  it('AC drops everything', () => {
    const state = press('9+7A');
    expect(state.display).toBe('0');
    expect(state.pending).toBeNull();
    expect(state.tape).toHaveLength(0);
  });

  it('AC keeps the memory, because MC is its own key', () => {
    const state = press('5pA');
    expect(hasMemory(state)).toBe(true);
    expect(press('r', state).display).toBe('5');
  });
});

describe('errors', () => {
  it('refuses to divide by zero and says so on the display', () => {
    const state = press('5/0=');
    expect(state.display).toBe(DIVIDE_BY_ZERO);
    expect(state.error).toBe(DIVIDE_BY_ZERO);
  });

  it('ignores every key except AC while an error stands', () => {
    // A calculator that keeps computing from a value it has already called
    // wrong is worse than one that stops.
    const errored = press('5/0=');
    expect(press('123+9=', errored).display).toBe(DIVIDE_BY_ZERO);
    expect(press('A', errored).display).toBe('0');
  });

  it('reports an overflow rather than printing an unreadable number', () => {
    const state = press('999999999999*999999999999=');
    expect(state.display).toBe(TOO_LARGE);
    expect(state.error).toBe(TOO_LARGE);
  });
});

describe('memory', () => {
  it('accumulates and recalls', () => {
    expect(press('5p3pr').display).toBe('8');
  });

  it('subtracts', () => {
    expect(press('5p3qr').display).toBe('2');
  });

  it('clears', () => {
    const state = press('5pm');
    expect(hasMemory(state)).toBe(false);
    expect(press('r', state).display).toBe('0');
  });

  it('is exact', () => {
    expect(press('.1p.2pr').display).toBe('0.3');
  });

  it('lights the indicator only while something is stored', () => {
    expect(hasMemory(INITIAL_STATE)).toBe(false);
    expect(hasMemory(press('5p'))).toBe(true);
    expect(hasMemory(press('5p5q'))).toBe(false);
  });
});

describe('the tape', () => {
  it('prints each operand against the key that followed it, then the total', () => {
    const state = press('12+8=');
    expect(state.tape.map((line) => `${line.value}${line.marker}`)).toEqual(['12+', '8', '20=']);
  });

  it('marks only the total as a total', () => {
    const state = press('12+8=');
    expect(state.tape.filter((line) => line.total).map((line) => line.value)).toEqual(['20']);
  });

  it('shows the operator that was used, not the one pressed by mistake', () => {
    const state = press('12+*3=');
    expect(state.tape.map((line) => `${line.value}${line.marker}`)).toEqual(['12×', '3', '36=']);
  });

  it('gives every line a distinct id, so React keys cannot collide', () => {
    const state = press('1+2+3+4=');
    expect(new Set(state.tape.map((line) => line.id)).size).toBe(state.tape.length);
  });

  it('does not grow without bound', () => {
    let state = INITIAL_STATE;
    for (let i = 0; i < TAPE_LIMIT + 20; i += 1) state = press('1=', state);
    expect(state.tape.length).toBeLessThanOrEqual(TAPE_LIMIT);
  });
});

describe('under a hammering', () => {
  it('never throws and never shows something it cannot read back', () => {
    // The display is parsed back on the next keypress, so a state that prints
    // something `fromText` refuses would take the screen into the error
    // boundary. A fixed pseudo-random walk is cheap and reaches the sequences
    // nobody thinks to write a case for: "-", ".", backspace to empty, sign on
    // a result, equals with nothing pending.
    const keys = '0123456789.+-*/=%~<CA pqrm'.replaceAll(' ', '');
    let seed = 20260815;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };

    let state = INITIAL_STATE;
    for (let i = 0; i < 20_000; i += 1) {
      const key = keys[next() % keys.length] ?? '0';
      state = reduce(state, actionFor(key));
      if (state.error !== null) continue;
      expect(() => toText({ units: 0n, scale: 0 })).not.toThrow();
      expect(state.display).toMatch(/^-?(?:\d+\.?\d*|\.\d+|\d*\.)$/u);
    }
  });
});

describe('the value the panel copies out', () => {
  it('is the plain decimal, with no separators a field would reject', () => {
    const state = press('1234.5+1=');
    expect(state.display).toBe('1235.5');
    expect(toText({ units: 12355n, scale: 1 })).toBe('1235.5');
  });
});
