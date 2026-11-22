/** Canonical ISBN-13. Formatting is tolerated; invalid checksums and work keys are rejected. */
export function canonicalIsbn(value: string): string | null {
  const digits = value.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{9}[\dX]$/.test(digits)) {
    const sum = [...digits].reduce((total, digit, i) => total + (digit === "X" ? 10 : Number(digit)) * (10 - i), 0);
    if (sum % 11) return null;
    const prefix = `978${digits.slice(0, 9)}`;
    const total = [...prefix].reduce((sum, digit, i) => sum + Number(digit) * (i % 2 ? 3 : 1), 0);
    return prefix + (10 - total % 10) % 10;
  }
  if (!/^97[89]\d{10}$/.test(digits)) return null;
  return [...digits].reduce((sum, digit, i) => sum + Number(digit) * (i % 2 ? 3 : 1), 0) % 10 === 0 ? digits : null;
}
