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
