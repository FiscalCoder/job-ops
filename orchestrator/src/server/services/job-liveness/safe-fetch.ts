/**
 * Fetch a posting URL without letting it reach internal services.
 *
 * Posting URLs come from third-party boards and from manual imports, so every
 * hop (including redirects) must resolve to a public address. The connection
 * is then pinned to the address that was validated, so a second DNS answer
 * cannot point the request somewhere else.
 */

import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 1_000_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

interface FetchedPage {
  finalUrl: string;
  status: number;
  body: string;
}

interface PinnedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

interface RawResponse {
  status: number;
  location: string | null;
  body: string;
}

type ResolveHost = (hostname: string) => Promise<string[]>;
type RequestPinned = (
  target: PinnedTarget,
  signal: AbortSignal,
) => Promise<RawResponse>;

function buildPrivateBlockList(): BlockList {
  const list = new BlockList();
  list.addSubnet("0.0.0.0", 8, "ipv4");
  list.addSubnet("10.0.0.0", 8, "ipv4");
  list.addSubnet("100.64.0.0", 10, "ipv4");
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addSubnet("169.254.0.0", 16, "ipv4");
  list.addSubnet("172.16.0.0", 12, "ipv4");
  list.addSubnet("192.0.0.0", 24, "ipv4");
  list.addSubnet("192.0.2.0", 24, "ipv4");
  list.addSubnet("192.168.0.0", 16, "ipv4");
  list.addSubnet("198.18.0.0", 15, "ipv4");
  list.addSubnet("198.51.100.0", 24, "ipv4");
  list.addSubnet("203.0.113.0", 24, "ipv4");
  list.addSubnet("224.0.0.0", 4, "ipv4");
  list.addSubnet("240.0.0.0", 4, "ipv4");
  // Unspecified, loopback and IPv4-compatible (::a.b.c.d) addresses.
  list.addSubnet("::", 96, "ipv6");
  // NAT64, Teredo and 6to4 can all tunnel to an IPv4 target.
  list.addSubnet("64:ff9b::", 96, "ipv6");
  list.addSubnet("2001::", 32, "ipv6");
  list.addSubnet("2001:db8::", 32, "ipv6");
  list.addSubnet("2002::", 16, "ipv6");
  list.addSubnet("fc00::", 7, "ipv6");
  list.addSubnet("fe80::", 10, "ipv6");
  list.addSubnet("ff00::", 8, "ipv6");
  return list;
}

const PRIVATE_ADDRESSES = buildPrivateBlockList();

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  // IPv4-mapped IPv6 is never needed for a public site; refuse it outright.
  if (family === 6 && address.toLowerCase().startsWith("::ffff:")) return false;
  return !PRIVATE_ADDRESSES.check(address, family === 6 ? "ipv6" : "ipv4");
}

const resolveWithDns: ResolveHost = async (hostname) => {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
};

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/**
 * Validate a URL and return the public address the request must connect to.
 */
export async function resolvePublicTarget(
  rawUrl: string,
  resolveHost: ResolveHost = resolveWithDns,
): Promise<PinnedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("Posting URL is not a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("Posting URL is not an http(s) URL");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
  const address = addresses[0];
  if (!address || !addresses.every(isPublicAddress)) {
    throw new UnsafeUrlError("Posting URL does not resolve to a public host");
  }

  return { url, address, family: isIP(address) === 6 ? 6 : 4 };
}

function decodeStream(response: IncomingMessage): Readable {
  const encoding = String(
    response.headers["content-encoding"] ?? "",
  ).toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") {
    return response.pipe(createGunzip());
  }
  if (encoding === "deflate") return response.pipe(createInflate());
  if (encoding === "br") return response.pipe(createBrotliDecompress());
  return response;
}

/** Read at most MAX_BODY_BYTES, then stop the transfer. */
async function readCappedBody(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for await (const chunk of decodeStream(response)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      received += buffer.length;
      if (received >= MAX_BODY_BYTES) break;
    }
  } catch (error) {
    // A truncated or corrupt compressed stream still yields usable markup.
    if (chunks.length === 0) throw error;
  } finally {
    response.destroy();
  }
  return Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString("utf8");
}

const requestPinnedOverNetwork: RequestPinned = (target, signal) =>
  new Promise<RawResponse>((resolve, reject) => {
    const send = target.url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      target.url,
      {
        method: "GET",
        signal,
        // Connect to the address that was validated, never a fresh lookup.
        lookup: (_hostname, options, callback) => {
          if (typeof options === "object" && options.all) {
            callback(null, [
              { address: target.address, family: target.family },
            ]);
            return;
          }
          callback(null, target.address, target.family);
        },
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "accept-encoding": "gzip, deflate, br",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location ?? null;
        if (status >= 300 && status < 400 && location) {
          response.destroy();
          resolve({ status, location, body: "" });
          return;
        }
        readCappedBody(response).then(
          (body) => resolve({ status, location: null, body }),
          reject,
        );
      },
    );
    request.on("error", reject);
    request.end();
  });

export async function fetchPublicPage(
  rawUrl: string,
  options: {
    timeoutMs: number;
    resolveHost?: ResolveHost;
    requestPinned?: RequestPinned;
  },
): Promise<FetchedPage> {
  const requestPinned = options.requestPinned ?? requestPinnedOverNetwork;
  const signal = AbortSignal.timeout(options.timeoutMs);
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = await abortable(
      resolvePublicTarget(currentUrl, options.resolveHost),
      signal,
    );
    const response = await requestPinned(target, signal);

    if (response.location) {
      currentUrl = new URL(response.location, target.url).href;
      continue;
    }

    return {
      finalUrl: target.url.href,
      status: response.status,
      body: response.body,
    };
  }

  throw new Error(`Posting URL redirected more than ${MAX_REDIRECTS} times`);
}
