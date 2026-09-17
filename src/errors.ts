/** Thrown when neither Jev auth path is configured. Caught by the fail-closed logic in `gate.ts`/`prune.ts`. */
export class JevAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JevAuthError';
  }
}

/**
 * This package does not implement authentication itself — the AI SDK's
 * AI Gateway client handles that. It reads `AI_GATEWAY_API_KEY` directly, or
 * falls back to a short-lived OIDC token (`VERCEL_OIDC_TOKEN`, refreshed by
 * `vercel env pull`, ~12h lifetime) via `getVercelOidcToken()`.
 *
 * We only check for the presence of one of those two env vars, and only
 * when the caller is using the default *string* model id (which resolves
 * through the Gateway). If neither is set we fail fast with a clear message
 * instead of letting a cryptic 401 surface from deep inside `evaluate()`.
 * A caller who passes a custom `EvaluationModel` instance is assumed to have
 * wired up their own auth, so this check is skipped for them.
 */
export function assertGatewayAuthConfigured(model: unknown): void {
  if (typeof model !== 'string') return;
  if (process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN) return;
  throw new JevAuthError(
    'No Jev/AI Gateway credentials found. Set one of:\n' +
      '  - AI_GATEWAY_API_KEY (a Vercel AI Gateway API key), or\n' +
      '  - VERCEL_OIDC_TOKEN (run `vercel env pull` inside a Vercel project; refresh every ~12h)\n' +
      'See the README "Authentication" section for details.',
  );
}
