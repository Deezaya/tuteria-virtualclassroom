/**
 * Cloudflare R2 storage through presigned URLs (AWS Signature Version 4).
 * The browser uploads and downloads directly from R2; the backend only
 * signs short-lived links after checking permissions. Uses Node's crypto,
 * so no AWS SDK is needed.
 */
import { createHash, createHmac } from "node:crypto";
import { config } from "../config.js";

type StorageSettings = {
  origin: string;
  host: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

function settings(): StorageSettings | null {
  const accessKeyId = config.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = config.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = config.R2_BUCKET_NAME?.trim();
  const endpoint =
    config.R2_ENDPOINT_URL?.trim() ||
    (config.R2_ACCOUNT_ID?.trim()
      ? `https://${config.R2_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`
      : "");
  if (!accessKeyId || !secretAccessKey || !bucket || !endpoint) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  return { origin: url.origin, host: url.host, bucket, accessKeyId, secretAccessKey };
}

/** True when all the R2 settings are present. */
export function isStorageConfigured(): boolean {
  return settings() !== null;
}

/** RFC 3986 encoding, as Signature Version 4 requires. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

export type SignInput = {
  method: "GET" | "PUT";
  host: string;
  /** Already-encoded path, starting with "/". */
  path: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
  expiresIn: number;
  /** Extra headers the request must send exactly (lower-case names). */
  headers?: Record<string, string>;
};

/** Returns the signed query string for a presigned URL. Exported for tests. */
export function signQuery(input: SignInput): string {
  const amzDate = input.date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const signed: Record<string, string> = { host: input.host, ...(input.headers ?? {}) };
  const headerNames = Object.keys(signed).sort();
  const signedHeaders = headerNames.join(";");
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(input.expiresIn),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${encode(name)}=${encode(query[name])}`)
    .join("&");
  const canonicalHeaders = headerNames.map((name) => `${name}:${signed[name].trim()}\n`).join("");
  const canonicalRequest = [
    input.method,
    input.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return `${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function objectPath(bucket: string, key: string): string {
  return `/${encode(bucket)}/${key.split("/").map(encode).join("/")}`;
}

/**
 * A URL the browser can PUT one file to. Content-Type and Content-Length
 * are signed, so R2 rejects a file of any other type or size.
 */
export function presignUpload(key: string, contentType: string, bytes: number, expiresIn = 600): string {
  const s = settings();
  if (!s) throw new Error("File storage is not configured.");
  const path = objectPath(s.bucket, key);
  const query = signQuery({
    method: "PUT",
    host: s.host,
    path,
    region: "auto",
    accessKeyId: s.accessKeyId,
    secretAccessKey: s.secretAccessKey,
    date: new Date(),
    expiresIn,
    headers: { "content-length": String(bytes), "content-type": contentType },
  });
  return `${s.origin}${path}?${query}`;
}

/** A short-lived URL to view one file. */
export function presignDownload(key: string, expiresIn = 3600): string {
  const s = settings();
  if (!s) throw new Error("File storage is not configured.");
  const path = objectPath(s.bucket, key);
  const query = signQuery({
    method: "GET",
    host: s.host,
    path,
    region: "auto",
    accessKeyId: s.accessKeyId,
    secretAccessKey: s.secretAccessKey,
    date: new Date(),
    expiresIn,
  });
  return `${s.origin}${path}?${query}`;
}
