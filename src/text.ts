// A value from a payload, as text for a message or the page: strings as they are,
// anything else as JSON, never "[object Object]".
export const show = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v) ?? "undefined");

// An actor name as it reads on the page: any casing or spacing, invisible characters,
// accents, and the common lookalike letters (Cyrillic а/і/т, Turkish ı, Greek ι/α/τ) fold
// to one form, so two names that look the same compare equal.
const LOOKALIKE: Record<string, string> = {
  "а": "a", "с": "c", "е": "e", "і": "i", "о": "o", "р": "p", "т": "t", "х": "x", "һ": "h", "ԁ": "d", // Cyrillic
  "ı": "i", "ι": "i", "α": "a", "τ": "t", "ο": "o", "ρ": "p", "ε": "e", "η": "h", // Turkish, Greek
};
export const skeleton = (s: string): string =>
  [...s.normalize("NFKD").replace(/[\p{M}\p{Cf}\p{Cc}\s]/gu, "").toLowerCase()].map((c) => LOOKALIKE[c] ?? c).join("");
