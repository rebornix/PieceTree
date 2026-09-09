import { describe, it, expect } from 'vitest';
import { AverageBufferSize, PieceTreeBase } from '../pieceTreeBase';
import { SENTINEL } from '../rbTreeBase';
import { assertTreeInvariants, createTextBuffer, readSnapshot } from './testUtils';

function countNodes(tree: PieceTreeBase): number {
	let n = 0;
	tree.iterate(tree.root, node => {
		if (node !== SENTINEL) {
			n++;
		}
		return true;
	});
	return n;
}

function collectBufferIndices(tree: PieceTreeBase): Set<number> {
	const indices = new Set<number>();
	tree.iterate(tree.root, node => {
		if (node !== SENTINEL) {
			indices.add(node.piece.bufferIndex);
		}
		return true;
	});
	return indices;
}

describe('change buffer rotation', () => {
	it('keeps content correct when sequential typing exceeds AverageBufferSize', () => {
		const tree = createTextBuffer(['']);
		let expected = '';
		const chunk = 'abcdefghij'; // 10 chars
		const rounds = Math.ceil((AverageBufferSize * 2.5) / chunk.length);
		for (let i = 0; i < rounds; i++) {
			tree.insert(expected.length, chunk);
			expected += chunk;
		}
		expect(tree.getLinesRawContent()).toBe(expected);
		expect(tree.getLength()).toBe(expected.length);
		assertTreeInvariants(tree);
		expect(countNodes(tree)).toBe(tree._nodeCount);
		// more than the original empty change buffer
		expect(collectBufferIndices(tree).size).toBeGreaterThan(1);
	});

	it('keeps the append fast path until the current change buffer is full', () => {
		const tree = createTextBuffer(['abc']);
		tree.insert(3, 'd');
		tree.insert(4, 'e');
		expect(tree.getLineContent(1)).toBe('abcde');
		expect(countNodes(tree)).toBe(2); // original chunk + one change piece
		assertTreeInvariants(tree);
	});

	it('pushes line starts onto the change buffer across many newlines', () => {
		const tree = createTextBuffer(['x']);
		let expected = 'x';
		for (let i = 0; i < 2000; i++) {
			tree.insert(expected.length, '\n' + i);
			expected += '\n' + i;
		}
		expect(tree.getLinesRawContent()).toBe(expected);
		expect(tree.getLineCount()).toBe(2001);
		assertTreeInvariants(tree);
		expect(countNodes(tree)).toBe(tree._nodeCount);
	});
});

describe('compact', () => {
	it('rebuilds a fragmented tree without changing the text', () => {
		const tree = createTextBuffer(['abcdefghij']);
		let expected = 'abcdefghij';
		for (let i = 0; i < 200; i++) {
			const pos = (i * 3) % (expected.length + 1);
			tree.insert(pos, 'X');
			expected = expected.slice(0, pos) + 'X' + expected.slice(pos);
		}
		const before = tree._nodeCount;
		expect(before).toBeGreaterThan(50);
		expect(countNodes(tree)).toBe(before);

		tree.compact();

		expect(tree.getLinesRawContent()).toBe(expected);
		expect(tree.getLineCount()).toBe(1);
		expect(tree._nodeCount).toBeLessThan(before);
		expect(countNodes(tree)).toBe(tree._nodeCount);
		assertTreeInvariants(tree);
	});

	it('does not change a snapshot taken before compact', () => {
		const tree = createTextBuffer(['abc\ndef']);
		tree.insert(1, '!');
		const expected = tree.getLinesRawContent();
		const snapshot = tree.createSnapshot('');
		tree.insert(0, 'zzz');
		for (let i = 0; i < 50; i++) {
			tree.insert(0, 'n');
		}
		tree.compact();
		expect(readSnapshot(snapshot)).toBe(expected);
		assertTreeInvariants(tree);
	});
});

describe('getCharCode / getNearestChunk', () => {
	it('getCharCode matches charCodeAt on the full text', () => {
		const tree = createTextBuffer(['ab\ncd']);
		tree.insert(1, 'X');
		const text = tree.getLinesRawContent();
		for (let i = 0; i < text.length; i++) {
			expect(tree.getCharCode(i)).toBe(text.charCodeAt(i));
		}
	});

	it('getNearestChunk returns the rest of the piece', () => {
		const tree = createTextBuffer(['hello world']);
		expect(tree.getNearestChunk(0)).toBe('hello world');
		expect(tree.getNearestChunk(6)).toBe('world');
		tree.insert(5, '!');
		expect(tree.getNearestChunk(0).startsWith('hello')).toBe(true);
		expect(tree.getCharCode(5)).toBe('!'.charCodeAt(0));
		assertTreeInvariants(tree);
	});

	it('getCharCode / getNearestChunk at EOF and on an empty tree', () => {
		const tree = createTextBuffer(['ab']);
		expect(tree.getCharCode(2)).toBe(0);
		expect(tree.getNearestChunk(2)).toBe('');
		const empty = createTextBuffer(['']);
		expect(empty.getCharCode(0)).toBe(0);
		expect(empty.getNearestChunk(0)).toBe('');
		empty.compact();
		expect(empty.getLinesRawContent()).toBe('');
		expect(empty.getCharCode(0)).toBe(0);
	});
});

describe('sequential line iteration', () => {
	it('forEachLine / iterateLineContents match getLineContent', () => {
		const tree = createTextBuffer(['a\nb\ncde\n', 'fg\n']);
		tree.insert(3, 'X\nY');
		const fromGet: string[] = [];
		for (let i = 1; i <= tree.getLineCount(); i++) {
			fromGet.push(tree.getLineContent(i));
		}
		const fromEach: string[] = [];
		tree.forEachLine((line, n) => {
			fromEach.push(line);
			expect(n).toBe(fromEach.length);
		});
		expect(fromEach).toEqual(fromGet);
		expect([...tree.iterateLineContents()]).toEqual(fromGet);
		expect(tree.getLinesContent()).toEqual(fromGet);
	});

	it('getLinesContent handles mixed CR / CRLF across pieces', () => {
		const tree = createTextBuffer(['abc\r', 'def\r\nghi'], false);
		expect(tree.getLinesContent()).toEqual(['abc', 'def', 'ghi']);
	});
});
