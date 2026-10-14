import type { BlobRouteContext } from "./context.js";
import { MAX_DELETE_URLS } from "./constants.js";
import { blobErr, forbidden } from "./errors.js";
import { resolveStoreId } from "./auth.js";
import { resolveBlobRef } from "./paths.js";
import { findBlobRef } from "./lookup.js";
import { etagMatches } from "./etag.js";

export function registerDelete({ app, vs, parsedBaseUrl }: BlobRouteContext): void {
  // Delete.

  app.post("/api/blob/delete", async (c) => {
    const storeId = resolveStoreId(c);
    if (!storeId) return forbidden(c);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    const isObject = typeof body === "object" && body !== null && !Array.isArray(body);
    const rawUrls = isObject ? (body as { urls?: unknown }).urls : undefined;
    if (isObject && (rawUrls === undefined || (Array.isArray(rawUrls) && rawUrls.length === 0))) {
      return blobErr(c, 400, "bad_request", "Missing urls in request body");
    }
    if (!Array.isArray(rawUrls) || rawUrls.length > MAX_DELETE_URLS) {
      return blobErr(c, 400, "bad_request", "Cannot delete more than 1,000 urls at once or body is malformed");
    }
    const urls = rawUrls.filter((u): u is string => typeof u === "string");

    const ifMatch = c.req.header("x-if-match");
    for (const urlOrPathname of urls) {
      const blob = findBlobRef(vs, storeId, resolveBlobRef(urlOrPathname, parsedBaseUrl));
      if (!blob) continue;
      if (ifMatch && !etagMatches(blob.etag, ifMatch)) {
        return blobErr(c, 412, "precondition_failed", "Precondition failed: ETag mismatch.");
      }
      vs.blobs.delete(blob.id);
    }

    return c.json(null);
  });
}
