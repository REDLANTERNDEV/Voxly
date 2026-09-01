/**
 * A QR encoder, because Voxly cannot fetch one.
 *
 * `AGENTS.md` rules out the dependency direction and the app is served
 * self-contained, so a scannable code has to be built here or not exist. It was
 * left out of the first pass for exactly that reason; this is the reason
 * removed.
 *
 * Deliberately a *small* encoder rather than a complete one: byte mode, error
 * correction level M, versions 1 through 6. That covers 106 bytes, which is
 * comfortably more than the address it has to carry, and it stops at 6 because
 * version 7 and up must also encode a version information block that nothing
 * here would ever exercise. An encoder with untested branches is worse than one
 * that refuses.
 *
 * The output is a boolean matrix. Drawing it is the caller's business.
 */

/** Data and error-correction codewords per block, at level M. */
const versions = [
  { version: 1, blocks: 1, dataPerBlock: 16, ecPerBlock: 10, alignment: [] },
  { version: 2, blocks: 1, dataPerBlock: 28, ecPerBlock: 16, alignment: [6, 18] },
  { version: 3, blocks: 1, dataPerBlock: 44, ecPerBlock: 26, alignment: [6, 22] },
  { version: 4, blocks: 2, dataPerBlock: 32, ecPerBlock: 18, alignment: [6, 26] },
  { version: 5, blocks: 2, dataPerBlock: 43, ecPerBlock: 24, alignment: [6, 30] },
  { version: 6, blocks: 4, dataPerBlock: 27, ecPerBlock: 16, alignment: [6, 34] }
] as const;

/** Level M, as the two bits the format information carries. */
const errorCorrectionBits = 0b00;
const formatMask = 0b101010000010010;

// GF(256) with the QR primitive polynomial, as log/antilog tables so the
// Reed-Solomon multiply below is two lookups and an add.
const exponents = new Uint8Array(512);
const logs = new Uint8Array(256);
{
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    exponents[index] = value;
    logs[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) exponents[index] = exponents[index - 255];
}

function multiply(left: number, right: number) {
  if (left === 0 || right === 0) return 0;
  return exponents[logs[left] + logs[right]];
}

/** The generator polynomial for `degree` error-correction codewords. */
function generatorPolynomial(degree: number) {
  let poly = [1];
  for (let index = 0; index < degree; index += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let position = 0; position < poly.length; position += 1) {
      next[position] ^= poly[position];
      next[position + 1] ^= multiply(poly[position], exponents[index]);
    }
    poly = next;
  }
  return poly;
}

function errorCorrection(data: readonly number[], count: number) {
  const generator = generatorPolynomial(count);
  const remainder = new Array<number>(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let index = 0; index < count; index += 1) {
      remainder[index] ^= multiply(generator[index + 1], factor);
    }
  }
  return remainder;
}

export class QrTooLongError extends Error {
  constructor(readonly length: number) {
    super(`qr_payload_too_long:${length}`);
  }
}

function chooseVersion(byteLength: number) {
  for (const candidate of versions) {
    // Four bits of mode and eight of length come out of the data budget.
    const capacity = candidate.blocks * candidate.dataPerBlock - 2;
    if (byteLength <= capacity) return candidate;
  }
  throw new QrTooLongError(byteLength);
}

