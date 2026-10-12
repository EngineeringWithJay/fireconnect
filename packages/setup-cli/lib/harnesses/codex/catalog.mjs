import {
  FIREROUTER_ASTRA_ROUTE,
  firerouterTagline,
} from "../../firerouter/core.mjs";
import {
  MODEL_API_OVERRIDES as MODEL_OVERRIDES,
  DEFAULT_FIREWORKS_MODEL_LIMITS,
  DEFAULT_MODEL_CAPABILITIES,
  lookupModelSpec,
  resolveFireworksModelLabel,
} from "../../fireworks/model-specs.mjs";
import { reasoningConfigFor } from "../../fireworks/reasoning.mjs";
import { autoDisplayName, buildServerlessCatalogSnapshot, firerouterDisplayName, prettyModelName } from "../../fireworks/models.mjs";
import {
  AUTO_INSTANT_MODEL_ID,
  AUTO_MODEL_ID,
  FIREROUTER_MODEL_ID,
  FIREROUTER_ROUTER_ID,
  canonicalAutoModelId,
  fireworksModelSlug,
  isAutoModelId,
  isFirerouterModelPattern,
  isFirerouterModel,
  shortFireworksModelRef,
} from "../../fireworks/model-id.mjs";
import { rowSupportsImageInput } from "../../fireworks/vision.mjs";
import { planCatalogRefresh } from "../../harness/catalog-refresh.mjs";
import { cachedListRateTable } from "../../pricing/list-price-cache.mjs";
import { cachedCodexStockModels } from "./stock-models.mjs";

export { MODEL_OVERRIDES };

// Codex sorts its picker by priority and keeps catalog order for ties. The
// FireRouter row leads, stock Codex's GPT rows keep their own priorities, and
// Fireworks rows follow. Not a constant: a re-stamp must not reorder the picker.
const CODEX_FIREROUTER_PRIORITY = 0;
const CODEX_FIREWORKS_PRIORITY = 99;

export const CODEX_CONSTANT_FIELDS = {
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  // Fireworks gateway serves /v1/responses over HTTP SSE only — it has no
  // websocket upgrade — so Codex must not try websockets first. With true,
  // Codex desktop attempts wss, retries ("Reconnecting 5/5"), then fails the
  // turn with "stream disconnected before completion: stream closed before
  // response.completed".
  prefer_websockets: false,
  support_verbosity: true,
  default_verbosity: "low",
  supports_reasoning_summaries: true,
  default_reasoning_summary: "none",
  experimental_supported_tools: [],
  base_instructions: "",
  truncation_policy: { mode: "tokens", limit: 10000 },
  minimal_client_version: "0.0.1",
  // With true, Codex withholds MCP and app tools from the request and exposes
  // them only through the client-executed `tool_search` tool. The Fireworks
  // Responses API does not implement that protocol, so models never see the
  // tools and every MCP call fails. With false, Codex sends them inline.
  supports_search_tool: false,
};

// The constants every row needs to work through the Fireworks gateway. Stock
// Codex's own GPT rows get only these, keeping the rest of Codex's row.
export const CODEX_TRANSPORT_FIELDS = Object.freeze({
  prefer_websockets: CODEX_CONSTANT_FIELDS.prefer_websockets,
  supports_search_tool: CODEX_CONSTANT_FIELDS.supports_search_tool,
});

/**
 * Re-stamp CODEX_CONSTANT_FIELDS onto catalog rows written by an earlier
 * release, so a changed constant reaches rows that `codex on` keeps as-is
 * (`--model` re-runs, offline re-runs, router rows the API no longer lists).
 * Stock Codex's rows, the only ones with base instructions, get just the
 * transport fields. Key order is preserved, so unchanged rows serialize
 * byte-for-byte.
 * @template {Record<string, unknown>} T
 * @param {T[]} models
 * @returns {T[]}
 */
