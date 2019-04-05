import { PieceTreeBase } from '../pieceTreeBase';
import { PieceTreeTextBufferBuilder, DefaultEndOfLine } from '../pieceTreeBuilder';

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
    });
});
