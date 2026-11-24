import { routeFrom, type RouteLabel } from './promptText.ts';

export const DEVICE_WAIT_MS = 1200;

export interface HybridModel {
  initializeDeviceModel(onProgress?: (value: number) => void): Promise<void>;
  generateContent(prompt: string): Promise<{
    response: {
      text: () => string;
      inferenceSource?: string;
    };
  }>;
}

export interface HybridAnswer {
  text: string;
  route: RouteLabel;
}

export type HybridMode = 'prefer_on_device' | 'only_in_cloud';

export async function askOnce(prompt: string, model: HybridModel): Promise<HybridAnswer> {
  const ready = model.initializeDeviceModel().catch(() => undefined);
  await Promise.race([
    ready,
    new Promise<void>((resolve) => setTimeout(resolve, DEVICE_WAIT_MS)),
  ]);
  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  if (!text) throw new Error('The model returned an empty response.');
  return { text, route: routeFrom(result.response.inferenceSource) };
}

export async function askWithFallback(
  primary: string,
  fallback: string,
  factory: (mode: HybridMode) => Promise<HybridModel>,
): Promise<HybridAnswer> {
  try {
    return await askOnce(primary, await factory('prefer_on_device'));
  } catch (error) {
    try {
      return await askOnce(fallback, await factory('only_in_cloud'));
    } catch {
      throw error;
    }
  }
}