export function withCodexConstantFields(models = []) {
  return models.map((row) => {
    if (!row || typeof row !== "object") {
      return row;
    }
    return { ...row, ...(row.base_instructions ? CODEX_TRANSPORT_FIELDS : CODEX_CONSTANT_FIELDS) };
  });
}

// Auto-compact at 80% of the window, not Codex's 90% default for an unset
// limit: the compaction RPC resends the full history plus instructions/tool
// schemas (~130k tokens of overhead on 1M-token sessions), so at 90% it
// already exceeds the gateway limit and the session can never compact again.
// 80% also passes through Codex's 90% clamp on explicit limits unclamped.
export const CODEX_AUTO_COMPACT_FRACTION = 0.8;

/**
 * Explicit auto-compact threshold for one catalog row. Never 0, which Codex
 * reads as "disable auto-compaction" — unknown windows get null instead.
 * @param {number} contextLength
 * @returns {number | null}
 */
export function codexAutoCompactTokenLimit(contextLength) {
  if (!Number.isFinite(contextLength) || contextLength <= 0) {
    return null;
  }
  return Math.floor(contextLength * CODEX_AUTO_COMPACT_FRACTION);
}

/**
 * Why MiniMax models are omitted from the Codex catalog and rejected on `codex on`.
 * Codex uses the Fireworks Responses API; its client inserts assistant messages
 * between tool_calls and tool_results. MiniMax chat templates require tool_results
 * to immediately follow tool_calls, so those sessions fail at render time.
 */
export const CODEX_MINIMAX_UNSUPPORTED_NOTE = (
  "MiniMax is not supported with Codex: Codex uses the Responses API and may place "
  + "assistant messages between tool_calls and tool_results, but MiniMax's template "
  + "requires tool_results to follow tool_calls directly. Use Claude, OpenCode, or "
  + "another Chat Completions harness for MiniMax."
);

/** @param {string} modelRef */
export function isCodexUnsupportedMiniMaxModel(modelRef) {
  const slug = fireworksModelSlug(modelRef ?? "");
  return slug === "minimax-latest" || slug.startsWith("minimax-");
}

/** @param {string} modelRef @returns {string} */
export function codexModelExclusionReason(modelRef) {
  return isCodexUnsupportedMiniMaxModel(modelRef) ? CODEX_MINIMAX_UNSUPPORTED_NOTE : "";
}

function routerDisplayName(routerId) {
  return resolveFireworksModelLabel(routerId) ?? prettyModelName(routerId);
}

/** First usable context window: 0 means "unknown", so fall through to the next source. */
function firstUsableContextLength(...values) {
  return values.find((value) => Number.isFinite(value) && value > 0)
    ?? DEFAULT_FIREWORKS_MODEL_LIMITS.contextWindow;
}

function effectiveModelFields(model) {
  const overrides = MODEL_OVERRIDES[model.name] ?? {};
  return {
    contextLength: firstUsableContextLength(
      overrides.contextLength,
      model.contextLength,
      model.context_length,
    ),
    supportsImageInput: overrides.supportsImageInput
      ?? rowSupportsImageInput(model),
    supportsTools: overrides.supportsTools
      ?? model.supportsTools
      ?? model.supports_tools
      ?? DEFAULT_MODEL_CAPABILITIES.toolCalling,
  };
}

export function buildCodexCatalogEntry(model) {
  const { contextLength, supportsImageInput, supportsTools } = effectiveModelFields(model);

  const reasoning = reasoningConfigFor(model.name);
  const reasoningSummaryFormat = reasoning.levels.length > 1 ? "experimental" : "none";
  const slug = fireworksModelSlug(model.name);

  return {
    slug,
    display_name: model.displayName ?? model.name,
    description: model.description ?? "",
    ...CODEX_CONSTANT_FIELDS,
    priority: CODEX_FIREWORKS_PRIORITY,
    // Guardian auto-review defaults to the OpenAI-only `codex-auto-review`
    // model, which the Fireworks gateway has no deployment for (404 on
    // /responses, fail-closed denial). Pin the reviewer to this same servable
    // slug so `approvals_reviewer = "auto_review"` routes through Fireworks.
    // Older Codex clients ignore unknown catalog fields, so this is safe.
    auto_review_model_override: slug,
    input_modalities: supportsImageInput ? ["text", "image"] : ["text"],
    supports_parallel_tool_calls: supportsTools,
    supported_reasoning_levels: reasoning.levels,
    reasoning_summary_format: reasoningSummaryFormat,
    web_search_tool_type: supportsImageInput ? "text_and_image" : "text",
    supports_image_detail_original: supportsImageInput,
    context_window: contextLength,
    max_context_window: contextLength,
    auto_compact_token_limit: codexAutoCompactTokenLimit(contextLength),
  };
}

