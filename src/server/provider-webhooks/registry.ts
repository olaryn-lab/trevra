import { isWebhookProvider, type ProviderWebhookVerifier, type WebhookProvider } from './types.js';

// Process-wide registry. `createApp` registers each verifier once at boot;
// registering the same provider again replaces it (tests rely on this).
const verifiers = new Map<WebhookProvider, ProviderWebhookVerifier>();

export function registerProviderVerifier(verifier: ProviderWebhookVerifier): void {
  verifiers.set(verifier.provider, verifier);
}

export function getProviderVerifier(provider: string): ProviderWebhookVerifier | null {
  return isWebhookProvider(provider) ? (verifiers.get(provider) ?? null) : null;
}

export function registeredWebhookProviders(): WebhookProvider[] {
  return [...verifiers.keys()].sort();
}
