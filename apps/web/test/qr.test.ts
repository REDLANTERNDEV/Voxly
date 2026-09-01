import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeQr, QrTooLongError, qrPath } from "../src/lib/qr.js";
import { decodeQr } from "./helpers/qrDecoder.js";

/**
 * A QR encoder written here because Voxly serves its own assets and takes no
 * CDN dependencies. Nothing but a phone camera can really judge one, so these
 * pin the frames the specification fixes — the parts that are the same in every
 * valid code, whatever the payload. If those are right and the Reed-Solomon and
 * masking below are right, a scanner has what it needs.
 */
describe("qr encoder", () => {
  const payload = "http://192.168.0.107:5173/link#c=JXFT5BS9X8";

  it("produces a square of the version's size", () => {
    // 17 + 4v. The address above is 43 bytes, one past version 3's 42, so it
    // lands in version 4 — 33 across.
    assert.equal(new TextEncoder().encode(payload).length, 43);
    const matrix = encodeQr(payload);

    assert.equal(matrix.length, 33);
    for (const row of matrix) assert.equal(row.length, 33);
  });

  it("grows a version at a time as the payload grows", () => {
    const sizes = ["a".repeat(10), "a".repeat(30), "a".repeat(50), "a".repeat(70)]
      .map((text) => encodeQr(text).length);

    assert.deepEqual(sizes, [21, 29, 33, 37]);
    // Never shrinks as the payload grows.
    assert.deepEqual([...sizes].sort((left, right) => left - right), sizes);
  });

  it("draws the three finder patterns a scanner looks for first", () => {
    const matrix = encodeQr(payload);
    const size = matrix.length;
    // 7x7: dark ring, light ring, 3x3 dark core.
    const finderAt = (top: number, left: number) => {
      for (let row = 0; row < 7; row += 1) {
        for (let column = 0; column < 7; column += 1) {
          const ring = Math.max(Math.abs(row - 3), Math.abs(column - 3));
          assert.equal(
            matrix[top + row][left + column],
            ring !== 2,
            `finder at ${top},${left} wrong at ${row},${column}`
          );
        }
      }
    };

    finderAt(0, 0);
    finderAt(0, size - 7);
    finderAt(size - 7, 0);
  });

  it("separates each finder from the data with a light border", () => {
    const matrix = encodeQr(payload);
    const size = matrix.length;

    for (let index = 0; index < 8; index += 1) {
      assert.equal(matrix[7][index], false, `separator row at ${index}`);
      assert.equal(matrix[index][7], false, `separator column at ${index}`);
      assert.equal(matrix[7][size - 1 - index], false);
      assert.equal(matrix[size - 1 - index][7], false);
    }
  });

  it("alternates the timing patterns that carry the module pitch", () => {
    const matrix = encodeQr(payload);

    for (let index = 8; index < matrix.length - 8; index += 1) {
      assert.equal(matrix[6][index], index % 2 === 0, `horizontal timing at ${index}`);
      assert.equal(matrix[index][6], index % 2 === 0, `vertical timing at ${index}`);
    }
  });

  it("keeps the module that is dark in every valid code", () => {
    const matrix = encodeQr(payload);

    assert.equal(matrix[matrix.length - 8][8], true);
  });

  it("does not settle for an unreadable mask", () => {
    // A solid payload is the case where a bad mask shows: without masking the
    // grid comes out nearly uniform and a camera cannot lock onto it.
    const matrix = encodeQr("a".repeat(40));
    const dark = matrix.flat().filter(Boolean).length;
    const share = dark / matrix.flat().length;

    assert.ok(share > 0.35 && share < 0.65, `dark share ${share.toFixed(2)} is lopsided`);
  });

  it("is deterministic, so the same code always scans the same", () => {
    assert.deepEqual(encodeQr(payload), encodeQr(payload));
  });

  it("refuses a payload it cannot encode rather than truncating it", () => {
    // Silently dropping the end would produce a code that scans to the wrong
    // address, which is far worse than one that does not exist.
    assert.throws(() => encodeQr("a".repeat(200)), QrTooLongError);
  });

  it("carries every byte of a non-ASCII payload", () => {
    // Turkish text is two bytes a character in places, and the length field
    // counts bytes rather than characters.
    assert.doesNotThrow(() => encodeQr("çğıöşü".repeat(4)));
  });

  it("decodes back to exactly what went in", () => {
    // The proof that matters. An independent reader — one that rebuilds the
    // function-pattern map from the version rather than sharing the encoder's,
    // recovers the mask from the format information and checks its BCH, then
    // walks the zigzag and de-interleaves — gets the payload back byte for
    // byte. That exercises placement, masking, format information and
    // interleaving together, which no structural assertion can.
    for (const text of [
      payload,
      "https://voxly.example.com/link-device#c=ABCDEFGHJK",
      "a",
      "hello world",
      "x".repeat(60),
      "çğıöşü works"
    ]) {
      const read = decodeQr(encodeQr(text));
      assert.equal(read.text, text);
      assert.equal(read.mode, 4, "byte mode");
      assert.ok(read.formatValid, "the format information failed its own BCH check");
      assert.equal(read.errorCorrectionLevel, 0b00, "level M");
    }
  });

  it("writes the format information most significant bit first", () => {
    // The bug that made every symbol unreadable, and the one no self-consistent
    // round trip could catch. Nothing structural was wrong: against a reference
    // encoder given the same payload and the same mask, this one agreed on 433
    // of 441 modules — and the eight that differed were all format cells. A
    // scanner reads the format before anything else, so a symbol whose format
    // it cannot read is one it never locates at all.
    //
    // These are the exact modules a conforming encoder writes for level M with
    // mask 2, derived from a reference symbol cell by cell. Reading the order
    // out of a table from memory is how it came to be reversed.
    const matrix = encodeQr("HELLO", 2);
    const word = 0b101111001111100;
    const bit = (index: number) => ((word >> index) & 1) === 1;

    const copyOne = [
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
    ] as const;
    copyOne.forEach(([row, column], index) => {
      assert.equal(matrix[row][column], bit(14 - index), `copy 1 bit ${14 - index} at ${row},${column}`);
    });

    const size = matrix.length;
    for (let index = 0; index < 7; index += 1) {
      assert.equal(matrix[size - 1 - index][8], bit(14 - index), `copy 2 bit ${14 - index}`);
    }
    // The horizontal run picks up where the column left off: bit 7 down to 0.
    for (let index = 0; index < 8; index += 1) {
      assert.equal(matrix[8][size - 8 + index], bit(7 - index), `copy 2 bit ${7 - index}`);
    }
  });

  it("writes both copies of the format information, identically", () => {
    // The bug that made every code unscannable while decoding perfectly here.
    // The second copy splits seven modules then eight, not eight then seven —
    // writing eight up the lower-left column runs into the module that is dark
    // in every valid symbol, so a bit was written there and immediately
    // overwritten. A reader that only checked the first copy called it fine;
    // no camera could find it.
    for (const text of [payload, "a", "x".repeat(60), "çğıöşü"]) {
      const read = decodeQr(encodeQr(text));
      assert.ok(read.copiesAgree, "the two format copies disagree");
      assert.ok(read.formatValid, "a format copy failed its own BCH check");
    }
  });

  it("carries a whole URL, not a bare code", () => {
    // A phone's camera opens a link; it does nothing useful with ten loose
    // characters. The payload is the address plus the code in its fragment.
    const url = "http://192.168.0.107:5173/link-device#c=JXFT5BS9X8";

    assert.equal(decodeQr(encodeQr(url)).text, url);
  });

  it("draws one path node per dark module", () => {
    const matrix = encodeQr(payload);
    const dark = matrix.flat().filter(Boolean).length;

    assert.equal(qrPath(matrix).split("M").length - 1, dark);
  });
});