export function buildCodexCatalogEntryForRouter(routerId, baseModel, displayName) {
  const entry = buildCodexCatalogEntry(baseModel);
  const slug = fireworksModelSlug(routerId);
  return {
    ...entry,
    slug,
    auto_review_model_override: slug,
    display_name: displayName,
  };
}

/**
 * Codex catalog row for firerouter or a selected firerouter* model.
 * Shares FireRouter static metadata (context, vision, tools, tagline).
 * No default effort is set: the row advertises the ladder and Codex applies
 * its own default.
 */
export function buildCodexFirerouterCatalogEntry(modelId = FIREROUTER_ROUTER_ID) {
  const spec = lookupModelSpec(modelId);
  const stored = shortFireworksModelRef(modelId);
  const exact = isFirerouterModel(modelId);
  const slug = exact ? "firerouter" : stored;
  let displayName = firerouterDisplayName(stored);
  if (exact) {
    displayName = spec?.label ?? "FireRouter";
  } else if (stored === CODEX_FIREROUTER_ROUTE) {
    displayName = "FireRouter";
  }
  return {
    ...buildCodexCatalogEntry({
      name: FIREROUTER_ROUTER_ID,
      displayName,
      description: firerouterTagline(stored),
      contextLength: spec?.capabilities.contextWindow ?? 0,
      supportsImageInput: spec?.capabilities.vision ?? false,
      supportsTools: spec?.capabilities.toolCalling ?? true,
    }),
    // Path-shaped IDs must keep the full short ref; last-segment slug would collide.
    slug,
    auto_review_model_override: slug,
  };
}

/**
 * GPT families listed for Codex's sign-in when stock Codex's own list can't be
 * read (no Codex on PATH, or the probe failed), newest model of each.
 * The Fireworks gateway hands `gpt-*` IDs to FireRouter, which bills them to
 * that sign-in. models.dev can't say which models a ChatGPT plan pays for, so
 * the families are fixed here and models.dev picks the model.
 */
const CODEX_OPENAI_FAMILIES = Object.freeze(["astra", "sol", "luna"]);
// Each family's newest model when this release shipped. Used until the
// models.dev cache is warm (first run offline, or a cache from an older release).
const CODEX_OPENAI_FALLBACK_IDS = Object.freeze({
  astra: "gpt-6-astra",
  sol: "gpt-6.1-sol",
  luna: "gpt-6-luna",
});
// A versioned family model (`gpt-6.1-sol`); aliases such as `gpt-5.6` share
// the family on models.dev but aren't listed.
const CODEX_OPENAI_ID_RE = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/;
const CODEX_OPENAI_FALLBACK_CONTEXT_WINDOW = 1_050_000;

/** Compare dotted versions numerically: "6.1" > "6" > "5.6". */
function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * GPT models from stock Codex's own catalog, in its picker order (priority).
 * The gateway hands only `gpt-*` IDs to FireRouter, so other rows are left out.
 * @param {Array<{ id: string }> | null} stock
 */
function stockGptIds(stock) {
  return (stock ?? [])
    .filter((row) => row.slug.startsWith("gpt-"))
    .toSorted((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))
    .map((row) => row.slug);
}

