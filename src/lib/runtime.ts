/**
 * Runtime environment helpers for distinguishing local development
 * (writable JSON persistence + unrestricted benchmark execution)
 * from database-free read-only production deployment (e.g. Vercel).
 */
export function isReadOnlyProduction(): boolean {
  if (process.env.TRUTHLENS_ALLOW_WRITES === "1") {
    return false;
  }
  return (
    process.env.VERCEL === "1" || process.env.NODE_ENV === "production"
  );
}
