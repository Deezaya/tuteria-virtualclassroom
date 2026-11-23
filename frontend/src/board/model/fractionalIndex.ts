/**
 * Fractional index keys for z-order. A key sorts between two others with
 * plain string comparison, so an item can be placed anywhere without
 * renumbering the rest.
 *
 * Follows the public-domain algorithm by David Greenspan ("Implementing
 * Fractional Indexing", also published as the fractional-indexing package):
 * an integer part whose first character encodes its length, then a
 * fraction with no trailing zero.
 */
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS[0];
const SMALLEST_INTEGER = "A" + ZERO.repeat(26);

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  throw new Error(`Invalid order key head: ${head}`);
}

function integerPart(key: string): string {
  const length = integerLength(key[0]);
  if (length > key.length) throw new Error(`Invalid order key: ${key}`);
  return key.slice(0, length);
}

function validate(key: string): void {
  if (key === SMALLEST_INTEGER) throw new Error(`Invalid order key: ${key}`);
  const integer = integerPart(key);
  if (key.slice(integer.length).endsWith(ZERO)) {
    throw new Error(`Invalid order key: ${key}`);
  }
}

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

function increment(integer: string): string | null {
  const [head, ...digits] = integer.split("");
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i -= 1) {
    const d = DIGITS.indexOf(digits[i]) + 1;
    if (d === DIGITS.length) {
      digits[i] = ZERO;
    } else {
      digits[i] = DIGITS[d];
      carry = false;
    }
  }
  if (!carry) return head + digits.join("");
  if (head === "Z") return "a" + ZERO;
  if (head === "z") return null;
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (next > "a") digits.push(ZERO);
  else digits.pop();
  return next + digits.join("");
}

function decrement(integer: string): string | null {
  const [head, ...digits] = integer.split("");
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i -= 1) {
    const d = DIGITS.indexOf(digits[i]) - 1;
    if (d === -1) {
      digits[i] = DIGITS[DIGITS.length - 1];
    } else {
      digits[i] = DIGITS[d];
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join("");
  if (head === "a") return "Z" + DIGITS[DIGITS.length - 1];
  if (head === "A") return null;
  const next = String.fromCharCode(head.charCodeAt(0) - 1);
  if (next < "Z") digits.push(DIGITS[DIGITS.length - 1]);
  else digits.pop();
  return next + digits.join("");
}

/** Returns a key that sorts after `a` and before `b`. Null means no bound. */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) validate(a);
  if (b !== null) validate(b);
  if (a !== null && b !== null && a >= b) {
    throw new Error(`Order keys out of order: ${a} >= ${b}`);
  }
  if (a === null) {
    if (b === null) return "a" + ZERO;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint("", fb);
    if (ib < b) return ib;
    const lower = decrement(ib);
    if (lower === null) throw new Error("Cannot place before the first key.");
    return lower;
  }
  if (b === null) {
    const ia = integerPart(a);
    const higher = increment(ia);
    return higher === null ? ia + midpoint(a.slice(ia.length), null) : higher;
  }
  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const higher = increment(ia);
  if (higher === null) throw new Error("Cannot place after the last key.");
  if (higher < b) return higher;
  return ia + midpoint(fa, null);
}

/** True when `key` can be used with keyBetween. */
export function isValidKey(key: string): boolean {
  try {
    validate(key);
    return true;
  } catch {
    return false;
  }
}
