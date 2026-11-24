import { appCheckDebugToken, appCheckSiteKey, firebaseConfig } from '@firebase-config';

function debugReady(): boolean {
  return appCheckDebugToken === true
    || appCheckDebugToken === 'true'
    || (typeof appCheckDebugToken === 'string' && appCheckDebugToken.trim() !== '');
}

export function aiConfigured(): boolean {
  const key = firebaseConfig.apiKey.trim();
  const project = firebaseConfig.projectId.trim();
  if (!key || !project || key.includes('YOUR_') || project.includes('YOUR_')) return false;
  return debugReady() || appCheckSiteKey.trim() !== '';
}