/**
 * The OpenAI model IDs Codex's picker lists: the GPT models stock Codex lists
 * for the user's sign-in, else the highest-versioned models.dev model in each
 * family, else that family's fallback.
 * @param {Record<string, { family?: string }>} [modelsDev] models.dev's OpenAI rows, keyed by model ID
 * @param {Array<{ id: string }> | null} [stock] stock Codex's model list
 * @returns {string[]}
 */
export function codexOpenaiModelIds(modelsDev = cachedListRateTable("openai"), stock = cachedCodexStockModels()) {
  const fromCodex = stockGptIds(stock);
  if (fromCodex.length) {
    return fromCodex;
  }
  const newest = new Map();
  for (const [id, row] of Object.entries(modelsDev ?? {})) {
    const match = CODEX_OPENAI_ID_RE.exec(id);
    if (!match || row?.family !== `gpt-${match[2]}`) {
      continue;
    }
    const [, version, family] = match;
    const current = newest.get(family);
    if (!current || compareVersions(version, current.version) > 0) {
      newest.set(family, { id, version });
    }
  }
  return CODEX_OPENAI_FAMILIES.map(
    (family) => newest.get(family)?.id ?? CODEX_OPENAI_FALLBACK_IDS[family],
  );
}

/**
 * Whether `slug` is one of the OpenAI models Codex's sign-in pays for: a
 * listed one, or a shipped fallback so a model picked from an older list stays on.
 * @param {string} slug
 * @param {Record<string, { family?: string }>} [modelsDev]
 */
export function isCodexOpenaiModelSlug(slug, modelsDev = cachedListRateTable("openai")) {
  if (typeof slug !== "string" || !slug) {
    return false;
  }
  return Object.values(CODEX_OPENAI_FALLBACK_IDS).includes(slug)
    || codexOpenaiModelIds(modelsDev).includes(slug);
}

/** `gpt-6.1-sol` -> `GPT-6.1 Sol`, for when models.dev has no name yet. */
function fallbackOpenaiLabel(id) {
  const match = /^gpt-([\d.]+)-(.+)$/.exec(id);
  return match ? `GPT-${match[1]} ${match[2][0].toUpperCase()}${match[2].slice(1)}` : id;
}

/**
 * Stock Codex's own row for `id`, unchanged except for what the Fireworks route
 * needs: the transport fields and a reviewer Fireworks serves. A GPT model
 * behaves as it does in stock Codex. Without a stock row, one built from
 * models.dev.
 * @param {string} id
 * @param {Record<string, { label?: string, contextWindow?: number, imageInput?: boolean }>} [modelsDev]
 *   models.dev's OpenAI rows, keyed by model ID
 * @param {Array<{ slug: string }> | null} [stock] stock Codex's catalog rows
 */
export function buildCodexOpenaiCatalogEntry(
  id,
  modelsDev = cachedListRateTable("openai"),
  stock = cachedCodexStockModels(),
) {
  const native = stock?.find((row) => row.slug === id);
  if (native) {
    return {
      ...native,
      ...CODEX_TRANSPORT_FIELDS,
      // Codex's auto-review model isn't served on Fireworks; review with this one.
      auto_review_model_override: id,
    };
  }
  const row = modelsDev[id] ?? {};
  const label = row.label || fallbackOpenaiLabel(id);
  return {
    ...buildCodexCatalogEntry({
      name: id,
      displayName: label,
      description: `Every turn on ${label}, paid by your Codex sign-in.`,
      contextLength: row.contextWindow ?? CODEX_OPENAI_FALLBACK_CONTEXT_WINDOW,
      supportsImageInput: row.imageInput ?? true,
      supportsTools: true,
    }),
    slug: id,
    auto_review_model_override: id,
    default_reasoning_level: "medium",
  };
}

/**
 * Codex's one FireRouter row, labelled just "FireRouter" and printed as
 * `firerouter`. Requests name the GPT Astra route, so FireRouter pairs open
 * models with GPT Astra; `codex on --model firerouter` selects it.
 */
export const CODEX_FIREROUTER_ROUTE = FIREROUTER_ASTRA_ROUTE;

