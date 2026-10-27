// Files people add (Isha, 2026-10-26: "in comments allow pdf/ image/ file upload", and a screenshot or
// any file as proof of work that isn't code). The bytes are kept in tira's private store, beside the
// accounts (src/sync/credentials.ts), never in the log; a comment, or a task's proof, names each file
// by its id, with its name, type and size, which is all the log keeps. Pure: names in, types out.

export const MAX_FILE = 5 * 1024 * 1024; // 5 MB a file
export const MAX_FILES = 5; // to a comment
export const FILE_ID = /^[0-9a-f]{24}$/;
export const FILE_REF = /^file:([0-9a-f]{24})$/; // a task's proof, when it's a file

// The kinds of file tira keeps, by their name's ending: pictures, PDFs, text and office documents.
// Never a page or a script (no .html, .svg or .js): a file is only ever downloaded or shown as itself.
export const FILE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};
const KNOWN = new Set(Object.values(FILE_TYPES));
export const isFileType = (t: string) => KNOWN.has(t);
export const isImage = (t: string) => t.startsWith("image/");
// shown in the page itself (a picture, a PDF); anything else is downloaded
export const showsInline = (t: string) => isImage(t) || t === "application/pdf";

export interface FileMeta { id: string; name: string; type: string; size: number }

// a file's name as kept: its last part only, nothing unseen, at most 120 characters
export function cleanName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? "";
  return last.replaceAll(/\p{Cc}/gu, "").trim().slice(-120);
}
// its type, by its name's ending (undefined: not a kind tira keeps)
export function fileTypeOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? undefined : FILE_TYPES[name.slice(dot + 1).toLowerCase()];
}
export const fileMetaOk = (f: unknown): f is FileMeta => {
  if (typeof f !== "object" || f === null) return false;
  const { id, name, type, size } = f as Record<string, unknown>;
  return typeof id === "string" && FILE_ID.test(id) && typeof name === "string" && name !== "" && name === cleanName(name)
    && typeof type === "string" && isFileType(type) && typeof size === "number" && Number.isInteger(size) && size >= 0 && size <= MAX_FILE;
};
export function sizeSaid(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round(n / 104_857.6) / 10} MB`; // to a tenth
}
