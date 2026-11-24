import { appCheckDebugToken, appCheckSiteKey, firebaseConfig } from '@firebase-config';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode } from 'firebase/ai';
import { getApps, initializeApp } from 'firebase/app';
import { askWithFallback, type HybridAnswer, type HybridMode, type HybridModel } from './ask';
import { initAppCheck } from './appCheck';

const CLOUD_MODEL = 'gemini-3.5-flash-lite';

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

export async function createHybridModel(mode: HybridMode): Promise<HybridModel> {
  const app = getApps()[0] ?? initializeApp(firebaseConfig);
  await initAppCheck(app);
  const ai = getAI(app, { backend: new GoogleAIBackend() });
  // Prefer Gemini Nano in Chrome, then cloud Gemini.
  const model = getGenerativeModel(ai, {
    mode: mode === 'only_in_cloud' ? InferenceMode.ONLY_IN_CLOUD : InferenceMode.PREFER_ON_DEVICE,
    inCloudParams: {
      model: CLOUD_MODEL,
      generationConfig: { maxOutputTokens: 800 },
    },
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      },
    },
  }, { timeout: 30_000 });
  return model;
}

export function askHybrid(primary: string, fallback: string): Promise<HybridAnswer> {
  return askWithFallback(primary, fallback, createHybridModel);
}
