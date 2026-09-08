import assert from 'assert';
import { describe, expect, it } from 'vitest';
import { Range } from '../common/range';
import { PersistentPieceTree, PieceTreeHistory, PieceTreeVersion } from '../persistentPieceTree';
import { StringBuffer, createLineStartsFast } from '../pieceBuffers';
import { PieceTreeBase } from '../pieceTreeBase';
import { DefaultEndOfLine, PieceTreeTextBufferBuilder } from '../pieceTreeBuilder';
import { Mode, Op, applyOp, assertEquivalent, generateScenario } from './differential';
import { LinesTextBuffer } from './linesTextBuffer';
import { Prng } from './prng';
import { assertPersistentTreeInvariants, readSnapshot } from './testUtils';

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
			expect(() => tree.insert(8, 'x')).toThrow(RangeError);
			expect(() => tree.delete(6, 5)).toThrow(RangeError);
		});

		it('rejects edits outside the document or at fractional offsets, before changing anything', () => {
			const tree = new PersistentPieceTree(toBuffers(['abc']), '\n', true);
			for (const bad of [() => tree.insert(4, 'x'), () => tree.insert(-1, 'x'), () => tree.insert(1.5, 'x'), () => tree.insert(NaN, 'x', false),
				() => tree.delete(0, 4), () => tree.delete(2, 2), () => tree.delete(-1, 1), () => tree.delete(0, -1), () => tree.delete(0.5, 1), () => tree.delete(0, 1.5)]) {
				expect(bad).toThrow(RangeError);
			}
			expect(tree.getLinesRawContent()).toBe('abc');
			// the failed unnormalized insert did not turn the EOL fast paths off
			expect(tree.getVersion().eolNormalized).toBe(true);

			const empty = new PersistentPieceTree([], '\n', true);
			expect(() => empty.insert(5, 'x')).toThrow(RangeError);
			expect(() => empty.delete(0, 1)).toThrow(RangeError);
			empty.delete(0, 0);
			empty.insert(0, 'x');
			expect(empty.getLinesRawContent()).toBe('x');
		});

		it('equal() compares the current versions, after edits and restores', () => {
			const a = new PersistentPieceTree(toBuffers(['ab', 'c\nd']), '\n', true);
			const b = new PersistentPieceTree(toBuffers(['abc\nd']), '\n', true);
			expect(a.equal(b)).toBe(true);
			expect(a.getLineContent(2)).toBe('d'); // warm the caches
			const before = b.getVersion();
			b.insert(2, 'X');
			expect(a.equal(b)).toBe(false);
			expect(b.equal(a)).toBe(false);
			a.insert(2, 'X');
			expect(a.equal(b)).toBe(true);
			b.restoreVersion(before);
			expect(a.equal(b)).toBe(false);
			a.delete(2, 1);
			expect(a.equal(b)).toBe(true);
		});
	});

	/*
	 * The edits themselves are covered by the ported VS Code suite and the
	 * differential fuzzer, which persistentPieceTree.ported.test.ts runs against
	 * this tree. What follows is what only this tree can do: versions.
	 */
	describe('versions', () => {
		function fromBuilder(chunks: string[], normalize: boolean = true): PersistentPieceTree {
			const builder = new PieceTreeTextBufferBuilder();
			for (const chunk of chunks) {
				builder.acceptChunk(chunk);
			}
			return builder.finish(normalize).createPersistent(DefaultEndOfLine.LF);
		}

		it('an empty insert or delete changes nothing and stores no empty piece', () => {
			const tree = fromBuilder(['abc\ndef']);
			const beforeRoot = tree.root;
			tree.insert(2, '');
			tree.delete(2, 0);
			expect(tree.root).toBe(beforeRoot);
			expect(tree.getLinesRawContent()).toBe('abc\ndef');
		});

		it('a version is the document as it was, whatever happens afterwards', () => {
			const tree = fromBuilder(['abc\ndef']);
			const v0 = tree.getVersion();
			tree.insert(3, ' xyz');
			const v1 = tree.getVersion();
			tree.delete(0, 4);
			tree.insert(tree.getLength(), '\nend');
			const v2 = tree.getVersion();

			expect(v0.length).toBe(7);
			expect(v0.lineCount).toBe(2);
			expect(v1.length).toBe(11);
			tree.restoreVersion(v0);
			expect(tree.getLinesRawContent()).toBe('abc\ndef');
			expect(tree.getLineContent(1)).toBe('abc');
			tree.restoreVersion(v1);
			expect(tree.getLinesRawContent()).toBe('abc xyz\ndef');
			tree.restoreVersion(v2);
			expect(tree.getLinesRawContent()).toBe('xyz\ndef\nend');
			expect(tree.getLineCount()).toBe(3);
		});

		it('editing a restored version branches; the other branch is untouched', () => {
			const tree = fromBuilder(['one\ntwo\nthree']);
			const base = tree.getVersion();
			tree.insert(0, 'A ');
			const branchA = tree.getVersion();
			tree.restoreVersion(base);
			tree.insert(tree.getLength(), ' B');
			const branchB = tree.getVersion();

			tree.restoreVersion(branchA);
			expect(tree.getLinesRawContent()).toBe('A one\ntwo\nthree');
			tree.restoreVersion(branchB);
			expect(tree.getLinesRawContent()).toBe('one\ntwo\nthree B');
			tree.restoreVersion(branchA);
			assertPersistentTreeInvariants(tree.root);
			tree.restoreVersion(branchB);
			assertPersistentTreeInvariants(tree.root);
			tree.restoreVersion(base);
			expect(tree.getLinesRawContent()).toBe('one\ntwo\nthree');
		});

		it('older versions keep their buffers across setEOL', () => {
			const tree = fromBuilder(['a\r\nb\nc'], false);
			const mixed = tree.getVersion();
			tree.setEOL('\r\n');
			const crlf = tree.getVersion();
			expect(tree.getLinesRawContent()).toBe('a\r\nb\r\nc');
			tree.insert(1, 'X');
			tree.restoreVersion(mixed);
			expect(tree.getLinesRawContent()).toBe('a\r\nb\nc');
			expect(tree.getEOL()).toBe('\n');
			tree.insert(0, 'Y');
			expect(tree.getLinesRawContent()).toBe('Ya\r\nb\nc');
			tree.restoreVersion(crlf);
			expect(tree.getLinesRawContent()).toBe('a\r\nb\r\nc');
			expect(tree.getEOL()).toBe('\r\n');
		});

		it('rejects a version of another tree, and anything that is not a version', () => {
			const a = fromBuilder(['abc']);
			const b = fromBuilder(['abc']);
			expect(() => a.restoreVersion(b.getVersion())).toThrow(TypeError);
			const fake: PieceTreeVersion = { eol: '\n', eolNormalized: true, length: 3, lineCount: 1 };
			expect(() => a.restoreVersion(fake)).toThrow(TypeError);
			expect(a.getLinesRawContent()).toBe('abc');
		});

		it('restores the line-ending flags with the version', () => {
			const tree = fromBuilder(['a\nb']);
			const normalized = tree.getVersion();
			expect(normalized.eolNormalized).toBe(true);
			tree.insert(1, '\r', false);
			const mixed = tree.getVersion();
			expect(mixed.eolNormalized).toBe(false);
			tree.restoreVersion(normalized);
			expect(tree.getVersion().eolNormalized).toBe(true);
			// the flag is what enables the EOL fast paths: a normalized insert keeps them
			tree.insert(0, '\n', true);
			expect(tree.getVersion().eolNormalized).toBe(true);
			tree.restoreVersion(mixed);
			expect(tree.getVersion().eolNormalized).toBe(false);
			expect(tree.getLinesRawContent()).toBe('a\r\nb');
		});

		for (const mode of ['normalized', 'mixed'] as Mode[]) {
			it(`every version of a random ${mode} session still reads as it did when it was taken`, () => {
				for (const seed of [1, 2, 3]) {
					const scenario = generateScenario({ seed, mode, opCount: 120, initialLength: 60, insertLength: 10 });
					const builder = new PieceTreeTextBufferBuilder();
					for (const chunk of scenario.chunks) {
						builder.acceptChunk(chunk);
					}
					const tree = builder.finish(mode === 'normalized').createPersistent(scenario.defaultEOL === '\r\n' ? DefaultEndOfLine.CRLF : DefaultEndOfLine.LF);
					const model = new LinesTextBuffer(tree.getLinesRawContent());

					const taken: { version: PieceTreeVersion; raw: string; lines: string[]; ops: Op[] }[] = [];
					for (let i = 0; i < scenario.ops.length; i++) {
						applyOp(tree, model, scenario.ops[i], mode);
						taken.push({ version: tree.getVersion(), raw: model.getLinesRawContent(), lines: model.getLinesContent(), ops: scenario.ops.slice(0, i + 1) });
					}

					const rng = new Prng(seed);
					for (const { version, raw, lines } of taken) {
						tree.restoreVersion(version);
						assert.strictEqual(tree.getLinesRawContent(), raw, `seed ${seed}: version taken after ${version.length} chars`);
						assert.deepStrictEqual(tree.getLinesContent(), lines);
						assert.strictEqual(readSnapshot(tree.createSnapshot('')), raw);
						assertEquivalent(tree, new LinesTextBuffer(raw), { rng, checkLineLength: false, thorough: false });
					}
				}
			});
		}
	});

	describe('large inserts', () => {
		// createNewPieces splits text above AverageBufferSize (65535) into buffers of its
		// own, holding back a \r or a high surrogate that would fall on the cut
		const filler = (n: number) => 'x'.repeat(n);
		const cases: [string, string][] = [
			['\\r on the cut', filler(65534) + '\r\n' + filler(10) + '\nend'],
			['surrogate pair on the cut', filler(65534) + '\uD83D\uDE00' + filler(10) + '\nend'],
			['two cuts', filler(65534) + '\r' + filler(65533) + '\r\n' + 'tail'],
		];
		for (const [name, text] of cases) {
			it(name, () => {
				for (const normalized of [true, false]) {
					const base = new PieceTreeBase(toBuffers(['head\n']), '\n', normalized);
					const tree = new PersistentPieceTree(toBuffers(['head\n']), '\n', normalized);
					base.insert(5, text, normalized);
					tree.insert(5, text, normalized);
					assert.strictEqual(tree.getLinesRawContent(), 'head\n' + text);
					assert.strictEqual(tree.getLinesRawContent(), base.getLinesRawContent());
					assert.strictEqual(tree.getLineCount(), base.getLineCount());
					assert.deepStrictEqual(tree.getLinesContent(), base.getLinesContent());
					assertPersistentTreeInvariants(tree.root);
					// and back out again
					tree.delete(5, text.length);
					assert.strictEqual(tree.getLinesRawContent(), 'head\n');
				}
			});
		}
	});

	describe('PieceTreeHistory', () => {
		function fromText(text: string): PersistentPieceTree {
			return new PersistentPieceTree(toBuffers([text]), '\n', true);
		}

		it('undoes and redoes snapshots in order', () => {
			const tree = fromText('hello');
			const history = new PieceTreeHistory(tree);
			expect(history.canUndo).toBe(false);
			expect(history.undo()).toBe(false);

			history.pushUndoStop();
			tree.insert(5, ' world');
			history.pushUndoStop();
			tree.insert(0, '> ');
			expect(tree.getLinesRawContent()).toBe('> hello world');

			expect(history.undo()).toBe(true);
			expect(tree.getLinesRawContent()).toBe('hello world');
			expect(history.undo()).toBe(true);
			expect(tree.getLinesRawContent()).toBe('hello');
			expect(history.undo()).toBe(false);
			expect(history.canRedo).toBe(true);

			expect(history.redo()).toBe(true);
			expect(tree.getLinesRawContent()).toBe('hello world');
			expect(history.redo()).toBe(true);
			expect(tree.getLinesRawContent()).toBe('> hello world');
			expect(history.redo()).toBe(false);
		});

		it('an edit after an undo discards the redo branch', () => {
			const tree = fromText('a');
			const history = new PieceTreeHistory(tree);
			history.pushUndoStop();
			tree.insert(1, 'b');
			history.undo();
			expect(history.canRedo).toBe(true);
			history.pushUndoStop();
			tree.insert(1, 'c');
			expect(history.canRedo).toBe(false);
			expect(history.redo()).toBe(false);
			expect(tree.getLinesRawContent()).toBe('ac');
			expect(history.undo()).toBe(true);
			expect(tree.getLinesRawContent()).toBe('a');
			expect(history.redo()).toBe(true);
			expect(tree.getLinesRawContent()).toBe('ac');
		});

		it('an edit without a new undo stop also discards the redo branch, and is undone to the last stop', () => {
			const tree = fromText('a');
			const history = new PieceTreeHistory(tree);
			history.pushUndoStop();
			tree.insert(1, 'b');
			history.undo();
			tree.insert(1, 'c');
			expect(history.canRedo).toBe(false);
			expect(history.redo()).toBe(false);
			expect(tree.getLinesRawContent()).toBe('ac');
			// 'a' was never made a stop after the undo, so there is nothing to go back to
			expect(history.canUndo).toBe(false);
			expect(history.undo()).toBe(false);
			expect(tree.getLinesRawContent()).toBe('ac');
		});

		it('an undo stop without edits after it is not a step, and does not discard the redo branch', () => {
			const tree = fromText('a');
			const history = new PieceTreeHistory(tree);
			history.pushUndoStop();
			history.pushUndoStop();
			expect(history.canUndo).toBe(false);
			expect(history.undo()).toBe(false);
			tree.insert(1, 'b');
			history.pushUndoStop();
			history.pushUndoStop();
			expect(history.undo()).toBe(true);
			expect(tree.getLinesRawContent()).toBe('a');
			expect(history.canUndo).toBe(false);
			history.pushUndoStop();
			expect(history.canRedo).toBe(true);
			expect(history.redo()).toBe(true);
			expect(tree.getLinesRawContent()).toBe('ab');
			expect(history.undo()).toBe(true);
			expect(tree.getLinesRawContent()).toBe('a');
			expect(history.undo()).toBe(false);
		});

		it('undo and redo alternate freely', () => {
			const tree = fromText('');
			const history = new PieceTreeHistory(tree);
			const texts = [''];
			for (const ch of 'abcdef') {
				history.pushUndoStop();
				tree.insert(tree.getLength(), ch);
				texts.push(tree.getLinesRawContent());
			}
			let at = texts.length - 1;
			const rng = new Prng(11);
			for (let i = 0; i < 200; i++) {
				if (rng.next() < 0.5) {
					expect(history.undo()).toBe(at > 0);
					at = Math.max(0, at - 1);
				} else {
					expect(history.redo()).toBe(at < texts.length - 1);
					at = Math.min(texts.length - 1, at + 1);
				}
				expect(tree.getLinesRawContent()).toBe(texts[at]);
				expect(history.canUndo).toBe(at > 0);
				expect(history.canRedo).toBe(at < texts.length - 1);
			}
		});

		it('groups several edits under one snapshot', () => {
			const tree = fromText('');
			const history = new PieceTreeHistory(tree);
			history.pushUndoStop();
			for (const ch of 'typing') {
				tree.insert(tree.getLength(), ch);
			}
			expect(tree.getLinesRawContent()).toBe('typing');
			history.undo();
			expect(tree.getLinesRawContent()).toBe('');
			history.redo();
			expect(tree.getLinesRawContent()).toBe('typing');
		});

		it('keeps at most `limit` undo points', () => {
			const tree = fromText('');
			const history = new PieceTreeHistory(tree, 3);
			for (let i = 0; i < 6; i++) {
				history.pushUndoStop();
				tree.insert(tree.getLength(), String(i));
			}
			expect(tree.getLinesRawContent()).toBe('012345');
			let undone = 0;
			while (history.undo()) {
				undone++;
			}
			expect(undone).toBe(3);
			expect(tree.getLinesRawContent()).toBe('012');
			expect(() => new PieceTreeHistory(tree, 0)).toThrow(RangeError);
			expect(() => new PieceTreeHistory(tree, 2.5)).toThrow(RangeError);
		});

		it('undo across setEOL restores the old line breaks', () => {
			const tree = new PersistentPieceTree(toBuffers(['a\nb']), '\n', true);
			const history = new PieceTreeHistory(tree);
			history.pushUndoStop();
			tree.setEOL('\r\n');
			expect(tree.getLinesRawContent()).toBe('a\r\nb');
			history.undo();
			expect(tree.getLinesRawContent()).toBe('a\nb');
			expect(tree.getEOL()).toBe('\n');
			history.redo();
			expect(tree.getLinesRawContent()).toBe('a\r\nb');
		});

		it('random edits with a snapshot each: undo all returns to the start, redo all to the end', () => {
			const rng = new Prng(5);
			const tree = fromText('start\n');
			const history = new PieceTreeHistory(tree, 10000);
			const raws = [tree.getLinesRawContent()];
			for (let i = 0; i < 300; i++) {
				history.pushUndoStop();
				if (rng.next() < 0.7 || tree.getLength() === 0) {
					tree.insert(rng.nextInt(tree.getLength() + 1), rng.nextString('ab\n', 1 + rng.nextInt(5)), true);
				} else {
					const offset = rng.nextInt(tree.getLength());
					tree.delete(offset, 1 + rng.nextInt(Math.min(5, tree.getLength() - offset)));
				}
				raws.push(tree.getLinesRawContent());
			}
			for (let i = raws.length - 1; i > 0; i--) {
				assert.strictEqual(tree.getLinesRawContent(), raws[i]);
				assert(history.undo());
			}
			assert.strictEqual(tree.getLinesRawContent(), raws[0]);
			for (let i = 1; i < raws.length; i++) {
				assert(history.redo());
				assert.strictEqual(tree.getLinesRawContent(), raws[i]);
			}
			assert(!history.redo());
			assertPersistentTreeInvariants(tree.root);
		});
	});
});
