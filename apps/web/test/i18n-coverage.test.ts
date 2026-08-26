import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * Every word a member reads has to come from `i18n.ts`, otherwise picking
 * Turkish leaves English sentences behind in the interface. This walks the
 * sources the way a reader meets them and fails on any English literal that
 * never passes through `translate`.
 */

const sourceRoot = "src";

/**
 * Literals that are legitimately not translated: a brand, somebody else's
 * product name, a DOM key name, an SVG path, or a message only a developer
 * ever reads.
 */
const untranslatedByDesign = new Set([
  "Voxly",
  "The Basement",
  "X / Twitter",
  "Vimeo",
  "Spotify",
  "YouTube",
  "SoundCloud",
  "Unauthorized",
  "Request failed",
  "Set log action",
  "Microphone track replacement failed",
  "Microphone access is unavailable in this browser."
]);

const domKeyNames = /^(Escape|Enter|Tab|Backspace|Delete|Arrow(Up|Down|Left|Right)|Shift|Control|Alt|Meta|Home|End|Page(Up|Down))$/;
const httpMethods = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/;
const svgPath = /^[Mm][\d.\s-]/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name)) return [];
    // The translation tables are the one place English belongs.
    if (path.endsWith(join("lib", "i18n.ts"))) return [];
    return [path];
  });
}

/** Blanks comments so prose about the code is not read as prose in the code. */
function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (comment, prefix: string) => prefix + " ".repeat(comment.length - prefix.length));
}

/**
 * Drops type arguments. `Promise<void>` otherwise reads as the JSX text
 * `>Promise<`, and every hook signature in the codebase would be a finding.
 */
function withoutTypeArguments(line: string) {
  let current = line;
  let previous = "";
  while (current !== previous) {
    previous = current;
    current = current.replace(/(\w)<[^<>]*>/g, "$1");
  }
  return current;
}

/** Attributes and calls whose string values are addresses, not sentences. */
const machineFacing = /\b(className|href|id|role|type|name|key|src|rel|target|xmlns|viewBox|fill|stroke|htmlFor|autoComplete|inputMode|method|as|slot|form|sandbox|allow|d|storageKey|emit|on|off|getItem|setItem|removeItem|addEventListener|removeEventListener|querySelector|querySelectorAll|matchMedia|setAttribute|getAttribute|assertNever|AggregateError|Error|data-[\w-]+)\s*[=(,]?\s*$/;

function readableEnglish(value: string) {
  if (value.length < 3) return false;
  if (untranslatedByDesign.has(value)) return false;
  if (domKeyNames.test(value) || httpMethods.test(value) || svgPath.test(value)) return false;
  // Anything already carrying Turkish characters is not a leftover.
  if (/[çğıöşüÇĞİÖŞÜ]/.test(value)) return false;
  // A sentence opens with a capital and goes on in lower case; an identifier
  // such as `MediaStream` or a slug such as `voice-room` does neither.
  if (!/^[A-Z]/.test(value) || !/[a-z]/.test(value)) return false;
  // A single token carrying an identifier's punctuation is a name, a header or
  // a path rather than something anybody reads: `MediaStream`, `Content-Type`.
  if (!/\s/.test(value) && /[-/.:_]|^[A-Z][a-z]*([A-Z][a-z]*)+$/.test(value)) return false;
  return true;
}

function untranslatedLiterals() {
  const found: string[] = [];
  for (const path of sourceFiles(sourceRoot)) {
    withoutComments(readFileSync(path, "utf8")).split("\n").forEach((line, index) => {
      if (/^\s*import\b|^\s*export (type|interface)\b/.test(line)) return;
      for (const match of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        if (machineFacing.test(line.slice(0, match.index))) continue;
        if (readableEnglish(match[1])) found.push(`${path}:${index + 1}: "${match[1]}"`);
      }
      const withoutTags = withoutTypeArguments(line).replace(/<\/?[A-Za-z][\w.]*/g, "<");
      for (const match of withoutTags.matchAll(/>\s*([A-Z][^<>{}]{2,80}?)\s*</g)) {
        if (readableEnglish(match[1])) found.push(`${path}:${index + 1}: >${match[1]}<`);
      }
    });
  }
  return found;
}

describe("Turkish covers the whole interface", () => {
  it("routes every readable string through the translation tables", () => {
    const leftovers = untranslatedLiterals();

    assert.deepEqual(leftovers, [], `Untranslated English still reaches the interface:\n${leftovers.join("\n")}`);
  });
});
