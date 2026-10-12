import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { clearModelsDevApiForTests, fetchModelsDevApi } from "../../lib/pricing/models-dev.mjs";

const previousFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = previousFetch;
  clearModelsDevApiForTests();
});

describe("fetchModelsDevApi", () => {
  it("downloads models.dev once for concurrent callers and reuses the body", async () => {
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls += 1;
      assert.equal(url, "https://models.dev/api.json");
      assert.ok(init.signal, "the fetch is bounded");
      return { ok: true, text: async () => '{"openai":{}}' };
    };
    const [first, second] = await Promise.all([fetchModelsDevApi(), fetchModelsDevApi()]);
    assert.equal(first, '{"openai":{}}');
    assert.equal(second, first);
    assert.equal(await fetchModelsDevApi(), first);
    assert.equal(calls, 1);
  });

  it("returns an empty body instead of throwing, and retries on the next call", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("network unreachable");
      }
      return { ok: false, text: async () => "nope" };
    };
    assert.equal(await fetchModelsDevApi(), "");
    assert.equal(await fetchModelsDevApi(), "");
    assert.equal(calls, 2);
  });
});
