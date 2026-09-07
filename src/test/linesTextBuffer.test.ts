import assert from 'assert';
import { describe, expect, it } from 'vitest';
import { Position } from '../common/position';
import { Range } from '../common/range';
import { LinesTextBuffer, splitLinesKeepingTerminators } from './linesTextBuffer';
import { Prng } from './prng';

/**
 * The plainest possible oracle: a string, re-split on every query. Used to
 * validate LinesTextBuffer so that differential.test.ts can trust it.
 */
class StringOracle {
	constructor(public text: string) { }

	lines(): string[] {
		return this.text.split(/\r\n|\r|\n/);
	}

	positionAt(offset: number): Position {
		offset = Math.min(Math.max(0, offset), this.text.length);
		let line = 1;
		let lineStart = 0;
		for (let i = 0; i < offset; i++) {
			const ch = this.text.charCodeAt(i);
			if (ch === 13) {
				if (this.text.charCodeAt(i + 1) === 10) {
					if (i + 1 >= offset) {
						// offset sits between \r and \n: still on this line
						break;
					}
					i++;
				}
				line++;
				lineStart = i + 1;
			} else if (ch === 10) {
				line++;
				lineStart = i + 1;
			}
		}
		return new Position(line, offset - lineStart + 1);
	}

	insert(offset: number, text: string): void {
		this.text = this.text.substring(0, offset) + text + this.text.substring(offset);
	}

	delete(offset: number, cnt: number): void {
		this.text = this.text.substring(0, offset) + this.text.substring(offset + cnt);
	}
}

// node's assert rather than expect(): this runs in tight loops
function assertMatchesOracle(buffer: LinesTextBuffer, oracle: StringOracle): void {
	const text = oracle.text;
	const lines = oracle.lines();

	assert.strictEqual(buffer.getLinesRawContent(), text);
	assert.strictEqual(buffer.getLength(), text.length);
	assert.strictEqual(buffer.getLineCount(), lines.length);
	assert.deepStrictEqual(buffer.getLinesContent(), lines);
	for (let i = 0; i < lines.length; i++) {
		assert.strictEqual(buffer.getLineContent(i + 1), lines[i]);
		assert.strictEqual(buffer.getLineLength(i + 1), lines[i].length);
	}
	for (let offset = 0; offset <= text.length; offset++) {
		const expected = oracle.positionAt(offset);
		const actual = buffer.getPositionAt(offset);
		assert.ok(actual.equals(expected), `getPositionAt(${offset}): got ${actual}, want ${expected} in ${JSON.stringify(text)}`);
		assert.strictEqual(buffer.getOffsetAt(expected.lineNumber, expected.column), offset);
		if (offset < text.length) {
			assert.strictEqual(buffer.getLineCharCode(expected.lineNumber, expected.column - 1), text.charCodeAt(offset));
		}
	}
}

describe('splitLinesKeepingTerminators', () => {
	it('keeps terminators attached to their line', () => {
		expect(splitLinesKeepingTerminators('')).toEqual(['']);
		expect(splitLinesKeepingTerminators('abc')).toEqual(['abc']);
		expect(splitLinesKeepingTerminators('abc\n')).toEqual(['abc\n', '']);
		expect(splitLinesKeepingTerminators('\n')).toEqual(['\n', '']);
		expect(splitLinesKeepingTerminators('a\nb')).toEqual(['a\n', 'b']);
		expect(splitLinesKeepingTerminators('a\r\nb')).toEqual(['a\r\n', 'b']);
		expect(splitLinesKeepingTerminators('a\rb')).toEqual(['a\r', 'b']);
		expect(splitLinesKeepingTerminators('a\r')).toEqual(['a\r', '']);
		expect(splitLinesKeepingTerminators('\r\n')).toEqual(['\r\n', '']);
		expect(splitLinesKeepingTerminators('\n\r')).toEqual(['\n', '\r', '']);
		expect(splitLinesKeepingTerminators('a\r\r\nb\n\nc')).toEqual(['a\r', '\r\n', 'b\n', '\n', 'c']);
	});

	it('round-trips', () => {
		for (const text of ['', 'x', 'a\r\n\r\nb\rc\nd\r', '\r\r\r', '\n\n\n', '\r\n\r\n']) {
			expect(splitLinesKeepingTerminators(text).join('')).toBe(text);
		}
	});
});

