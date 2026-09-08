/*
 * Uses the library the way a consumer of the package does: against lib/ (the
 * build output and its .d.ts, not the sources), type-checked with
 * isolatedModules on, as every bundler-based setup has it. Run by
 * `npm run check:consumer` after `npm run build`; CI runs it.
 *
 * What this catches that the unit tests cannot: a `const enum` in the public
 * API. It type-checks fine inside the project, but the published .d.ts declares
 * it ambient, which isolatedModules consumers reject, and it has no runtime
 * value for JavaScript consumers.
 */
import assert from 'node:assert';
import { DefaultEndOfLine, PieceTreeTextBufferBuilder } from '../lib';

const builder = new PieceTreeTextBufferBuilder();
builder.acceptChunk('abc\n');
builder.acceptChunk('def');
const tree = builder.finish(true).create(DefaultEndOfLine.LF);

assert.strictEqual(tree.getLineCount(), 2);
tree.insert(1, '+');
assert.strictEqual(tree.getLineContent(1), 'a+bc');
assert.strictEqual(tree.getLineContent(2), 'def');

// the enum exists at runtime, with the documented values
assert.strictEqual(DefaultEndOfLine.LF, 1);
assert.strictEqual(DefaultEndOfLine.CRLF, 2);
assert.strictEqual(DefaultEndOfLine[DefaultEndOfLine.CRLF], 'CRLF');

console.log('consumer check: ok');
