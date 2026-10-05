import { isPlainObject } from './loader.ts';

/** Collects every problem in one pass so an operator sees all of them at once. */
export class Reader {
  errors: string[] = [];
  warnings: string[] = [];

  section(root: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = root[key];
    if (value === undefined || value === null) return {};
    if (!isPlainObject(value)) {
      this.errors.push(`${key} must be a map`);
      return {};
    }
    return value;
  }

  string(obj: Record<string, unknown>, key: string, field: string): string | null {
    const value = obj[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
      this.errors.push(`${field} must be a string`);
      return null;
    }
    return value;
  }

  script(obj: Record<string, unknown>, key: string, field: string): string | null {
    const value = this.string(obj, key, field);
    return value !== null && value.trim() !== '' ? value : null;
  }

  int(obj: Record<string, unknown>, key: string, field: string, fallback: number, min: number): number {
    const value = obj[key];
    if (value === undefined || value === null) return fallback;
    const parsed = parseInteger(value);
    if (parsed === null || parsed < min) {
      this.errors.push(`${field} must be an integer >= ${min} (got ${JSON.stringify(value)})`);
      return fallback;
    }
    return parsed;
  }

  number(obj: Record<string, unknown>, key: string, field: string): number | null {
    const value = obj[key];
    if (value === undefined || value === null) return null;
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      this.errors.push(`${field} must be a positive number (got ${JSON.stringify(value)})`);
      return null;
    }
    return parsed;
  }

  bool(obj: Record<string, unknown>, key: string, field: string, fallback: boolean): boolean {
    const value = obj[key];
    if (value === undefined || value === null) return fallback;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    this.errors.push(`${field} must be true or false`);
    return fallback;
  }

  stringList(obj: Record<string, unknown>, key: string, field: string): string[] | null {
    const value = obj[key];
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      this.errors.push(`${field} must be a list of strings`);
      return null;
    }
    return value as string[];
  }

  stringMap(obj: Record<string, unknown>, key: string, field: string): Record<string, string> {
    const value = obj[key];
    const result: Record<string, string> = {};
    if (value === undefined || value === null) return result;
    if (!isPlainObject(value)) {
      this.errors.push(`${field} must be a map of names to strings`);
      return result;
    }
    for (const [name, item] of Object.entries(value)) {
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') result[name] = String(item);
      else this.errors.push(`${field}.${name} must be a string`);
    }
    return result;
  }

  oneOf<T extends string>(obj: Record<string, unknown>, key: string, field: string, allowed: readonly T[], fallback: T): T;
  oneOf<T extends string>(obj: Record<string, unknown>, key: string, field: string, allowed: readonly T[], fallback: null): T | null;
  oneOf<T extends string>(obj: Record<string, unknown>, key: string, field: string, allowed: readonly T[], fallback: T | null): T | null {
    const value = this.string(obj, key, field);
    if (value === null) return fallback;
    if (!(allowed as readonly string[]).includes(value)) {
      this.errors.push(`${field} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`);
      return fallback;
    }
    return value as T;
  }
}

export function parseInteger(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}
