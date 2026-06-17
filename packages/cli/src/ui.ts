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

export interface Spinner {
  /** Change the live spinner text. */
  update(text: string): void;
  /** Print a permanent line above the running spinner. */
  log(line: string): void;
  succeed(text?: string): void;
  fail(text?: string): void;
  stop(): void;
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
