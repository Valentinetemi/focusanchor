import { getApp, getApps, initializeApp } from 'firebase/app';
import type { FirebaseOptions } from 'firebase/app';
import { CustomProvider, initializeAppCheck } from 'firebase/app-check';
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode as FirebaseInferenceMode,
  InferenceSource as FirebaseInferenceSource,
  Schema,
} from 'firebase/ai';
import type { GenerativeModel } from 'firebase/ai';
import { AiError } from './core';
import type {
  AiProvider,
  AiTask,
  DeviceAvailability,
  InferenceMode,
  ModelResponse,
} from './core';

const CLOUD_MODEL = import.meta.env.VITE_FIREBASE_AI_MODEL?.trim() || 'gemini-3.5-flash-lite';
const APP_NAME = 'focusanchor-hybrid-ai';
let appCheckInitialized = false;

const firebaseConfig: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY?.trim(),
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim(),
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim(),
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET?.trim(),
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim(),
  appId: import.meta.env.VITE_FIREBASE_APP_ID?.trim(),
};

const smartAnchorSchema = Schema.object({
  properties: {
    whyItMatters: Schema.string({ description: 'Why this page matters to the current mission.' }),
    nextAction: Schema.string({ description: 'The next concrete action for this page.' }),
    contextNote: Schema.string({ description: 'A concise note of at most 240 characters.' }),
    question: Schema.string({ description: 'An optional question or reminder.', nullable: true }),
  },
});

const restartBriefSchema = Schema.object({
  properties: {
    firstTabRef: Schema.string({ description: 'Exactly one supplied tab reference.' }),
    firstTabReason: Schema.string({ description: 'Why that saved tab should be revisited first.' }),
    nextAction: Schema.string({ description: 'One recommended next action grounded in the saved data.' }),
  },
});

export function firebaseConfigured(): boolean {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);
}

export function appCheckDebugEnabled(): boolean {
  return import.meta.env.VITE_FIREBASE_APPCHECK_DEBUG === 'true';
}

function appCheckProvider(): CustomProvider {
  return new CustomProvider({
    getToken: async () => {
      throw new AiError(
        'app-check',
        'Cloud fallback is locked. Use an App Check debug build for unpacked Chrome testing.',
      );
    },
  });
}

function firebaseApp() {
  if (!firebaseConfigured()) {
    throw new AiError('not-configured', 'Firebase configuration is missing. You can still save a manual note.');
  }
  const existing = getApps().find((app) => app.name === APP_NAME);
  const app = existing ?? initializeApp(firebaseConfig, APP_NAME);
  if (!appCheckInitialized) {
    if (appCheckDebugEnabled()) {
      // Firebase creates and persists a random token for this extension installation.
      // The token is printed to DevTools and must be registered in the console; it is never bundled.
      window.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    }
    initializeAppCheck(app, {
      provider: appCheckProvider(),
      isTokenAutoRefreshEnabled: false,
    });
    appCheckInitialized = true;
  }
  return getApp(APP_NAME);
}

function schemaFor(task: AiTask) {
  return task === 'smart-anchor' ? smartAnchorSchema : restartBriefSchema;
}

function firebaseMode(mode: InferenceMode) {
  return mode === 'device-only'
    ? FirebaseInferenceMode.ONLY_ON_DEVICE
    : FirebaseInferenceMode.PREFER_ON_DEVICE;
}

function readAvailability(value: string): DeviceAvailability {
  if (value === 'available' || value === 'downloadable' || value === 'downloading' || value === 'unavailable') {
    return value;
  }
  return 'unknown';
}

export class FirebaseHybridProvider implements AiProvider {
  private readonly models = new Map<string, GenerativeModel>();

  private model(task: AiTask, mode: InferenceMode): GenerativeModel {
    const key = `${task}:${mode}`;
    const existing = this.models.get(key);
    if (existing) return existing;
    const ai = getAI(firebaseApp(), { backend: new GoogleAIBackend() });
    const schema = schemaFor(task);
    const model = getGenerativeModel(ai, {
      mode: firebaseMode(mode),
      inCloudParams: {
        model: CLOUD_MODEL,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema,
          maxOutputTokens: 512,
          temperature: 0.2,
        },
      },
      onDeviceParams: {
        promptOptions: { responseConstraint: schema },
        createOptions: { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] },
      },
    });
    this.models.set(key, model);
    return model;
  }

  async availability(): Promise<DeviceAvailability> {
    if (typeof LanguageModel === 'undefined') return 'unavailable';
    try {
      return readAvailability(await LanguageModel.availability());
    } catch {
      return 'unknown';
    }
  }

  initialize(task: AiTask, mode: InferenceMode, onProgress: (progress: number) => void): Promise<void> {
    return this.model(task, mode).initializeDeviceModel(onProgress);
  }

  async generate(task: AiTask, prompt: string, mode: InferenceMode): Promise<ModelResponse> {
    const result = await this.model(task, mode).generateContent(prompt);
    const source = result.response.inferenceSource;
    if (source === FirebaseInferenceSource.ON_DEVICE || (mode === 'device-only' && source === undefined)) {
      return { text: result.response.text(), source: 'on-device' };
    }
    if (source === FirebaseInferenceSource.IN_CLOUD) {
      return { text: result.response.text(), source: 'cloud-fallback' };
    }
    throw new AiError('unknown', 'Firebase did not report where inference ran. The result was not used.');
  }
}

let provider: FirebaseHybridProvider | undefined;

export function getFirebaseHybridProvider(): FirebaseHybridProvider {
  provider ??= new FirebaseHybridProvider();
  return provider;
}

export const firebaseAiModel = CLOUD_MODEL;