/** The model ID FireConnect prints for Codex: the FireRouter row reads as `firerouter`. */
export function codexDisplayModelId(model) {
  return shortFireworksModelRef(model) === CODEX_FIREROUTER_ROUTE ? FIREROUTER_MODEL_ID : model;
}

/**
 * `models` with the FireRouter row and OpenAI models Codex's sign-in can
 * use, rebuilt as one block at the top (their metadata is static, so a re-`on`
 * refreshes it); the remaining rows keep their order. The serverless catalog's
 * bare `firerouter` row is dropped, so the picker offers one FireRouter row.
 * @param {Array<{ slug?: string }>} models
 */
export function withCodexSignInRows(models = []) {
  const block = [
    { ...buildCodexFirerouterCatalogEntry(CODEX_FIREROUTER_ROUTE), priority: CODEX_FIREROUTER_PRIORITY },
    ...codexOpenaiModelIds().map((id) => buildCodexOpenaiCatalogEntry(id)),
  ];
  const blockSlugs = new Set(block.map((row) => row.slug));
  return [
    ...block,
    ...models.filter((row) => !blockSlugs.has(row?.slug) && row?.slug !== FIREROUTER_MODEL_ID),
  ];
}

/**
 * The sign-in block's model IDs that `models` lacks: the FireRouter row and the
 * newest OpenAI model of each family. Empty when the picker is current.
 * @param {Array<{ slug?: string }>} models
 * @returns {string[]}
 */
export function missingCodexSignInRows(models = []) {
  const slugs = new Set(models.map((row) => row?.slug));
  return [CODEX_FIREROUTER_ROUTE, ...codexOpenaiModelIds()].filter((id) => !slugs.has(id));
}

export const AUTO_TAGLINE = "Routes each user turn across Fireworks open models.";
export const AUTO_INSTANT_TAGLINE =
  "Routes each user turn across the fastest Fireworks open models.";

/** Codex catalog row for `auto` / `auto-*`, built from that mix's spec. */
export function buildCodexAutoCatalogEntry(modelId = AUTO_MODEL_ID) {
  const spec = lookupModelSpec(modelId);
  const stored = canonicalAutoModelId(modelId) || shortFireworksModelRef(modelId);
  return {
    ...buildCodexCatalogEntry({
      name: stored,
      displayName: autoDisplayName(stored),
      description: stored === AUTO_INSTANT_MODEL_ID ? AUTO_INSTANT_TAGLINE : AUTO_TAGLINE,
      contextLength: spec?.capabilities.contextWindow ?? 0,
      supportsImageInput: spec?.capabilities.vision ?? false,
      supportsTools: spec?.capabilities.toolCalling ?? true,
    }),
    slug: stored,
    auto_review_model_override: stored,
  };
}

/** Whether a catalog row has a usable context window. */
export function codexRowHasUsableContext(row) {
  return (row?.context_window ?? row?.max_context_window ?? 0) > 0;
}

function findSnapshotEntry(snapshot, modelId) {
  if (!modelId) {
    return null;
  }
  if (modelId.startsWith("accounts/fireworks/")) {
    return (snapshot?.entries ?? []).find((entry) => entry?.id === modelId) ?? null;
  }
  return (snapshot?.entries ?? []).find((entry) => entry?.shortId === modelId) ?? null;
}

function codexRowMatchesModelId(row, modelId) {
  return codexCatalogContainsModel({ models: [row] }, modelId);
}

/** Remove rows no longer present in the serverless catalog. */
export function pruneCodexCatalogRows(models = [], snapshot = null) {
  return models.filter((row) => {
    const slug = typeof row?.slug === "string" ? row.slug : "";
    if (!slug || isCodexUnsupportedMiniMaxModel(slug)) {
      return false;
    }
    return isFirerouterModelPattern(slug)
      || isAutoModelId(slug)
      || isCodexOpenaiModelSlug(slug)
      || Boolean(findSnapshotEntry(snapshot, slug));
  });
}

