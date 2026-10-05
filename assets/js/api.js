/*
 * api.js — the one place the browser talks to tools/serve.js.
 *
 * When the server is published on the network it refuses the mutating routes
 * without the operator's PITTV_TOKEN, so every one of those calls has to be able
 * to present it. Funnelling them through one helper is what keeps that true of
 * new routes instead of only the ones someone remembered.
 *
 * The token is read from localStorage rather than baked into the bundle: the
 * server's copy lives in its environment, and a token shipped to every visitor
 * is not a credential. Loopback runs have no token and this is a no-op.
 */

const TOKEN_KEY = "pittv:token";

/** The operator's write token, or "" when none has been entered. */
export function apiToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    /* private mode: no token, which is the same as the server having none */
    return "";
  }
}

export function setApiToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* cannot persist; the token simply is not remembered across reloads */
  }
}

/** Headers for a mutating request, with the bearer token when one is known. */
export function apiHeaders(extra = {}) {
  const token = apiToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
}

/** fetch() with the token attached. Read requests do not need it. */
export function apiFetch(url, options = {}) {
  return fetch(url, { ...options, headers: apiHeaders(options.headers) });
}

/**
 * Ask the operator for PITTV_TOKEN and remember it.
 *
 * A published server (HOST=0.0.0.0) answers 401 on every mutating route until
 * it sees the token, and a browser that has not been given one cannot recover
 * except by way of a write. edit.js has always prompted at that point; the
 * background calls in catalog.js fire on load, where a bare 401 was swallowed
 * into a console warning and shows.json/covers simply never got refreshed.
 *
 * Returns the token, or "" when the operator declined or cancelled — the caller
 * lets the request stay refused rather than retrying in a loop.
 */
export function requestApiToken() {
  const entered = window.prompt(
    "This server requires a write token.\nEnter PITTV_TOKEN to sync shows and fetch album art (stored in this browser only):",
    ""
  );
  if (!entered) return "";
  const token = entered.trim();
  if (token) setApiToken(token);
  return token;
}

/* Set by the automatic handling below, which asks at most once per page load: a
 * wrong token would otherwise re-prompt on every background call. An explicit
 * write always asks, because that button press is the user asking to fix it. */
let autoAskedForToken = false;

/**
 * apiFetch() with one retry after a 401, once the token has been supplied.
 *
 * The two background syncs are the only mutating calls the app makes on its own,
 * so on a published server they are precisely the ones that come back 401.
 */
export async function apiFetchAuthorized(url, options = {}) {
  const res = await apiFetch(url, options);
  if (res.status !== 401 || autoAskedForToken) return res;
  autoAskedForToken = true;
  if (!requestApiToken()) return res;
  return apiFetch(url, options);
}
