import { PieceTreeTextBufferBuilder, DefaultEndOfLine } from '../index';

function createPieceTree(chunks: string[]) {
    const builder = new PieceTreeTextBufferBuilder();
    for (const chunk of chunks) {
        builder.acceptChunk(chunk);
    }
    return builder.finish(true).create(DefaultEndOfLine.LF);
}

describe('random tests', () => {
    it('random insert delete', () => {
        let pieceTreeTextBufferBuilder = new PieceTreeTextBufferBuilder();
        pieceTreeTextBufferBuilder.acceptChunk('abc\n');
        pieceTreeTextBufferBuilder.acceptChunk('def');
        let pieceTreeFactory = pieceTreeTextBufferBuilder.finish(true);
        let pieceTree = pieceTreeFactory.create(DefaultEndOfLine.LF);

        expect(pieceTree.getLineCount()).toEqual(2);
        expect(pieceTree.getLineContent(1)).toEqual('abc');
        expect(pieceTree.getLineContent(2)).toEqual('def');

        pieceTree.insert(1, '+');
        expect(pieceTree.getLineCount()).toEqual(2);
        expect(pieceTree.getLineContent(1)).toEqual('a+bc');
        expect(pieceTree.getLineContent(2)).toEqual('def');
    });
});

describe('equal', () => {
    it('compares content regardless of how it is chunked', () => {
        expect(createPieceTree(['abc']).equal(createPieceTree(['ab', 'c']))).toBe(true);
        expect(createPieceTree(['ab', 'cd', 'e']).equal(createPieceTree(['ab', 'c', 'de']))).toBe(true);
        expect(createPieceTree(['']).equal(createPieceTree(['']))).toBe(true);
    });

    it('detects differences past the first piece', () => {
        expect(createPieceTree(['ab', 'cd', 'e']).equal(createPieceTree(['ab', 'cd', 'f']))).toBe(false);
        expect(createPieceTree(['abc']).equal(createPieceTree(['abd']))).toBe(false);
        expect(createPieceTree(['abc']).equal(createPieceTree(['abcd']))).toBe(false);
        expect(createPieceTree(['a']).equal(createPieceTree(['']))).toBe(false);
    });

    it('compares edited buffers', () => {
        const a = createPieceTree(['ab', 'cd', 'e']);
        const b = createPieceTree(['abcde']);
        a.insert(2, 'X');
        expect(a.equal(b)).toBe(false);
        b.insert(2, 'X');
        expect(a.equal(b)).toBe(true);
        a.delete(0, 1);
        expect(a.equal(b)).toBe(false);
    });
});
