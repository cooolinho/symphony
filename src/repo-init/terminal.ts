import readline from 'node:readline';

export interface MenuItem<T> {
  label: string;
  value: T;
}

/** Line-based prompts on an input/output pair: a terminal, or pipes in tests. */
export class Terminal {
  #output: NodeJS.WritableStream;
  #readline: readline.Interface;
  #lines: AsyncIterator<string>;

  constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
    this.#output = output;
    this.#readline = readline.createInterface({ input, terminal: false });
    // The iterator queues lines, so answers that arrive before their question (piped input) are not lost.
    this.#lines = this.#readline[Symbol.asyncIterator]();
  }

  print(text = ''): void {
    this.#output.write(`${text}\n`);
  }

  /** Shows the question and returns the trimmed answer, or null once the input has ended. */
  async ask(question: string): Promise<string | null> {
    this.#output.write(`${question} `);
    const line = await this.#lines.next();
    if (line.done === true) {
      this.#output.write('\n');
      return null;
    }
    return line.value.trim();
  }

  /** Yes/no question; Enter takes the default. Null once the input has ended. */
  async confirm(question: string, defaultYes: boolean): Promise<boolean | null> {
    for (;;) {
      const answer = await this.ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'}`);
      if (answer === null) return null;
      if (answer === '') return defaultYes;
      if (/^(y|yes|j|ja)$/i.test(answer)) return true;
      if (/^(n|no|nein)$/i.test(answer)) return false;
      this.print('Please answer y or n.');
    }
  }

  /** Numbered list plus "0) Exit"; Enter picks the first item. Null for 0 or once the input has ended. */
  async choose<T>(question: string, items: ReadonlyArray<MenuItem<T>>): Promise<T | null> {
    items.forEach((item, index) => this.print(`  ${index + 1}) ${item.label}`));
    this.print('  0) Exit');
    for (;;) {
      const answer = await this.ask(`${question} [1]:`);
      if (answer === null) return null;
      const number = answer === '' ? 1 : Number(answer);
      if (number === 0) return null;
      const item = Number.isInteger(number) ? items[number - 1] : undefined;
      if (item !== undefined) return item.value;
      this.print(`Please enter a number from 0 to ${items.length}.`);
    }
  }

  /** Numbered list; the answer is a list of numbers ("1,3"), Enter selects all. Null once the input has ended. */
  async chooseMany<T>(question: string, items: ReadonlyArray<MenuItem<T>>): Promise<T[] | null> {
    items.forEach((item, index) => this.print(`  ${index + 1}) ${item.label}`));
    for (;;) {
      const answer = await this.ask(`${question} (Enter = all, or numbers like 1,2):`);
      if (answer === null) return null;
      if (answer === '') return items.map((item) => item.value);
      const picked = [...new Set(answer.split(/[\s,]+/).filter((part) => part !== '').map(Number))]
        .sort((a, b) => a - b)
        .map((number) => (Number.isInteger(number) ? items[number - 1] : undefined));
      if (picked.length > 0 && picked.every((item) => item !== undefined)) return picked.map((item) => (item as MenuItem<T>).value);
      this.print(`Please enter numbers from 1 to ${items.length}, separated by commas.`);
    }
  }

  close(): void {
    this.#readline.close();
  }
}
