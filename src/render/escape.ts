// The one HTML escape (convention attribute-escaping-total): every character of the class
// [&<>"'] becomes its numeric character reference, in text and in attribute values alike.
// Both HTML surfaces, the rendered page (html.ts) and the served pages (server.ts), use
// this; no other escape exists in src (test/serve.test.ts, attribute-escaping-total).
export const esc = (s: string): string => s.replace(/[<>"']/g, (c) => `&#${c.codePointAt(0)};`);
