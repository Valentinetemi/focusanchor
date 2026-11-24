declare module '@firebase-config' {
  export const firebaseConfig: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    storageBucket: string;
    messagingSenderId: string;
    appId: string;
  };
  export const appCheckSiteKey: string;
  export const appCheckDebugToken: string | boolean;
}
