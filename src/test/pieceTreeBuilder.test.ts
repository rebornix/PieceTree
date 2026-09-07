import { describe, expect, it } from 'vitest';
import { createTextBuffer } from './testUtils';

function splitLines(text: string): string[] {
	return text.split(/\r\n|\r|\n/);
}

/**
 * The builder holds back a trailing \r or high surrogate of every chunk so
 * that a \r\n pair or a surrogate pair split across two chunks ends up in one
 * chunk. These tests cover the corner cases of that mechanism.
 */
describe('PieceTreeTextBufferBuilder', () => {
	describe('held-back trailing characters', () => {
		it('a document that is a single \\r', () => {
			const tree = createTextBuffer(['\r'], false);
			expect(tree.getLinesRawContent()).toBe('\r');
			expect(tree.getLineCount()).toBe(2);
			expect(tree.getLength()).toBe(1);
		});

		it('a document that is a single high surrogate', () => {
			const tree = createTextBuffer(['\uD83D'], false);
			expect(tree.getLinesRawContent()).toBe('\uD83D');
			expect(tree.getLineCount()).toBe(1);
		});

		it('a chunk that is only a \\r right after a chunk ending in \\r', () => {
			expect(createTextBuffer(['a\r', '\r', 'b'], false).getLinesRawContent()).toBe('a\r\rb');
			expect(createTextBuffer(['a\r', '\r', 'b'], false).getLineCount()).toBe(3);
			expect(createTextBuffer(['ab\r', '\rcd'], false).getLinesRawContent()).toBe('ab\r\rcd');
			expect(createTextBuffer(['\r', '\r'], false).getLinesRawContent()).toBe('\r\r');
			expect(createTextBuffer(['\r', '\r'], false).getLineCount()).toBe(3);
			expect(createTextBuffer(['\r', '\r', '\r'], false).getLinesRawContent()).toBe('\r\r\r');
		});

		it('\\r\\n split across chunks is a single line break', () => {
			expect(createTextBuffer(['a\r', '\nb'], false).getLinesRawContent()).toBe('a\r\nb');
			expect(createTextBuffer(['a\r', '\nb'], false).getLineCount()).toBe(2);
			expect(createTextBuffer(['\r', '\n'], false).getLineCount()).toBe(2);
			expect(createTextBuffer(['a\r', '\r', '\nb'], false).getLinesRawContent()).toBe('a\r\r\nb');
			expect(createTextBuffer(['a\r', '\r', '\nb'], false).getLineCount()).toBe(3);
		});

		it('surrogate pairs split across chunks', () => {
			const tree = createTextBuffer(['a\uD83D', '\uDE00b'], false);
			expect(tree.getLinesRawContent()).toBe('a\uD83D\uDE00b');
			expect(tree.getLineCount()).toBe(1);
			expect(createTextBuffer(['\uD83D', '\uDE00'], false).getLinesRawContent()).toBe('\uD83D\uDE00');
		});

		it('held-back \\r is counted once when picking and normalizing the EOL', () => {
			// only CR line breaks -> CRLF wins, and every break is normalized exactly once
			expect(createTextBuffer(['\r'], true).getLinesRawContent()).toBe('\r\n');
			expect(createTextBuffer(['\r'], true).getLineCount()).toBe(2);
			expect(createTextBuffer(['a\r', '\r', 'b'], true).getLinesRawContent()).toBe('a\r\n\r\nb');
			// a lone \r is outvoted by two \n
			expect(createTextBuffer(['a\n', 'b\n', 'c\r'], true).getLinesRawContent()).toBe('a\nb\nc\n');
		});
	});

	it('produces the same document regardless of how the text is chunked', () => {
		const texts = [
			'\r', '\r\r', '\r\n', '\n\r', 'a\r\r\nb', 'ab\r\ncd\r\r\n\n', '\r\n\r\n\r',
			'\uD83D\uDE00\r\uD83D\uDE00', 'x\r\uD83D\uDE00\ny', '\uD83D\r\uDE00',
		];
		for (const text of texts) {
			const expectedLines = splitLines(text);
			for (let i = 0; i <= text.length; i++) {
				for (let j = i; j <= text.length; j++) {
					const chunks = [text.substring(0, i), text.substring(i, j), text.substring(j)];
					const tree = createTextBuffer(chunks, false);
					expect(tree.getLinesRawContent()).toBe(text);
					expect(tree.getLineCount()).toBe(expectedLines.length);
					expect(tree.getLinesContent()).toEqual(expectedLines);
				}
			}
		}
	});
});
