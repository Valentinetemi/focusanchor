interface ChromeLanguageModelApi {
  availability(options?: object): Promise<'available' | 'downloadable' | 'downloading' | 'unavailable' | string>;
}

declare const LanguageModel: ChromeLanguageModelApi | undefined;

interface Window {
  FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string;
}