/** Mode indicator, length, payload, terminator, and the alternating pad. */
function encodeData(bytes: Uint8Array, dataCodewords: number) {
  const bits: number[] = [];
  const push = (value: number, width: number) => {
    for (let index = width - 1; index >= 0; index -= 1) bits.push((value >> index) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const byte of bytes) push(byte, 8);
  const capacityBits = dataCodewords * 8;
  for (let index = 0; index < 4 && bits.length < capacityBits; index += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    let byte = 0;
    for (let offset = 0; offset < 8; offset += 1) byte = (byte << 1) | bits[index + offset];
    codewords.push(byte);
  }
  // The pad bytes alternate from the *first* one, not from the parity of
  // however many data codewords happened to come before them. Keying it off
  // `codewords.length` starts on `0x11` whenever the data ends on an odd count.
  const padding = [0xec, 0x11];
  for (let pad = 0; codewords.length < dataCodewords; pad += 1) {
    codewords.push(padding[pad % 2]);
  }
  return codewords;
}

/**
 * Blocks are written column-wise, all the data then all the error correction,
 * which is what spreads a scratch across blocks instead of destroying one.
 */
function interleave(blocks: readonly (readonly number[])[], ecBlocks: readonly (readonly number[])[]) {
  const out: number[] = [];
  const longest = Math.max(...blocks.map((block) => block.length));
  for (let index = 0; index < longest; index += 1) {
    for (const block of blocks) if (index < block.length) out.push(block[index]);
  }
  for (let index = 0; index < ecBlocks[0].length; index += 1) {
    for (const block of ecBlocks) out.push(block[index]);
  }
  return out;
}

type Grid = { modules: (boolean | null)[][]; reserved: boolean[][]; size: number };

function createGrid(size: number): Grid {
  return {
    size,
    modules: Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  };
}

function place(grid: Grid, row: number, column: number, dark: boolean) {
  grid.modules[row][column] = dark;
  grid.reserved[row][column] = true;
}

function drawFinder(grid: Grid, row: number, column: number) {
  for (let y = -1; y <= 7; y += 1) {
    for (let x = -1; x <= 7; x += 1) {
      const r = row + y;
      const c = column + x;
      if (r < 0 || c < 0 || r >= grid.size || c >= grid.size) continue;
      const ring = Math.max(Math.abs(y - 3), Math.abs(x - 3));
      place(grid, r, c, y >= 0 && y <= 6 && x >= 0 && x <= 6 && ring !== 2);
    }
  }
}

function drawAlignment(grid: Grid, centres: readonly number[]) {
  for (const row of centres) {
    for (const column of centres) {
      // The three finder corners already own their neighbourhoods.
      const nearFinder = (row <= 8 && column <= 8)
        || (row <= 8 && column >= grid.size - 9)
        || (row >= grid.size - 9 && column <= 8);
      if (nearFinder) continue;
      for (let y = -2; y <= 2; y += 1) {
        for (let x = -2; x <= 2; x += 1) {
          place(grid, row + y, column + x, Math.max(Math.abs(y), Math.abs(x)) !== 1);
        }
      }
    }
  }
}

function drawTiming(grid: Grid) {
  for (let index = 8; index < grid.size - 8; index += 1) {
    const dark = index % 2 === 0;
    place(grid, 6, index, dark);
    place(grid, index, 6, dark);
  }
}

function reserveFormat(grid: Grid) {
  for (let index = 0; index < 9; index += 1) {
    if (!grid.reserved[8][index]) place(grid, 8, index, false);
    if (!grid.reserved[index][8]) place(grid, index, 8, false);
  }
  for (let index = 0; index < 8; index += 1) {
    place(grid, 8, grid.size - 1 - index, false);
    place(grid, grid.size - 1 - index, 8, false);
  }
  // The one module that is always dark, just above the lower-left finder.
  place(grid, grid.size - 8, 8, true);
}

/** Up the right, down the left, two columns at a time, skipping column six. */
function placeData(grid: Grid, codewords: readonly number[]) {
  let bit = 0;
  const next = () => {
    const index = bit >> 3;
    const value = index < codewords.length ? (codewords[index] >> (7 - (bit & 7))) & 1 : 0;
    bit += 1;
    return value === 1;
  };
  let upward = true;
  for (let right = grid.size - 1; right >= 1; right -= 2) {
    const column = right <= 6 ? right - 1 : right;
    for (let step = 0; step < grid.size; step += 1) {
      const row = upward ? grid.size - 1 - step : step;
      for (const offset of [0, 1]) {
        const target = column - offset;
        if (grid.reserved[row][target]) continue;
        grid.modules[row][target] = next();
      }
    }
    upward = !upward;
  }
}

const maskRules: readonly ((row: number, column: number) => boolean)[] = [
  (row, column) => (row + column) % 2 === 0,
  (row) => row % 2 === 0,
  (_row, column) => column % 3 === 0,
  (row, column) => (row + column) % 3 === 0,
  (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
  (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
  (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
  (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0
];

function formatBits(mask: number) {
  const data = (errorCorrectionBits << 3) | mask;
  let remainder = data << 10;
  for (let index = 14; index >= 10; index -= 1) {
    if ((remainder >> index) & 1) remainder ^= 0b10100110111 << (index - 10);
  }
  return ((data << 10) | remainder) ^ formatMask;
}

/**
 * The format information, **most significant bit first**.
 *
 * This was written least-significant bit first, which is the bug that made
 * every symbol unreadable. Nothing structural was wrong — a same-payload,
 * same-mask reference encoder agrees with this one on 433 of 441 modules, and
 * the eight that differed were all format cells. But a scanner reads the format
 * before anything else, and one that cannot be read is a symbol that is never
 * located at all.
 *
 * The order below was derived against a reference symbol cell by cell rather
 * than from memory, because reading it out of a table wrongly is exactly how it
 * came to be reversed in the first place.
 *
 * Copy 1 runs right along row 8 (skipping the timing column) and then up
 * column 8. Copy 2 runs up column 8 from the bottom, then right along row 8 to
 * the corner. Both carry bit 14 first.
 */
function applyFormat(grid: Grid, mask: number) {
  const bits = formatBits(mask);
  const bit = (index: number) => ((bits >> index) & 1) === 1;
  const size = grid.size;

  const copyOne: readonly (readonly [number, number])[] = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
  ];
  const copyTwo: [number, number][] = [];
  for (let index = 0; index < 7; index += 1) copyTwo.push([size - 1 - index, 8]);
  for (let index = 0; index < 8; index += 1) copyTwo.push([8, size - 8 + index]);

  for (const cells of [copyOne, copyTwo]) {
    cells.forEach(([row, column], index) => {
      grid.modules[row][column] = bit(14 - index);
    });
  }
  // Written last: copy 2's run up the column passes through this module's
  // neighbour, and the one module that is dark in every symbol is not a
  // format bit.
  grid.modules[size - 8][8] = true;
}

/** The four penalties from the specification, summed. Lower is better. */
function penalty(matrix: readonly boolean[][]) {
  const size = matrix.length;
  let score = 0;

  const runScore = (line: readonly boolean[]) => {
    let total = 0;
    let run = 1;
    for (let index = 1; index < line.length; index += 1) {
      if (line[index] === line[index - 1]) run += 1;
      else {
        if (run >= 5) total += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) total += 3 + (run - 5);
    return total;
  };
  for (let index = 0; index < size; index += 1) {
    score += runScore(matrix[index]);
    score += runScore(matrix.map((row) => row[index]));
  }

  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const first = matrix[row][column];
      if (
        first === matrix[row][column + 1] &&
        first === matrix[row + 1][column] &&
        first === matrix[row + 1][column + 1]
      ) score += 3;
    }
  }

  const finderLike = [true, false, true, true, true, false, true, false, false, false, false];
  const reversed = [...finderLike].reverse();
  const matches = (line: readonly boolean[], pattern: readonly boolean[], at: number) =>
    pattern.every((value, offset) => line[at + offset] === value);
  for (let index = 0; index < size; index += 1) {
    const row = matrix[index];
    const column = matrix.map((line) => line[index]);
    for (let at = 0; at + finderLike.length <= size; at += 1) {
      for (const line of [row, column]) {
        if (matches(line, finderLike, at) || matches(line, reversed, at)) score += 40;
      }
    }
  }

  const dark = matrix.flat().filter(Boolean).length;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/**
 * The payload as a square of dark and light modules, without a quiet zone —
 * the caller adds that, because how much margin a code needs depends on what it
 * is drawn onto.
 */
/**
 * `forceMask` exists for the tests only: it is the one knob that lets a symbol
 * be compared module-for-module against a reference encoder, which is the only
 * way to check the placement without a camera.
 */
export function encodeQr(payload: string, forceMask?: number): boolean[][] {
  const bytes = new TextEncoder().encode(payload);
  const spec = chooseVersion(bytes.length);
  const size = 17 + spec.version * 4;

  const codewords = encodeData(bytes, spec.blocks * spec.dataPerBlock);
  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  for (let index = 0; index < spec.blocks; index += 1) {
    const block = codewords.slice(index * spec.dataPerBlock, (index + 1) * spec.dataPerBlock);
    blocks.push(block);
    ecBlocks.push(errorCorrection(block, spec.ecPerBlock));
  }
  const interleaved = interleave(blocks, ecBlocks);

  const base = createGrid(size);
  drawFinder(base, 0, 0);
  drawFinder(base, 0, size - 7);
  drawFinder(base, size - 7, 0);
  drawAlignment(base, spec.alignment);
  drawTiming(base);
  reserveFormat(base);
  placeData(base, interleaved);

  // Every mask is built and scored; the specification's penalties are what
  // decide, because a badly masked code is one a camera cannot lock onto.
  let best: boolean[][] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < maskRules.length; mask += 1) {
    if (forceMask !== undefined && mask !== forceMask) continue;
    const grid: Grid = {
      size,
      reserved: base.reserved.map((row) => [...row]),
      modules: base.modules.map((row) => [...row])
    };
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        if (!grid.reserved[row][column] && maskRules[mask](row, column)) {
          grid.modules[row][column] = !grid.modules[row][column];
        }
      }
    }
    applyFormat(grid, mask);
    const matrix = grid.modules.map((row) => row.map((value) => value === true));
    const score = penalty(matrix);
    if (score < bestScore) {
      bestScore = score;
      best = matrix;
    }
  }
  return best as boolean[][];
}

/**
 * The matrix as one SVG path, which is far fewer nodes than a rect per module
 * and scales without seams between neighbours.
 */
export function qrPath(matrix: readonly (readonly boolean[])[]) {
  const parts: string[] = [];
  for (let row = 0; row < matrix.length; row += 1) {
    for (let column = 0; column < matrix[row].length; column += 1) {
      if (matrix[row][column]) parts.push(`M${column} ${row}h1v1h-1z`);
    }
  }
  return parts.join("");
}
