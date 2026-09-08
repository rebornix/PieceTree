import assert from 'assert';
import { describe, expect, it } from 'vitest';
import { Range } from '../common/range';
import { PersistentPieceTree } from '../persistentPieceTree';
import { StringBuffer, createLineStartsFast } from '../pieceBuffers';
import { PieceTreeBase } from '../pieceTreeBase';
import { Prng } from './prng';
import { readSnapshot } from './testUtils';

/*
 * The persistent piece tree must answer every read exactly like PieceTreeBase.
 * Both are built from the same chunks (separate StringBuffer instances, so
 * neither can affect the other) and asked the same questions, over random
 * documents with every kind of line break, in both EOL modes, in the chunkings
 * the builder produces (never splitting \r\n or a surrogate pair).
 */

type Eol = '\r\n' | '\n';

function chunk(text: string, rng: Prng, maxChunk: number): string[] {
	const chunks: string[] = [];
	let i = 0;
	while (i < text.length) {
		let end = Math.min(text.length, i + 1 + rng.nextInt(maxChunk));
		// the builder never splits \r\n or a surrogate pair across chunks
		while (end < text.length && end > i + 1 && (
			(text.charCodeAt(end - 1) === 13 && text.charCodeAt(end) === 10)
			|| (text.charCodeAt(end - 1) >= 0xD800 && text.charCodeAt(end - 1) <= 0xDBFF)
		)) {
			end--;
		}
		chunks.push(text.substring(i, end));
		i = end;
	}
	return chunks;
}

function toBuffers(chunks: string[]): StringBuffer[] {
	return chunks.map(c => new StringBuffer(c, createLineStartsFast(c)));
}

function randomText(rng: Prng, length: number, eols: string[]): string {
	const alphabet = 'abcdefghij XYZ\t';
	let text = '';
	while (text.length < length) {
		const roll = rng.next();
		if (roll < 0.12) {
			text += eols[rng.nextInt(eols.length)];
		} else if (roll < 0.14) {
			text += '\uD83D\uDE00'; // an astral character: a surrogate pair
		} else {
			text += alphabet[rng.nextInt(alphabet.length)];
		}
	}
	return text;
}

interface Pair {
	text: string;
	eol: Eol;
	normalized: boolean;
	chunks: string[];
	base: PieceTreeBase;
	tree: PersistentPieceTree;
}

/** The two trees over the same document; in normalized mode the text uses `eol` only. */
function makePair(rng: Prng, length: number, eol: Eol, normalized: boolean, maxChunk: number = 24): Pair {
	let text = randomText(rng, length, ['\n', '\r\n', '\r']);
	if (normalized) {
		text = text.replace(/\r\n|\r|\n/g, eol);
	}
	const chunks = chunk(text, rng, maxChunk);
	return {
		text, eol, normalized, chunks,
		base: new PieceTreeBase(toBuffers(chunks), eol, normalized),
		tree: new PersistentPieceTree(toBuffers(chunks), eol, normalized)
	};
}

