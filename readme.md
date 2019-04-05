# Piece Tree

The underling text buffer used in VS Code/Monaco. For detailed architecture behind it, please read [Text Buffer Reimplementation](https://code.visualstudio.com/blogs/2018/03/23/text-buffer-reimplementation).

## API

```typescript
const pieceTreeTextBufferBuilder = new PieceTreeTextBufferBuilder();
pieceTreeTextBufferBuilder.acceptChunk('abc\n');
pieceTreeTextBufferBuilder.acceptChunk('def');
const pieceTreeFactory = pieceTreeTextBufferBuilder.finish(true);
const pieceTree = pieceTreeFactory.create(DefaultEndOfLine.LF);

pieceTree.getLineCount(); // 2
pieceTree.getLineContent(1); // 'abc'
pieceTree.getLineContent(2); // 'def'

pieceTree.insert(1, '+');
pieceTree.getLineCount(); // 2
pieceTree.getLineContent(1); // 'a+bc'
pieceTree.getLineContent(2); // 'def'
```