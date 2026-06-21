/** Tiny zero-dependency terminal UI helpers (colors + spinner). */

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = wrap("2");
export const bold = wrap("1");
export const orange = wrap("38;5;208");
export const green = wrap("32");
export const red = wrap("31");
export const cyan = wrap("36");

/** Branded header line. */
export function header(text: string): void {
  console.log(`\n${orange("🍊 laranja")} ${dim("·")} ${bold(text)}\n`);
}

/** A labelled step line: "  <emoji>  <label>   <detail>". */
export function step(emoji: string, label: string, detail = ""): void {
  console.log(`  ${emoji}  ${bold(label.padEnd(8))} ${detail ? dim(detail) : ""}`);
}

export function note(text: string): void {
  console.log(`     ${dim(text)}`);
}

/** A non-fatal warning line — surfaced but doesn't stop the command. */
export function warn(text: string): void {
  console.log(`  ${orange("⚠")}  ${text}`);
}

export interface Spinner {
  /** Change the live spinner text. */
  update(text: string): void;
  /** Print a permanent line above the running spinner. */
  log(line: string): void;
  succeed(text?: string): void;
  fail(text?: string): void;
  stop(): void;
}

export interface Choice<T> {
  label: string;
  value: T;
}

/**
 * Read a single line of secret input (e.g. an API key) without echoing it.
 * Shows `•` per character so the user sees progress. Returns the trimmed value,
 * or `undefined` if cancelled (Esc / Ctrl-C) or there's no TTY to read from.
 * Cross-platform: uses raw stdin, which Node supports on Windows/macOS/Linux.
 */
export function promptSecret(question: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) return resolve(undefined);

    let value = "";
    stdout.write(`  ${question} `);

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
    };

    const onData = (buf: Buffer) => {
      const key = buf.toString();
      if (key === "\r" || key === "\n") {
        cleanup();
        resolve(value.trim() || undefined);
      } else if (key === "\x03" || key === "\x1b") {
        cleanup(); // Ctrl-C / Esc
        resolve(undefined);
      } else if (key === "\x7f" || key === "\b") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          stdout.write("\b \b"); // erase one masked char
        }
      } else {
        value += key;
        stdout.write("•");
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/**
 * A zero-dependency arrow-key picker. Returns the chosen value, or undefined if
 * the user cancels (q / Esc / Ctrl-C). Requires a TTY — callers must handle the
 * non-TTY case themselves (there's no interactive input to read).
 */
export function select<T>(title: string, choices: Choice<T>[]): Promise<T | undefined> {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    let i = 0;

    const render = (first: boolean) => {
      if (!first) stdout.write(`\x1b[${choices.length + 1}A`); // move cursor back up over the list
      stdout.write(`\x1b[J  ${dim(title)}\n`);
      choices.forEach((c, n) => {
        const cursor = n === i ? orange("❯") : " ";
        const label = n === i ? bold(c.label) : c.label;
        stdout.write(`  ${cursor} ${label}\n`);
      });
    };

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const onData = (buf: Buffer) => {
      const key = buf.toString();
      if (key === "\x1b[A" || key === "k") i = (i - 1 + choices.length) % choices.length;
      else if (key === "\x1b[B" || key === "j") i = (i + 1) % choices.length;
      else if (key === "\r" || key === "\n") {
        cleanup();
        render(false); // leave the final selection on screen
        resolve(choices[i].value);
        return;
      } else if (key === "\x03" || key === "\x1b" || key === "q") {
        cleanup();
        render(false);
        resolve(undefined);
        return;
      }
      render(false);
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    render(true);
  });
}

/** A braille spinner that degrades to plain lines on non-TTY output. */
export function spinner(initial: string): Spinner {
  let text = initial;

  if (!process.stdout.isTTY) {
    console.log(`  ⏳ ${initial}`);
    return {
      update: () => {},
      log: (line) => console.log(line),
      succeed: (t) => t && console.log(`  ✅ ${t}`),
      fail: (t) => t && console.log(`  ${red("❌")} ${t}`),
      stop: () => {},
    };
  }

  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const render = () => process.stdout.write(`\r\x1b[K  ${orange(frames[(i = (i + 1) % frames.length)])} ${text}`);
  const id = setInterval(render, 80);
  render();

  const end = (mark: string, t?: string) => {
    clearInterval(id);
    process.stdout.write("\r\x1b[K");
    if (t) console.log(`  ${mark} ${t}`);
  };

  return {
    update: (t) => {
      text = t;
    },
    log: (line) => {
      process.stdout.write("\r\x1b[K");
      console.log(line); // next render tick redraws the spinner below it
    },
    succeed: (t) => end("✅", t),
    fail: (t) => end(red("❌"), t),
    stop: () => end(""),
  };
}
