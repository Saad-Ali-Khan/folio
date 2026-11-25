import assert from "node:assert/strict";
import { readingOrder } from "./ocr/geometry";

const original = [
  { text: "Stories", top: .02, height: .12, left: .5, confidence: 90 },
  { text: "The Complete", top: .05, height: .04, left: .15, confidence: 90 },
  { text: "F. Kafka", top: .8, height: .06, left: .7, confidence: 90 },
];
const ordered = readingOrder(original);
assert.deepEqual(ordered.map(line => line.text), ["The Complete", "Stories", "F. Kafka"]);
assert.equal(ordered[0].top, ordered[1].top, "stable top sorting must retain same-row left-to-right order");
assert.equal(original[1].top, .05, "raw measurements must not be mutated");
assert.deepEqual(readingOrder(ordered), ordered, "reading order is idempotent");
const separate = [{ text: "Upper Right", top: .1, height: .05, left: .6 },
  { text: "Lower Left", top: .18, height: .05, left: .1 }];
assert.deepEqual(readingOrder(separate), separate, "do not sort separate rows by horizontal position");
const titleAbove = [{ text: "The", top: .453, height: .054, left: .605 },
  { text: "Odyssey", top: .469, height: .131, left: .476 }];
assert.deepEqual(readingOrder(titleAbove), titleAbove, "a smaller word above a large title is not a left-to-right row");
const noHorizontal = [{ text: "First", top: .1, height: .1 }, { text: "Second", top: .15, height: .1 }];
assert.deepEqual(readingOrder(noHorizontal), noHorizontal, "legacy OCR without horizontal coordinates stays ordered");
const bridge = [
  { text: "Tall Artwork", top: .02, height: .3, left: .9 },
  { text: "Upper", top: .05, height: .05, left: .1 },
  { text: "Lower", top: .2, height: .05, left: .05 },
];
const bridged = readingOrder(bridge);
assert.notEqual(bridged.find(line => line.text === "Upper")?.top, bridged.find(line => line.text === "Lower")?.top,
  "a tall overlapping region cannot chain two separate text rows");
console.log("PASS reading order, separate rows, missing coordinates, immutability and tall-artwork isolation. No network or inventory writes.");