function assertSameReads({ text, base, tree, chunks }: Pair, rng: Prng): void {
	const info = () => `document ${JSON.stringify(text)} chunked as ${JSON.stringify(chunks)}`;

	assert.strictEqual(tree.getLength(), base.getLength(), info());
	assert.strictEqual(tree.getLineCount(), base.getLineCount(), info());
	assert.strictEqual(tree.getEOL(), base.getEOL());
	assert.strictEqual(tree.getLinesRawContent(), base.getLinesRawContent(), info());
	assert.deepStrictEqual(tree.getLinesContent(), base.getLinesContent(), info());
	assert.strictEqual(readSnapshot(tree.createSnapshot('\uFEFF')), readSnapshot(base.createSnapshot('\uFEFF')), info());

	const lineCount = base.getLineCount();

	// lines in order (exercises the lookup cache), then in random order (misses it)
	for (let line = 1; line <= lineCount; line++) {
		assert.strictEqual(tree.getLineContent(line), base.getLineContent(line), `line ${line} of ${info()}`);
		assert.strictEqual(tree.getLineLength(line), base.getLineLength(line), `length of line ${line} of ${info()}`);
	}
	for (let i = 0; i < lineCount; i++) {
		const line = rng.nextIntBetween(1, lineCount);
		assert.strictEqual(tree.getLineContent(line), base.getLineContent(line), `line ${line} of ${info()}`);
	}

	// positions and offsets
	for (let line = 1; line <= lineCount; line++) {
		const lineLength = base.getLineLength(line);
		for (const column of [1, 1 + (lineLength >> 1), lineLength + 1]) {
			assert.strictEqual(tree.getOffsetAt(line, column), base.getOffsetAt(line, column), `offset at ${line}:${column} of ${info()}`);
		}
		for (let index = 0; index < lineLength; index++) {
			assert.strictEqual(tree.getLineCharCode(line, index), base.getLineCharCode(line, index), `char code at ${line}:${index} of ${info()}`);
		}
	}
	// offsets past the end clamp to the end, like PieceTreeBase
	for (let offset = -1; offset <= base.getLength() + 3; offset++) {
		const expected = base.getPositionAt(offset);
		const actual = tree.getPositionAt(offset);
		assert(actual.equals(expected), `position at ${offset}: ${actual} vs ${expected} of ${info()}`);
	}

	// ranges, with and without EOL translation; a column past the end of a line
	// that is not the last one clamps to the line break, like PieceTreeBase
	for (let i = 0; i < 30; i++) {
		const startLine = rng.nextIntBetween(1, lineCount);
		const endLine = rng.nextIntBetween(startLine, lineCount);
		const startColumn = rng.nextIntBetween(1, base.getLineLength(startLine) + 1);
		let endColumn = startLine === endLine
			? rng.nextIntBetween(startColumn, base.getLineLength(endLine) + 1)
			: rng.nextIntBetween(1, base.getLineLength(endLine) + 1);
		if (endLine < lineCount && i % 5 === 0) {
			endColumn = base.getLineLength(endLine) + 2 + rng.nextInt(5);
		}
		const range = new Range(startLine, startColumn, endLine, endColumn);
		assert.strictEqual(tree.getValueInRange(range), base.getValueInRange(range), `range ${range} of ${info()}`);
		for (const eol of ['\n', '\r\n']) {
			assert.strictEqual(tree.getValueInRange(range, eol), base.getValueInRange(range, eol), `range ${range} as ${JSON.stringify(eol)} of ${info()}`);
		}
	}
}

