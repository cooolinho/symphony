import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: string): value is LogLevel {
  return value in LEVEL_RANK;
}

export interface LogSink {
  readonly name: string;
  write(line: string): void;
  close?(): Promise<void>;
}

export class StderrSink implements LogSink {
  readonly name = 'stderr';

  write(line: string): void {
    process.stderr.write(`${line}\n`);
  }
}

/** Size from which a log file is rotated to `<file>.1` (one old file is kept). */
export const LOG_FILE_MAX_BYTES = 50 * 1024 * 1024;

/** Appends to a file, rotating it to `<file>.1` past `maxBytes`. Write errors surface asynchronously through `onError`. */
export class FileSink implements LogSink {
  readonly name: string;
  #path: string;
  #maxBytes: number;
  #size: number;
  #onError: (error: Error) => void;
  #stream: fs.WriteStream;

  constructor(filePath: string, onError: (sink: FileSink, error: Error) => void, maxBytes: number = LOG_FILE_MAX_BYTES) {
    this.name = `file:${filePath}`;
    this.#path = filePath;
    this.#maxBytes = maxBytes;
    this.#onError = (error) => onError(this, error);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.#size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    this.#stream = this.#open();
  }

  /** Opens the file synchronously, so it exists before the first rotation can rename it. */
  #open(): fs.WriteStream {
    const stream = fs.createWriteStream(this.#path, { fd: fs.openSync(this.#path, 'a') });
    stream.on('error', this.#onError);
    return stream;
  }

  write(line: string): void {
    const text = `${line}\n`;
    if (this.#size > 0 && this.#size + Buffer.byteLength(text) > this.#maxBytes) this.#rotate();
    this.#stream.write(text);
    this.#size += Buffer.byteLength(text);
  }

  #rotate(): void {
    try {
      fs.renameSync(this.#path, `${this.#path}.1`);
    } catch {
      // Keep writing to the current file; the next write tries again.
      return;
    }
    // Lines still queued in the old stream land in the renamed file: it keeps the same inode.
    this.#stream.end();
    this.#size = 0;
    this.#stream = this.#open();
  }

  /** Resolves once everything written so far has reached the file. */
  close(): Promise<void> {
    return new Promise((resolve) => this.#stream.end(() => resolve()));
  }
}

/** Fans lines out to every healthy sink; a failing sink is dropped with a warning on the others. */
class SinkSet {
  #sinks: LogSink[] = [];

  add(sink: LogSink): void {
    this.#sinks.push(sink);
  }

  write(line: string): void {
    for (const sink of [...this.#sinks]) {
      try {
        sink.write(line);
      } catch (error) {
        this.fail(sink, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  fail(sink: LogSink, error: Error): void {
    if (!this.#sinks.includes(sink)) return;
    this.#sinks = this.#sinks.filter((s) => s !== sink);
    const line = formatLine(new Date(), 'warn', 'log sink failed; continuing without it', {
      sink: sink.name,
      error: error.message,
    });
    for (const remaining of this.#sinks) {
      try {
        remaining.write(line);
      } catch {
        // A second failure is reported by the next write.
      }
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.#sinks.map((sink) => sink.close?.()));
  }
}

export interface LoggerOptions {
  level?: LogLevel;
  file?: string | null;
  sinks?: LogSink[];
}

/** Structured `key=value` logger. Child loggers carry context fields such as issue_id. */
export class Logger {
  #sinks: SinkSet;
  #level: LogLevel;
  #fields: LogFields;

  private constructor(sinks: SinkSet, level: LogLevel, fields: LogFields) {
    this.#sinks = sinks;
    this.#level = level;
    this.#fields = fields;
  }

  static create(options: LoggerOptions = {}): Logger {
    const sinks = new SinkSet();
    for (const sink of options.sinks ?? [new StderrSink()]) sinks.add(sink);
    if (options.file) sinks.add(new FileSink(options.file, (sink, error) => sinks.fail(sink, error)));
    return new Logger(sinks, options.level ?? 'info', {});
  }

  /** A logger that discards everything (tests). */
  static silent(): Logger {
    return Logger.create({ sinks: [], level: 'error' });
  }

  child(fields: LogFields): Logger {
    return new Logger(this.#sinks, this.#level, { ...this.#fields, ...fields });
  }

  debug(msg: string, fields?: LogFields): void {
    this.log('debug', msg, fields);
  }

  info(msg: string, fields?: LogFields): void {
    this.log('info', msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.log('warn', msg, fields);
  }

  error(msg: string, fields?: LogFields): void {
    this.log('error', msg, fields);
  }

  log(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.#level]) return;
    this.#sinks.write(formatLine(new Date(), level, msg, { ...this.#fields, ...fields }));
  }

  /** Flushes and closes file sinks; await it before the process exits. */
  close(): Promise<void> {
    return this.#sinks.close();
  }
}

export function formatLine(at: Date, level: LogLevel, msg: string, fields: LogFields): string {
  let line = `ts=${at.toISOString()} level=${level} msg=${formatValue(msg)}`;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    line += ` ${key}=${formatValue(value)}`;
  }
  return line;
}

/** Formats one value for a `key=value` line: bare when safe, otherwise JSON-quoted. */
export function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();
  const text = value instanceof Error ? value.message : typeof value === 'string' ? value : JSON.stringify(value);
  return /^[A-Za-z0-9_.:/@#+-]+$/.test(text) ? text : JSON.stringify(text);
}
