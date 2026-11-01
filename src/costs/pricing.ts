import fs from 'node:fs';
import YAML from 'yaml';
import { contextWindowSuffix } from '../agent/model-name.ts';
import type { Logger } from '../log.ts';
import { SymphonyError, errorMessage } from '../util/errors.ts';
import { isPlainObject } from '../workflow/loader.ts';

/** Prices in USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Token counts of one model, with uncached input and cache traffic kept apart (they are priced differently). */
export interface ModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface PricingTable {
  defaultPrice: ModelPrice;
  /** Lowercased model keys from model-costs.yml (ids like `claude-opus-5-5` or names like `opus`). */
  models: Map<string, ModelPrice>;
  /** `context_window` of the `default` entry (tokens), or null when the file sets none. */
  defaultContextWindow: number | null;
  /** `context_window` per model key, only for entries that set it. */
  contextWindows: Map<string, number>;
  /** File the table came from, or null for the built-in fallback. */
  source: string | null;
}

/** Cache reads cost 10% and cache writes 125% of the input price unless the file says otherwise. */
const CACHE_READ_FACTOR = 0.1;
const CACHE_WRITE_FACTOR = 1.25;
const PER_TOKEN = 1 / 1_000_000;

/** Used when model-costs.yml is missing or has no `default` entry. */
export const FALLBACK_PRICE: ModelPrice = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

export function emptyUsage(): ModelTokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function totalTokens(usage: ModelTokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

export function addUsage(target: ModelTokenUsage, usage: ModelTokenUsage): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cacheReadTokens += usage.cacheReadTokens;
  target.cacheWriteTokens += usage.cacheWriteTokens;
}

function parsePrice(value: unknown, key: string): ModelPrice {
  if (!isPlainObject(value)) {
    throw new SymphonyError('invalid_model_costs', `${key} must be a map with input and output prices (USD per million tokens)`);
  }
  const number = (field: string, fallback?: number): number => {
    const raw = value[field];
    if (raw === undefined || raw === null) {
      if (fallback !== undefined) return fallback;
      throw new SymphonyError('invalid_model_costs', `${key}.${field} is required (USD per million tokens)`);
    }
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new SymphonyError('invalid_model_costs', `${key}.${field} must be a number >= 0 (got ${JSON.stringify(raw)})`);
    }
    return parsed;
  };
  const input = number('input');
  return {
    input,
    output: number('output'),
    cacheRead: number('cache_read', input * CACHE_READ_FACTOR),
    cacheWrite: number('cache_write', input * CACHE_WRITE_FACTOR),
  };
}

function parseContextWindow(value: unknown, key: string): number | undefined {
  if (!isPlainObject(value)) return undefined;
  const raw = value.context_window;
  if (raw === undefined || raw === null) return undefined;
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new SymphonyError('invalid_model_costs', `${key}.context_window must be a positive whole number of tokens (got ${JSON.stringify(raw)})`);
  }
  return parsed;
}

/** Parses model-costs.yml: a `default` entry plus one entry per model id or model name. */
export function parsePricing(text: string, source: string | null): PricingTable {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (error) {
    throw new SymphonyError('invalid_model_costs', `invalid YAML: ${errorMessage(error)}`, { cause: error });
  }
  if (raw === null || raw === undefined) raw = {};
  if (!isPlainObject(raw)) throw new SymphonyError('invalid_model_costs', 'model-costs.yml must be a map of model names to prices');

  let defaultPrice = FALLBACK_PRICE;
  const models = new Map<string, ModelPrice>();
  const contextWindows = new Map<string, number>();
  let defaultContextWindow: number | null = null;
  for (const [key, value] of Object.entries(raw)) {
    const name = key.trim().toLowerCase();
    if (name === '') continue;
    const contextWindow = parseContextWindow(value, key);
    if (name === 'default') {
      defaultPrice = parsePrice(value, key);
      defaultContextWindow = contextWindow ?? null;
    } else {
      models.set(name, parsePrice(value, key));
      if (contextWindow !== undefined) contextWindows.set(name, contextWindow);
    }
  }
  return { defaultPrice, models, defaultContextWindow, contextWindows, source };
}

/**
 * Price for a model id as reported by Claude Code (e.g. `claude-opus-5-5`): an exact key wins,
 * then the longest key contained in the id (`opus`, `sonnet`, …), then `default`.
 */
export function priceFor(table: PricingTable, model: string): { price: ModelPrice; key: string } {
  const key = matchKey(table, model);
  if (key !== null) return { price: table.models.get(key) as ModelPrice, key };
  return { price: table.defaultPrice, key: 'default' };
}

/** The table key for a model id: an exact key, else the longest key contained in the id, else null. */
function matchKey(table: PricingTable, model: string): string | null {
  const id = model.trim().toLowerCase();
  if (table.models.has(id)) return id;
  let best: string | null = null;
  for (const key of table.models.keys()) {
    if (id.includes(key) && (best === null || key.length > best.length)) best = key;
  }
  return best;
}

/**
 * Context window (tokens) of a model: a "[1m]" suffix wins, then the `context_window` of the entry
 * matched like a price, then the `default` entry. Null when none of them sets a size.
 */
export function contextWindowFor(table: PricingTable, model: string): number | null {
  const suffix = contextWindowSuffix(model);
  if (suffix !== null) return suffix;
  const key = matchKey(table, model);
  const own = key === null ? undefined : table.contextWindows.get(key);
  return own ?? table.defaultContextWindow;
}

export function costOf(usage: ModelTokenUsage, price: ModelPrice): number {
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) *
    PER_TOKEN
  );
}

/** Estimated cost of per-model usage with the given table. */
export function estimateCost(table: PricingTable, usageByModel: Record<string, ModelTokenUsage>): number {
  let total = 0;
  for (const [model, usage] of Object.entries(usageByModel)) total += costOf(usage, priceFor(table, model).price);
  return total;
}

/**
 * model-costs.yml, re-read whenever the file changes, so price edits apply without a restart. An
 * invalid edit keeps the last good table and logs the problem once.
 */
export class PricingStore {
  readonly path: string;
  #logger: Logger;
  #table: PricingTable = { defaultPrice: FALLBACK_PRICE, models: new Map(), defaultContextWindow: null, contextWindows: new Map(), source: null };
  #stamp: string | null = null;
  #lastError: string | null = null;

  constructor(filePath: string, logger: Logger) {
    this.path = filePath;
    this.#logger = logger;
    this.current();
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  current(): PricingTable {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.path);
    } catch {
      if (this.#stamp !== 'missing') {
        this.#stamp = 'missing';
        this.#table = { defaultPrice: FALLBACK_PRICE, models: new Map(), defaultContextWindow: null, contextWindows: new Map(), source: null };
        this.#logger.warn('model-costs.yml not found; estimating every model at the built-in default price', { path: this.path });
      }
      return this.#table;
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (stamp === this.#stamp) return this.#table;
    this.#stamp = stamp;
    try {
      this.#table = parsePricing(fs.readFileSync(this.path, 'utf8'), this.path);
      if (this.#lastError !== null) this.#logger.info('model-costs.yml is valid again', { path: this.path });
      this.#lastError = null;
    } catch (error) {
      this.#lastError = errorMessage(error);
      this.#logger.error('model-costs.yml is invalid; keeping the previous prices', { path: this.path, error: this.#lastError });
    }
    return this.#table;
  }
}
