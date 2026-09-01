/**
 * A QR reader, for the encoder's tests only.
 *
 * Deliberately written against the specification rather than against
 * `qr.ts` — it rebuilds the function-pattern map from the version instead of
 * borrowing the encoder's, recovers the mask from the format information and
 * checks that information's own BCH, then walks the zigzag and de-interleaves.
 * A round trip through *shared* code proves nothing; a round trip through an
 * independent reader is the closest thing to a scanner this repository can run.
 *
 * It reads clean codes only: no error correction, no perspective, no
 * thresholding. Damage is what the Reed-Solomon bytes are for, and those are
 * checked separately against the specification's worked example.
 */

/** The versions `qr.ts` emits, keyed by the size they produce. */
const versions: Record<number, { blocks: number; dataPerBlock: number; alignment: number[] }> = {
  21: { blocks: 1, dataPerBlock: 16, alignment: [] },
  25: { blocks: 1, dataPerBlock: 28, alignment: [6, 18] },
  29: { blocks: 1, dataPerBlock: 44, alignment: [6, 22] },
  33: { blocks: 2, dataPerBlock: 32, alignment: [6, 26] },
  37: { blocks: 2, dataPerBlock: 43, alignment: [6, 30] },
  41: { blocks: 4, dataPerBlock: 27, alignment: [6, 34] }
};

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

/** Everything a scanner knows is structure rather than payload. */
function functionModules(size: number, alignment: readonly number[]) {
  const map = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const box = (top: number, left: number, height: number, width: number) => {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const row = top + y;
        const column = left + x;
        if (row >= 0 && column >= 0 && row < size && column < size) map[row][column] = true;
      }
    }
  };
  // Finders with their separators.
  box(-1, -1, 9, 9);
  box(-1, size - 8, 9, 9);
  box(size - 8, -1, 9, 9);
  for (let index = 0; index < size; index += 1) {
    map[6][index] = true;
    map[index][6] = true;
  }
  for (const row of alignment) {
    for (const column of alignment) {
      const nearFinder = (row <= 8 && column <= 8)
        || (row <= 8 && column >= size - 9)
        || (row >= size - 9 && column <= 8);
      if (!nearFinder) box(row - 2, column - 2, 5, 5);
    }
  }
  for (let index = 0; index < 9; index += 1) {
    map[8][index] = true;
    map[index][8] = true;
  }
  for (let index = 0; index < 8; index += 1) {
    map[8][size - 1 - index] = true;
    map[size - 1 - index][8] = true;
  }
  return map;
}

function bchValid(unmasked: number) {
  let remainder = unmasked;
  for (let index = 14; index >= 10; index -= 1) {
    if ((remainder >> index) & 1) remainder ^= 0b10100110111 << (index - 10);
  }
  return remainder === 0;
}

/**
 * Both copies, and they have to agree.
 *
 * Reading only the first one is how a broken second copy went unnoticed: the
 * codes decoded perfectly here and no scanner could find them. A real reader
 * falls back to the second copy when the first is damaged, so a symbol whose
 * copies disagree is not a valid symbol however well the first one reads.
 */
function readFormat(matrix: readonly (readonly boolean[])[]) {
  const size = matrix.length;
  const read = (row: number, column: number) => (matrix[row][column] ? 1 : 0);

  const copyOne: readonly (readonly [number, number])[] = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
  ];
  const copyTwo: [number, number][] = [];
  for (let index = 0; index < 7; index += 1) copyTwo.push([size - 1 - index, 8]);
  for (let index = 0; index < 8; index += 1) copyTwo.push([8, size - 8 + index]);

  const gather = (cells: readonly (readonly [number, number])[]) =>
    cells.reduce((value, [row, column], index) => value | (read(row, column) << (14 - index)), 0);

  const first = gather(copyOne);
  const second = gather(copyTwo);
  const unmasked = first ^ 0b101010000010010;
  return {
    errorCorrectionLevel: (unmasked >> 13) & 0b11,
    mask: (unmasked >> 10) & 0b111,
    formatValid: bchValid(unmasked) && bchValid(second ^ 0b101010000010010),
    copiesAgree: first === second
  };
}

export function decodeQr(matrix: readonly (readonly boolean[])[]) {
  const size = matrix.length;
  const spec = versions[size];
  if (!spec) throw new Error(`unsupported_size:${size}`);
  const reserved = functionModules(size, spec.alignment);
  const format = readFormat(matrix);
  const unmask = maskRules[format.mask];

  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    const column = right <= 6 ? right - 1 : right;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const offset of [0, 1]) {
        const target = column - offset;
        if (reserved[row][target]) continue;
        bits.push(matrix[row][target] !== unmask(row, target) ? 1 : 0);
      }
    }
    upward = !upward;
  }

  const codewords: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    let byte = 0;
    for (let offset = 0; offset < 8; offset += 1) byte = (byte << 1) | bits[index + offset];
    codewords.push(byte);
  }

  // The data half is written column-wise across blocks; undo that.
  const dataTotal = spec.blocks * spec.dataPerBlock;
  const blocks: number[][] = Array.from({ length: spec.blocks }, () => []);
  for (let index = 0; index < dataTotal; index += 1) blocks[index % spec.blocks].push(codewords[index]);
  const data = blocks.flat();

  // Four bits of mode then eight of length, so every byte straddles two
  // codewords — which is exactly the alignment a placement bug would break.
  const mode = data[0] >> 4;
  const length = ((data[0] & 0x0f) << 4) | (data[1] >> 4);
  const bytes: number[] = [];
  for (let index = 0; index < length; index += 1) {
    bytes.push(((data[1 + index] & 0x0f) << 4) | (data[2 + index] >> 4));
  }

  return {
    ...format,
    mode,
    length,
    text: new TextDecoder().decode(new Uint8Array(bytes))
  };
}