describe('PersistentPieceTree (reads)', () => {
	describe('against PieceTreeBase on random documents', () => {
		const modes: { eol: Eol; normalized: boolean }[] = [
			{ eol: '\n', normalized: true },
			{ eol: '\r\n', normalized: true },
			{ eol: '\n', normalized: false },
			{ eol: '\r\n', normalized: false }
		];
		for (const { eol, normalized } of modes) {
			it(`${normalized ? 'normalized' : 'mixed line breaks'}, EOL ${JSON.stringify(eol)}`, () => {
				const rng = new Prng(normalized ? 11 : 12);
				for (let i = 0; i < 40; i++) {
					assertSameReads(makePair(rng, rng.nextIntBetween(1, 160), eol, normalized), rng);
				}
			});
		}

		it('with one-character chunks (every piece is a boundary)', () => {
			const rng = new Prng(13);
			for (let i = 0; i < 20; i++) {
				assertSameReads(makePair(rng, rng.nextIntBetween(1, 40), '\n', false, 1), rng);
			}
		});

		it('with a single chunk and with large documents', () => {
			const rng = new Prng(14);
			assertSameReads(makePair(rng, 300, '\n', true, 1000), rng);
			assertSameReads(makePair(rng, 3000, '\r\n', false, 200), rng);
		});
	});

	describe('by itself', () => {
		it('an empty document has one empty line', () => {
			const tree = new PersistentPieceTree(toBuffers(['']), '\n', true);
			expect(tree.getLength()).toBe(0);
			expect(tree.getLineCount()).toBe(1);
			expect(tree.getLineContent(1)).toBe('');
			expect(tree.getLineLength(1)).toBe(0);
			expect(tree.getLinesContent()).toEqual(['']);
			expect(tree.getLinesRawContent()).toBe('');
			expect(tree.getOffsetAt(1, 1)).toBe(0);
			expect(tree.getPositionAt(0).toString()).toBe('(1,1)');
			expect(tree.getValueInRange(new Range(1, 1, 1, 1))).toBe('');
			const snapshot = tree.createSnapshot('BOM');
			expect(snapshot.read()).toBe('BOM');
			expect(snapshot.read()).toBe(null);
		});

		it('reads the README example', () => {
			const tree = new PersistentPieceTree(toBuffers(['abc\n', 'def']), '\n', true);
			expect(tree.getLineCount()).toBe(2);
			expect(tree.getLineContent(1)).toBe('abc');
			expect(tree.getLineContent(2)).toBe('def');
			expect(tree.getLineLength(1)).toBe(3);
			expect(tree.getOffsetAt(2, 2)).toBe(5);
			expect(tree.getPositionAt(5).toString()).toBe('(2,2)');
			expect(tree.getValueInRange(new Range(1, 2, 2, 2))).toBe('bc\nd');
			expect(tree.getValueInRange(new Range(1, 2, 2, 2), '\r\n')).toBe('bc\r\nd');
			expect(tree.getLineCharCode(2, 0)).toBe('d'.charCodeAt(0));
			expect(readSnapshot(tree.createSnapshot(''))).toBe('abc\ndef');
		});

		it('equal compares content regardless of chunking', () => {
			const a = new PersistentPieceTree(toBuffers(['abc\n', 'def\n', 'ghi']), '\n', true);
			const b = new PersistentPieceTree(toBuffers(['ab', 'c\nd', 'ef\nghi']), '\n', true);
			const c = new PersistentPieceTree(toBuffers(['abc\n', 'dxf\n', 'ghi']), '\n', true);
			const d = new PersistentPieceTree(toBuffers(['abc\n', 'def\n', 'gh']), '\n', true);
			expect(a.equal(b)).toBe(true);
			expect(b.equal(a)).toBe(true);
			expect(a.equal(c)).toBe(false);
			expect(a.equal(d)).toBe(false);
			// same length, different line count
			expect(new PersistentPieceTree(toBuffers(['a\nb']), '\n', true).equal(new PersistentPieceTree(toBuffers(['abc']), '\n', true))).toBe(false);
			expect(new PersistentPieceTree([], '\n', true).equal(new PersistentPieceTree(toBuffers(['']), '\n', true))).toBe(true);
		});

		it('computes the line starts of a chunk that comes without them', () => {
			const tree = new PersistentPieceTree([new StringBuffer('ab\ncd\n', undefined!)], '\n', true);
			expect(tree.getLineCount()).toBe(3);
			expect(tree.getLineContent(2)).toBe('cd');
		});

		it('rejects lookups outside the document instead of reading past it', () => {
			const tree = new PersistentPieceTree(toBuffers(['abc\ndef']), '\n', true);
			expect(() => tree.nodeAt(8)).toThrow(RangeError);
			expect(() => tree.nodeAt2(3, 1)).toThrow(RangeError);
			expect(() => tree.nodeAt2(2, 9)).toThrow(RangeError);
			expect(tree.getLineRawContent(3)).toBe('');
			expect(tree.getOffsetAt(3, 1)).toBe(7);
			// the position right after the last character has no character
			expect(tree.getLineCharCode(2, 3)).toBe(0);
		});
	});
});