describe('LinesTextBuffer', () => {
	it('reads lines, offsets and positions', () => {
		const buffer = new LinesTextBuffer('abc\r\nde\nf\rg');
		expect(buffer.getLineCount()).toBe(4);
		expect(buffer.getLength()).toBe(11);
		expect(buffer.getLinesContent()).toEqual(['abc', 'de', 'f', 'g']);
		expect(buffer.getLineContent(1)).toBe('abc');
		expect(buffer.getLineLength(1)).toBe(3);
		expect(buffer.getLineContent(4)).toBe('g');

		expect(buffer.getOffsetAt(1, 1)).toBe(0);
		expect(buffer.getOffsetAt(2, 1)).toBe(5);
		expect(buffer.getOffsetAt(4, 2)).toBe(11);
		expect(buffer.getPositionAt(0)).toEqual(new Position(1, 1));
		expect(buffer.getPositionAt(4)).toEqual(new Position(1, 5)); // between \r and \n
		expect(buffer.getPositionAt(5)).toEqual(new Position(2, 1));
		expect(buffer.getPositionAt(11)).toEqual(new Position(4, 2));

		expect(buffer.getLineCharCode(1, 0)).toBe('a'.charCodeAt(0));
		expect(buffer.getLineCharCode(1, 3)).toBe(13);
		expect(buffer.getLineCharCode(1, 4)).toBe(10);
	});

	it('clamps out of range offsets like the piece tree', () => {
		const buffer = new LinesTextBuffer('ab\ncd');
		expect(buffer.getPositionAt(-1)).toEqual(new Position(1, 1));
		expect(buffer.getPositionAt(100)).toEqual(new Position(2, 3));
		expect(buffer.getPositionAt(3.7)).toEqual(new Position(2, 1));
	});

	it('getValueInRange', () => {
		const buffer = new LinesTextBuffer('abc\r\nde\nf');
		expect(buffer.getValueInRange(new Range(1, 1, 1, 1))).toBe('');
		expect(buffer.getValueInRange(new Range(1, 2, 1, 4))).toBe('bc');
		expect(buffer.getValueInRange(new Range(1, 2, 2, 2))).toBe('bc\r\nd');
		expect(buffer.getValueInRange(new Range(1, 4, 2, 1))).toBe('\r\n');
		expect(buffer.getValueInRange(new Range(1, 1, 3, 2))).toBe('abc\r\nde\nf');
	});

	it('insert and delete', () => {
		const buffer = new LinesTextBuffer('abc\ndef');
		buffer.insert(3, 'X\nY');
		expect(buffer.getLinesContent()).toEqual(['abcX', 'Y', 'def']);
		buffer.delete(4, 2); // abcX\ndef
		expect(buffer.getLinesContent()).toEqual(['abcX', 'def']);
		buffer.delete(4, 2); // abcXef
		expect(buffer.getLinesContent()).toEqual(['abcXef']);
		buffer.insert(0, '\n');
		expect(buffer.getLinesContent()).toEqual(['', 'abcXef']);
		buffer.delete(0, buffer.getLength());
		expect(buffer.getLinesContent()).toEqual(['']);
		expect(buffer.getLineCount()).toBe(1);
		buffer.insert(0, 'z');
		expect(buffer.getLinesRawContent()).toBe('z');
	});

	it('ignores empty edits', () => {
		const buffer = new LinesTextBuffer('a\nb');
		buffer.insert(1, '');
		buffer.delete(1, 0);
		buffer.delete(1, -1);
		expect(buffer.getLinesRawContent()).toBe('a\nb');
	});

	it('merges and splits \\r\\n across edits', () => {
		const buffer = new LinesTextBuffer('a\rb');
		expect(buffer.getLineCount()).toBe(2);
		buffer.insert(2, '\n'); // a\r\nb
		expect(buffer.getLineCount()).toBe(2);
		expect(buffer.getLinesContent()).toEqual(['a', 'b']);
		buffer.insert(2, 'x'); // a\rx\nb
		expect(buffer.getLinesContent()).toEqual(['a', 'x', 'b']);
		buffer.delete(2, 1); // a\r\nb
		expect(buffer.getLinesContent()).toEqual(['a', 'b']);
		buffer.delete(1, 1); // a\nb
		expect(buffer.getLinesRawContent()).toBe('a\nb');
		buffer.insert(1, '\r'); // a\r\nb
		expect(buffer.getLinesContent()).toEqual(['a', 'b']);
		buffer.delete(2, 1); // a\rb
		expect(buffer.getLinesContent()).toEqual(['a', 'b']);
		expect(buffer.getLinesRawContent()).toBe('a\rb');
	});

	it('setEOL', () => {
		const buffer = new LinesTextBuffer('a\r\nb\rc\nd');
		buffer.setEOL('\n');
		expect(buffer.getLinesRawContent()).toBe('a\nb\nc\nd');
		buffer.setEOL('\r\n');
		expect(buffer.getLinesRawContent()).toBe('a\r\nb\r\nc\r\nd');
		expect(buffer.getLinesContent()).toEqual(['a', 'b', 'c', 'd']);
	});

	it('handles inserts of more than 10k lines', () => {
		const buffer = new LinesTextBuffer('start\nend');
		const big = 'line\n'.repeat(25000);
		buffer.insert(6, big);
		expect(buffer.getLineCount()).toBe(25002);
		expect(buffer.getLineContent(1)).toBe('start');
		expect(buffer.getLineContent(2)).toBe('line');
		expect(buffer.getLineContent(25002)).toBe('end');
		expect(buffer.getLength()).toBe(9 + big.length);
	});

	it('matches a plain string under random edits', () => {
		const alphabet = 'ab \r\n\r\n';
		for (let seed = 1; seed <= 20; seed++) {
			const rng = new Prng(seed);
			const oracle = new StringOracle(rng.nextString(alphabet, rng.nextInt(30)));
			const buffer = new LinesTextBuffer(oracle.text);
			assertMatchesOracle(buffer, oracle);

			for (let i = 0; i < 60; i++) {
				const len = oracle.text.length;
				if (len === 0 || rng.next() < 0.55) {
					const offset = rng.nextInt(len + 1);
					const text = rng.nextString(alphabet, rng.nextInt(8));
					oracle.insert(offset, text);
					buffer.insert(offset, text);
				} else {
					const offset = rng.nextInt(len);
					const cnt = rng.nextInt(Math.min(len - offset, 6) + 1);
					oracle.delete(offset, cnt);
					buffer.delete(offset, cnt);
				}
				assertMatchesOracle(buffer, oracle);
			}
		}
	});
});
