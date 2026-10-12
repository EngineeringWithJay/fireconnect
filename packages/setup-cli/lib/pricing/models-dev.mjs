/**
 * The one models.dev download. List prices (with the OpenAI and Anthropic
 * model metadata the pickers read) and the OpenCode Fireworks registry both
 * parse this body, so a process fetches it at most once at a time and reuses
 * a successful body for the rest of its life.
 */
const MODELS_DEV_API_URL = "https://models.dev/api.json";
const MODELS_DEV_TIMEOUT_MS = 20_000;

/** @type {Promise<string> | null} */
let pending = null;
let body = "";

/**
 * The models.dev api.json body, or "" when it can't be fetched. Never throws,
 * and never waits longer than the fetch timeout.
 * @returns {Promise<string>}
 */
export function fetchModelsDevApi() {
  if (body) {
    return Promise.resolve(body);
  }
  pending ??= (async () => {
    try {
      const response = await fetch(MODELS_DEV_API_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS),
      });
      body = response.ok ? await response.text() : "";
    } catch {
      body = "";
    } finally {
      pending = null;
    }
    return body;
  })();
  return pending;
}

/** Forget the fetched body. Tests only. */
export function clearModelsDevApiForTests() {
  pending = null;
  body = "";
}
