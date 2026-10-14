import type { Context } from "@emulators/core";
import { DEFAULT_CACHE_MAX_AGE, MIN_CACHE_MAX_AGE } from "./constants.js";
import { blobErr, forbidden } from "./errors.js";
import { resolveStoreId } from "./auth.js";
import { withRandomSuffix } from "./paths.js";

export interface UploadTarget {
  storeId: string;
  pathname: string;
}

// Shared by single PUT uploads, copies and multipart creation: authenticates the
// request and turns the pathname query into the final stored pathname.
export function resolveUploadTarget(c: Context): UploadTarget | Response {
  const storeId = resolveStoreId(c);
  if (!storeId) return forbidden(c);

  const rawPathname = c.req.query("pathname")?.replace(/^\/+/, "");
  if (!rawPathname) {
    return blobErr(c, 400, "bad_request", "pathname is required");
  }
  if (rawPathname.includes("//")) {
    return blobErr(c, 400, "bad_request", "pathname cannot contain //");
  }

  const access = c.req.header("x-vercel-blob-access") ?? "public";
  if (access !== "public") {
    return blobErr(c, 400, "bad_request", "Only access: public is supported by the emulator");
  }

  const pathname = c.req.header("x-add-random-suffix") === "1" ? withRandomSuffix(rawPathname) : rawPathname;
  return { storeId, pathname };
}

export function cacheControlFor(maxAgeHeader: string | undefined): string {
  const maxAge = maxAgeHeader ? parseInt(maxAgeHeader, 10) : NaN;
  return `public, max-age=${Number.isFinite(maxAge) ? Math.max(maxAge, MIN_CACHE_MAX_AGE) : DEFAULT_CACHE_MAX_AGE}`;
}