/**
 * Re-`on` refresh of a managed catalog, per the shared catalog-refresh policy:
 * prune delisted rows, append rows newly served by serverless, and re-render
 * kept rows from the fresh catalog (display names / context windows drift).
 * The catalog file is fireconnect-owned, so the picker tracks the live catalog
 * instead of going stale until the next fresh setup or upgrade.
 * Kept rows keep their position; only their metadata is replaced. Rows the
 * fresh catalog does not serve (e.g. a `--model firerouter/<path>` pick) are
 * carried over verbatim: an already-written `default_reasoning_level` may be
 * the user's own override, and fireconnect cannot tell it apart from its own
 * write, so it is left alone.
 */
export function refreshCodexCatalogRows(models = [], snapshot = null, freshModels = []) {
  const freshBySlug = new Map();
  for (const row of freshModels) {
    const slug = typeof row?.slug === "string" ? row.slug : "";
    if (slug && !freshBySlug.has(slug)) {
      freshBySlug.set(slug, row);
    }
  }
  const plan = planCatalogRefresh({
    currentIds: models.map((row) => (typeof row?.slug === "string" ? row.slug : "")),
    freshIds: [...freshBySlug.keys()],
    keepUnserved: (slug) => (
      !isCodexUnsupportedMiniMaxModel(slug)
      && (isFirerouterModelPattern(slug)
        || isAutoModelId(slug)
        || isCodexOpenaiModelSlug(slug)
        || Boolean(findSnapshotEntry(snapshot, slug)))
    ),
  });
  const keptSet = new Set(plan.kept);
  const emitted = new Set();
  return [
    ...models
      .filter((row) => {
        const slug = typeof row?.slug === "string" ? row.slug : "";
        if (!keptSet.has(slug) || emitted.has(slug)) {
          return false;
        }
        emitted.add(slug);
        return true;
      })
      .map((row) => freshBySlug.get(row.slug) ?? row),
    ...plan.added.map((slug) => freshBySlug.get(slug)).filter(Boolean),
  ];
}

/** Add the selected model without changing existing rows. */
export function addCodexSelectedModel(models, catalog, modelId) {
  if (models.some((row) => codexRowMatchesModelId(row, modelId))) {
    return models;
  }
  let entry;
  if (isFirerouterModelPattern(modelId)) {
    entry = buildCodexFirerouterCatalogEntry(modelId);
  } else if (isAutoModelId(modelId)) {
    entry = buildCodexAutoCatalogEntry(modelId);
  } else if (isCodexOpenaiModelSlug(modelId)) {
    entry = buildCodexOpenaiCatalogEntry(modelId);
  } else {
    entry = catalog?.models?.find((row) => codexRowMatchesModelId(row, modelId));
  }
  return entry ? [...models, entry] : models;
}

const EXCLUDED_KINDS = new Set(["EMBEDDING_MODEL", "FLUMINA_BASE_MODEL"]);

function isCodexSuitable(model) {
  if (isCodexUnsupportedMiniMaxModel(model.name)) {
    return false;
  }
  if (EXCLUDED_KINDS.has(model.kind)) {
    return false;
  }
  const { contextLength, supportsTools } = effectiveModelFields(model);
  if (!supportsTools) {
    return false;
  }
  return contextLength > 0;
}

export function buildCodexCatalog(apiModels) {
  return buildCodexCatalogFromSnapshot(buildServerlessCatalogSnapshot(apiModels), apiModels);
}

