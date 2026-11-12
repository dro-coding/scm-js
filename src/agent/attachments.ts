/**
 * Files the user attaches to a message for Claude: pictures, PDFs and text, turned into the
 * content blocks the Messages API reads.
 *
 * - Pictures (PNG, JPEG, GIF, WebP) go as image blocks. One longer than `IMAGE_EDGE` on a
 *   side is scaled down first in the browser: Claude sees no more detail past that, and the
 *   smaller picture costs fewer tokens on every later request of the conversation.
 * - PDFs go as document blocks.
 * - Anything that reads as text goes as a plain-text document titled with the file's name.
 *   UTF-8 first; a file that is not (a TrigEdit export in the map's own code page) is read
 *   as Latin-1, as Import Triggers reads it.
 * - A `.trg` (TRIG records, SCMDraft's binary trigger export) is printed as TrigEdit text
 *   against the open map, with a note that its strings are this map's.
 * - Map files and other binary files are refused with the reason.
 *
 * The history is append-only, so every attachment is sent again with each later request
 * (cached, but still bytes on the wire); `MAX_CONVERSATION_BYTES` keeps a conversation
 * under the API's request size.
 */
import type { BetaContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
export type AttachmentKind = "image" | "pdf" | "text";

export interface Attachment {
  name: string;
  kind: AttachmentKind;
  /** The picked file's size in bytes. */
  size: number;
  mediaType: ImageType | "application/pdf" | "text/plain";
  /** Base64 for a picture or a PDF; the text itself for text. */
  data: string;
  /** What Claude should know about the file before reading it (what a .trg was printed from). */
  note?: string;
}

/** What one file may be, and what one conversation may carry in all. */
export const MAX_FILES = 10;
export const IMAGE_EDGE = 1568;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_CHARS = 400_000;
export const MAX_CONVERSATION_BYTES = 24 * 1024 * 1024;

export class AttachmentError extends Error {}

/** The parts of a `File` this reads, so a test can hand in a stand-in. */
export interface PickedFile {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ReadOptions {
  /** Scales a picture to fit `IMAGE_EDGE`; null leaves it as it is. The browser's is `scaleInBrowser`. */
  scale?: (bytes: Uint8Array, type: ImageType) => Promise<{ bytes: Uint8Array; type: ImageType } | null>;
  /** Prints TRIG records as TrigEdit text against the open map; without it a .trg is refused. */
  trgToText?: (bytes: Uint8Array) => string;
}

const TRIGGER_RECORD = 2400;
const MAP_EXTENSIONS = /\.(scm|scx|chk)$/i;

export function extensionOf(name: string): string {
  const m = /\.([^.\\/]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

function imageTypeOf(name: string, type: string): ImageType | null {
  if ((IMAGE_TYPES as readonly string[]).includes(type)) return type as ImageType;
  const ext = extensionOf(name);
  return ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : null;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Text when the bytes read as text: UTF-8, else Latin-1 when nothing in them looks binary. */
export function decodeText(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, 8192);
  let control = 0;
  for (const b of head) {
    if (b === 0) return null;
    if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) control++;
  }
  // A few control bytes are StarCraft's colour codes; many mean a binary file.
  if (control > head.length / 20) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/** One picked file as an attachment, or an `AttachmentError` saying why it cannot go. */
export async function readAttachment(file: PickedFile, options: ReadOptions = {}): Promise<Attachment> {
  const { name } = file;
  if (MAP_EXTENSIONS.test(name)) {
    throw new AttachmentError(`${name}: a map file cannot go to Claude. Open it in the editor (File ▸ Open) and ask about it there.`);
  }
  const image = imageTypeOf(name, file.type);
  if (image) {
    let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
    let type = image;
    const scaled = options.scale ? await options.scale(bytes, type) : null;
    if (scaled) ({ bytes, type } = scaled);
    if (bytes.length > MAX_IMAGE_BYTES) throw new AttachmentError(`${name}: the picture is ${mb(bytes.length)}; Claude takes up to ${mb(MAX_IMAGE_BYTES)}.`);
    return { name, kind: "image", size: file.size, mediaType: type, data: toBase64(bytes) };
  }
  if (file.type === "application/pdf" || extensionOf(name) === "pdf") {
    if (file.size > MAX_PDF_BYTES) throw new AttachmentError(`${name}: the PDF is ${mb(file.size)}; Claude takes up to ${mb(MAX_PDF_BYTES)}.`);
    return { name, kind: "pdf", size: file.size, mediaType: "application/pdf", data: toBase64(new Uint8Array(await file.arrayBuffer())) };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (extensionOf(name) === "trg") {
    if (!options.trgToText) throw new AttachmentError(`${name}: a .trg needs an open map to be read against.`);
    if (bytes.length === 0 || bytes.length % TRIGGER_RECORD !== 0) {
      throw new AttachmentError(`${name}: not a trigger file (${bytes.length} bytes is not a whole number of ${TRIGGER_RECORD}-byte records).`);
    }
    const text = options.trgToText(bytes);
    return {
      name, kind: "text", size: file.size, mediaType: "text/plain", data: text,
      note: `${bytes.length / TRIGGER_RECORD} trigger(s) from a binary .trg, printed as TrigEdit text against the open map. A .trg stores string numbers, not text, so the strings shown are this map's strings at those numbers; they are right only if the file came from a copy of this map.`,
    };
  }
  const text = decodeText(bytes);
  if (text === null) {
    throw new AttachmentError(`${name}: Claude reads pictures (PNG, JPEG, GIF, WebP), PDFs and text files, and this is none of them.`);
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new AttachmentError(`${name}: ${text.length.toLocaleString("en")} characters is more than the ${MAX_TEXT_CHARS.toLocaleString("en")} one file may hold.`);
  }
  return { name, kind: "text", size: file.size, mediaType: "text/plain", data: text };
}

/** How much a list adds to every later request of the conversation (base64 or text, as sent). */
export function attachmentBytes(list: readonly Attachment[]): number {
  return list.reduce((sum, a) => sum + a.data.length, 0);
}

/** The blocks that carry the files, in order, each picture named so Claude can refer to it. */
export function attachmentBlocks(list: readonly Attachment[]): BetaContentBlockParam[] {
  const out: BetaContentBlockParam[] = [];
  for (const a of list) {
    if (a.kind === "image") {
      out.push({ type: "text", text: `Attached picture: ${a.name}` });
      out.push({ type: "image", source: { type: "base64", media_type: a.mediaType as ImageType, data: a.data } });
    } else if (a.kind === "pdf") {
      out.push({ type: "document", title: a.name, source: { type: "base64", media_type: "application/pdf", data: a.data } });
    } else {
      out.push({ type: "document", title: a.name, ...(a.note ? { context: a.note } : {}), source: { type: "text", media_type: "text/plain", data: a.data } });
    }
  }
  return out;
}

/**
 * The browser's scaler: a picture longer than `IMAGE_EDGE` on a side, or heavier than
 * `MAX_IMAGE_BYTES`, drawn smaller on a canvas — PNG stays PNG unless that is still too
 * heavy, then JPEG. A GIF is left alone (scaling would drop its frames).
 */
export async function scaleInBrowser(bytes: Uint8Array, type: ImageType): Promise<{ bytes: Uint8Array; type: ImageType } | null> {
  if (type === "image/gif" || typeof createImageBitmap !== "function") return null;
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type }));
  try {
    const long = Math.max(bitmap.width, bitmap.height);
    if (long <= IMAGE_EDGE && bytes.length <= MAX_IMAGE_BYTES) return null;
    const k = Math.min(1, IMAGE_EDGE / long);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * k));
    canvas.height = Math.max(1, Math.round(bitmap.height * k));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const encode = (as: ImageType) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, as, 0.9));
    let outType: ImageType = type === "image/png" ? "image/png" : type === "image/webp" ? "image/webp" : "image/jpeg";
    let blob = await encode(outType);
    if (!blob || blob.size > MAX_IMAGE_BYTES) {
      outType = "image/jpeg";
      blob = await encode(outType);
    }
    return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()), type: outType } : null;
  } finally {
    bitmap.close();
  }
}
