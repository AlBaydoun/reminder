/**
 * Picks the backend at build time.
 *
 * The normal build talks to the Node/SQLite server. The published demo is a
 * static page with no server behind it, so `VITE_DEMO=true` swaps in an
 * implementation of the same surface that keeps everything in the visitor's
 * own browser. Every call site imports from here and neither knows nor cares
 * which one it got.
 */
import { api as serverApi, ApiError as ServerApiError, getAccessToken as serverGetToken, onAuthChange as serverOnAuthChange, setAccessToken as serverSetToken } from './serverApi';
import { api as demoApi, ApiError as DemoApiError, getAccessToken as demoGetToken, onAuthChange as demoOnAuthChange, setAccessToken as demoSetToken } from './demo/api';

export const IS_DEMO = import.meta.env.VITE_DEMO === 'true';

export const api: typeof serverApi = IS_DEMO ? demoApi : serverApi;
export const ApiError = IS_DEMO ? DemoApiError : ServerApiError;
export const setAccessToken = IS_DEMO ? demoSetToken : serverSetToken;
export const getAccessToken = IS_DEMO ? demoGetToken : serverGetToken;
export const onAuthChange = IS_DEMO ? demoOnAuthChange : serverOnAuthChange;