function snapshotModelMetadata(snapshot, modelId) {
  const entry = snapshot.entries.find((candidate) => candidate.id === modelId);
  const inputModalities = snapshot.inputModalitiesById.get(modelId) ?? [];
  const contextLength = snapshot.contextLengthById.get(modelId) ?? 0;
  const supportsTools = snapshot.supportsToolsById.get(modelId)
    ?? DEFAULT_MODEL_CAPABILITIES.toolCalling;
  if (!entry) {
    // The entry row itself can be pruned from the iterated set while the
    // snapshot maps still carry its metadata: preferLatestAliases drops base
    // models whose family has a -latest alias, so offline/stale-cache builds
    // (no rawModels to borrow from) would otherwise lose every alias router.
    // Synthesize from the maps; ids the snapshot never saw stay null.
    if (!snapshot.contextLengthById.has(modelId)
      && !snapshot.inputModalitiesById.has(modelId)
      && !snapshot.supportsToolsById.has(modelId)) {
      return null;
    }
    return {
      name: modelId,
      displayName: prettyModelName(modelId),
      contextLength,
      supportsImageInput: rowSupportsImageInput({ inputModalities }),
      supportsTools,
    };
  }
  return {
    name: modelId,
    displayName: entry.displayName,
    contextLength,
    supportsImageInput: rowSupportsImageInput({ inputModalities }),
    supportsTools,
  };
}

/** Build Codex metadata from the serverless snapshot. */
export function buildCodexCatalogFromSnapshot(snapshot, apiModels) {
  const byName = new Map();
  for (const model of apiModels) {
    const id = model?.name ?? model?.id;
    if (id) {
      byName.set(id, model);
    }
  }

  const models = [];
  for (const entry of snapshot.entries) {
    // The registerable set synthesizes the `auto` mix (see
    // catalogWithAutomaticAuto); it has no serverless row to borrow metadata
    // from, so it gets its static-spec row like an explicit `--model auto`.
    if (isAutoModelId(entry.id) || isAutoModelId(entry.shortId)) {
      models.push(buildCodexAutoCatalogEntry(
        canonicalAutoModelId(entry.shortId) || canonicalAutoModelId(entry.id) || AUTO_MODEL_ID,
      ));
      continue;
    }
    if (entry.id === FIREROUTER_ROUTER_ID) {
      models.push(buildCodexFirerouterCatalogEntry(FIREROUTER_ROUTER_ID));
      continue;
    }
    if (entry.baseModelId) {
      if (isCodexUnsupportedMiniMaxModel(entry.id)
        || isCodexUnsupportedMiniMaxModel(entry.baseModelId)) {
        continue;
      }
      const baseModel = byName.get(entry.baseModelId)
        ?? snapshotModelMetadata(snapshot, entry.baseModelId);
      if (baseModel) {
        // Flat API rows are keyed `id`, not `name`; stamp the resource id on so
        // the catalog entry builder (reasoningConfigFor etc.) sees a model ref.
        models.push(
          buildCodexCatalogEntryForRouter(entry.id, { ...baseModel, name: entry.baseModelId }, routerDisplayName(entry.id)),
        );
      }
      continue;
    }

    const model = byName.get(entry.id) ?? snapshotModelMetadata(snapshot, entry.id);
    if (model && isCodexSuitable({ ...model, name: entry.id })) {
      models.push(buildCodexCatalogEntry({ ...model, name: entry.id }));
    }
  }

  return { models };
}

/**
 * Limit interactive picker entries to models present in the Codex metadata catalog.
 * @param {import("../../fireworks/models.mjs").CatalogEntry[]} pickerCatalog
 * @param {{ models: Array<{ slug: string }> } | null} codexCatalog
 */
export function filterPickerCatalogForCodex(pickerCatalog, codexCatalog) {
  if (!pickerCatalog?.length) {
    return pickerCatalog ?? [];
  }
  if (!codexCatalog) {
    return pickerCatalog;
  }
  const slugs = new Set(
    (codexCatalog.models ?? []).map((entry) => fireworksModelSlug(entry.slug)),
  );
  if (slugs.size === 0) {
    return [];
  }
  return pickerCatalog.filter((entry) => slugs.has(fireworksModelSlug(entry.id)));
}

export function codexCatalogContainsModel(catalog, modelId) {
  if (!catalog?.models?.length || !modelId) {
    return false;
  }
  const stored = shortFireworksModelRef(modelId);
  return catalog.models.some(
    (entry) => shortFireworksModelRef(entry.slug) === stored,
  );
}
