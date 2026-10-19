// A value from a payload, as text for a message or the page: strings as they are,
// anything else as JSON, never "[object Object]".
export const show = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v) ?? "undefined");
