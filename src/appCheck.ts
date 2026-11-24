import type { FirebaseApp } from 'firebase/app';
import { appCheckDebugToken, appCheckSiteKey } from '@firebase-config';

type DebugScope = typeof globalThis & {
  FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string;
};

let pending: Promise<void> | null = null;

function applyDebugToken(): void {
  const scope = globalThis as DebugScope;
  if (appCheckDebugToken === true || appCheckDebugToken === 'true') {
    scope.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    return;
  }
  if (typeof appCheckDebugToken === 'string' && appCheckDebugToken.trim()) {
    scope.FIREBASE_APPCHECK_DEBUG_TOKEN = appCheckDebugToken.trim();
  }
}

async function activate(app: FirebaseApp): Promise<void> {
  const { initializeAppCheck, ReCaptchaEnterpriseProvider, CustomProvider } = await import('firebase/app-check');
  applyDebugToken();
  const siteKey = appCheckSiteKey.trim();
  const provider = siteKey
    ? new ReCaptchaEnterpriseProvider(siteKey)
    : new CustomProvider({
        getToken: () => Promise.resolve({
          token: 'missing-app-check',
          expireTimeMillis: Date.now() + 60_000,
        }),
      });
  initializeAppCheck(app, {
    provider,
    isTokenAutoRefreshEnabled: true,
  });
}

export function initAppCheck(app: FirebaseApp): Promise<void> {
  pending ??= activate(app).catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}
