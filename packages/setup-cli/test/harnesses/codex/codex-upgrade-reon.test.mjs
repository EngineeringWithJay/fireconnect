import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { describe, it } from "node:test";

import { writeGlobalConfig } from "../../../lib/config/global-config.mjs";
import { codexCatalogPath, codexConfigPath } from "../../../lib/harnesses/codex/core.mjs";
import { clearListPriceCache, setListPriceCacheRates } from "../../../lib/pricing/list-price-cache.mjs";
import {
  CODEX_SIGN_IN_UPGRADE_NOTE,
  CODEX_UPGRADE_REON_FAILURE,
  reapplyCodexOnUpgrade,
} from "../../../lib/harnesses/codex/upgrade-reon.mjs";
import { parseToml } from "../../../lib/harnesses/codex/toml.mjs";
import { buildServerlessCatalogSnapshot } from "../../../lib/fireworks/models.mjs";
import { cacheServerlessCatalogSnapshot, setServerlessCatalogSnapshot } from "../../../lib/fireworks/serverless-catalog-cache.mjs";
import { mockServerlessModel, seedKeychainConfig, withTempHome } from "../../helpers.mjs";

const KEY = "fw_codex_sign_in_upgrade_key_0000";

// What a release before Codex's sign-in mode wrote for `codex on --model firerouter`.
const LEGACY_CONFIG = [
  'model_provider = "fireworks-ai"',
  'model = "firerouter"',
  "",
  "[model_providers.fireworks-ai]",
  'name = "Fireworks"',
  'base_url = "https://api.fireworks.ai/inference/v1"',
  'wire_api = "responses"',
  `experimental_bearer_token = "${KEY}"`,
  "requires_openai_auth = false",
  'http_headers = { "X-Title" = "Codex", "HTTP-Referer" = "fireconnect/v0.9.7" }',
  'env_http_headers = { "x-anthropic-api-key" = "ANTHROPIC_API_KEY", "x-openai-api-key" = "OPENAI_API_KEY" }',
  "",
  "[features]",
  "web_search = true",
  "",
].join("\n");

/** Run `fn` with this home as HOME and no Fireworks key in the environment. */
async function inHome(home, fn) {
  const saved = { HOME: process.env.HOME, FIREWORKS_API_KEY: process.env.FIREWORKS_API_KEY };
  process.env.HOME = home;
  delete process.env.FIREWORKS_API_KEY;
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

async function seedLegacyCodex(home, { enabled = true } = {}) {
  await seedKeychainConfig(home, KEY);
  await writeGlobalConfig(home, {
    harnesses: { codex: { enabled, provider: "fireworks" } },
  });
  await mkdir(path.dirname(codexConfigPath(home)), { recursive: true });
  await writeFile(codexConfigPath(home), LEGACY_CONFIG);
}

describe("reapplyCodexOnUpgrade", () => {
  it("re-runs codex on so an earlier config uses Codex's sign-in, then leaves it alone", async () => {
    await withTempHome("codex-sign-in-upgrade-", async (home) => {
      await seedLegacyCodex(home);

      const notes = await inHome(home, () => reapplyCodexOnUpgrade(home));
      assert.deepEqual(notes, [CODEX_SIGN_IN_UPGRADE_NOTE]);

      const raw = await readFile(codexConfigPath(home), "utf8");
      const doc = parseToml(raw);
      const table = doc.tables["model_providers.fireworks-ai"];
      assert.equal(table.requires_openai_auth, true);
      assert.equal(table.experimental_bearer_token, undefined);
      assert.equal(table.http_headers["x-fireworks-api-key"], KEY);
      assert.equal(table.env_http_headers, undefined);
      assert.doesNotMatch(raw, /x-openai-api-key|x-anthropic-api-key/);
      assert.equal(doc.root.model, "firerouter/astra");
      assert.match(raw, /\[features\]\nweb_search = true/);

      const again = await inHome(home, () => reapplyCodexOnUpgrade(home));
      assert.deepEqual(again, []);
      assert.equal(await readFile(codexConfigPath(home), "utf8"), raw);
    });
  });

  it("re-runs codex on when models.dev has a newer GPT model than the picker, then leaves it alone", async () => {
    await withTempHome("codex-upgrade-reon-gpt-", async (home) => {
      await seedLegacyCodex(home);
      // What the upgrade's model-source refresh leaves behind.
      await inHome(home, () => cacheServerlessCatalogSnapshot(buildServerlessCatalogSnapshot([mockServerlessModel()])));
      try {
        await inHome(home, () => reapplyCodexOnUpgrade(home));
        const slugs = async () => JSON.parse(await readFile(codexCatalogPath(home), "utf8")).models.map((row) => row.slug);
        assert.ok(!(await slugs()).includes("gpt-99-sol"));

        setListPriceCacheRates({
          openai: { "gpt-99-sol": { family: "gpt-sol", label: "GPT-99 Sol", contextWindow: 1_000_000 } },
        });
        const notes = await inHome(home, () => reapplyCodexOnUpgrade(home));
        assert.deepEqual(notes, ["Added gpt-99-sol to Codex's model list. Restart Codex to pick it up."]);
        assert.ok((await slugs()).includes("gpt-99-sol"));
        assert.equal(parseToml(await readFile(codexConfigPath(home), "utf8")).root.model, "firerouter/astra");

        assert.deepEqual(await inHome(home, () => reapplyCodexOnUpgrade(home)), []);
      } finally {
        clearListPriceCache();
        setServerlessCatalogSnapshot(null);
      }
    });
  });

  it("leaves a disabled Codex untouched", async () => {
    await withTempHome("codex-sign-in-upgrade-off-", async (home) => {
      await seedLegacyCodex(home, { enabled: false });
      const notes = await inHome(home, () => reapplyCodexOnUpgrade(home));
      assert.deepEqual(notes, []);
      assert.equal(await readFile(codexConfigPath(home), "utf8"), LEGACY_CONFIG);
    });
  });

  it("runs codex on --force quietly, and only for a config from before the sign-in", async () => {
    await withTempHome("codex-sign-in-upgrade-route-", async (home) => {
      await seedLegacyCodex(home);
      const runs = [];
      const run = async (route, ctx) => {
        runs.push({ route, force: ctx.force, quiet: ctx.quiet, home: ctx.home });
      };
      await inHome(home, () => reapplyCodexOnUpgrade(home, { run }));
      assert.equal(runs.length, 1);
      assert.equal(runs[0].route.harnessId, "codex");
      assert.equal(runs[0].route.verb, "on");
      assert.deepEqual([runs[0].force, runs[0].quiet, runs[0].home], [true, true, home]);

      await inHome(home, () => reapplyCodexOnUpgrade(home));
      runs.length = 0;
      assert.deepEqual(await inHome(home, () => reapplyCodexOnUpgrade(home, { run })), []);
      assert.equal(runs.length, 0);
    });
  });

  it("returns a fix-it note instead of throwing when the re-on fails", async () => {
    await withTempHome("codex-sign-in-upgrade-fail-", async (home) => {
      await seedLegacyCodex(home);
      const run = async () => {
        throw new Error("boom");
      };
      const notes = await inHome(home, () => reapplyCodexOnUpgrade(home, { run }));
      assert.deepEqual(notes, [CODEX_UPGRADE_REON_FAILURE]);
    });
  });
});
