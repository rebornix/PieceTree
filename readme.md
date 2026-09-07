# Piece Tree

[![CI](https://github.com/rebornix/PieceTree/actions/workflows/ci.yml/badge.svg)](https://github.com/rebornix/PieceTree/actions/workflows/ci.yml)

The underling text buffer used in VS Code/Monaco. For detailed architecture behind it, please read [Text Buffer Reimplementation](https://code.visualstudio.com/blogs/2018/03/23/text-buffer-reimplementation).

```
npm install vscode-piece-tree
```
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

## Benchmarks

`npm run bench` reproduces the comparisons of the [Text Buffer Reimplementation](https://code.visualstudio.com/blogs/2018/03/23/text-buffer-reimplementation) post between the piece tree and the line array it replaced, using the workloads of the text buffer benchmarks VS Code had at the time:

1. memory usage after loading a file
2. file opening time: building the buffer from the 64 KB chunks `fs.readFile` delivers
3. editing: 1000 random edits (replace or delete a random range of a random line), 1000 sequential inserts (typing at the end of the document)
4. reading: `getLineContent` for all lines, and for 10 windows of 100 lines, after those edits
5. saving: reading back the full text after those edits

The baseline ([`src/benchmark/lineArrayBuffer.ts`](src/benchmark/lineArrayBuffer.ts)) is a compact port of VS Code 1.21's `LinesTextBuffer`: an array of line strings plus lazily recomputed prefix sums of the line lengths for offset/position conversion. Both buffers are driven the way `TextModel.applyEdits` drove them (line/column range in; offset, length and replaced text out), and the harness checks that they agree on every result, so it also acts as a differential test. Edits are generated from a seed and identical for both buffers.

```
npm run bench                       # synthetic documents shaped like the post's files (~30 s)
npm run bench:corpus                # download the post's public files into bench-corpus/
npm run bench -- --corpus           # ... and run on them
npm run bench -- --corpus --huge    # add the 3M-line category (several minutes)
npm run bench -- --json r.json      # also save all samples and environment info
npm run bench -- --help             # all options (--iterations, --file, --seed, ...)
```

### Results

Measured with `npm run bench -- --corpus --huge --iterations 3` on Node 22.14 (V8 12.4), Linux, Intel Xeon, on the files of the post: `checker.ts` (TypeScript 2.7.1), `sqlite3.c` (emscripten 1.37.36), the Russian-English dictionary, and `checker.ts` repeated 128 times. The post's Chromium heap snapshot is not public, so a synthetic 54 MB / 3M-line document stands in for it. The synthetic small/medium/large documents give the same picture as the real files of the same size. The samples are in [`docs/benchmark/results.json`](docs/benchmark/results.json); the charts show the medians on linear axes, so the bars of the small files are barely visible next to the 187 MB one: their values are in the labels and in the table at the end.

The conclusions of the post hold on today's V8.

**Memory**: the piece tree stays close to the size of the text (the chunks plus the line-start tables), the line array needs 1.7–3x as much. The gap is smaller than in the post's chart because by VS Code 1.21 the line array already stored plain strings rather than `ModelLine` objects.

![Memory usage after load](docs/benchmark/memory.svg)

**File opening**: even up to ~100k lines; from a few hundred thousand lines on, splitting into line strings costs more than scanning for line breaks, and the piece tree opens the file 1.2–2.4x faster.

![File opening](docs/benchmark/file-opening.svg)

**Editing**: the piece tree takes 1–4 ms for 1000 edits regardless of file size. The line array's cost grows with the line count, since the prefix sums of line lengths are recomputed after every edit and, for every inserted line, reallocated; on a 3M-line file 1000 sequential inserts take tens of seconds.

![Editing](docs/benchmark/editing.svg)

**Reading**: the piece tree's Achilles heel. After 1000 edits `getLineContent` is 2–5x slower than an array index, but that is 40–55 ns per line when reading the whole file, and ten screenfuls of 100 lines are read in under 0.1 ms.

![Reading after 1000 random edits](docs/benchmark/reading.svg)

**Saving**: the piece tree hands out a few large substrings instead of joining hundreds of thousands of line strings, and is 2–6x faster.

![Saving the full text](docs/benchmark/saving.svg)

<details>
<summary>The same numbers as a table (bold marks the faster buffer)</summary>

| line array → piece tree | checker.ts<br>1.46 MB, 27k lines | sqlite3.c<br>4.31 MB, 128k lines | Russian-English dictionary<br>14.2 MB, 552k lines | synthetic (heap snapshot stand-in)<br>54 MB, 3.0M lines | checker.ts x 128<br>187 MB, 3.4M lines |
|---|---|---|---|---|---|
| memory after load | 2.5 MB → **1.4 MB** | 9.1 MB → **4.4 MB** | 40.5 MB → **18.5 MB** | 172.9 MB → **54.5 MB** | 315.3 MB → **188.2 MB** |
| file opening | 3.14 ms → 3.63 ms | 10.68 ms → 12.71 ms | 69.26 ms → **29.37 ms** | 406.6 ms → **187.4 ms** | 640.6 ms → **528.4 ms** |
| 1000 random edits | 7.94 ms → **3.11 ms** | 37.95 ms → **2.21 ms** | 158.1 ms → **2.96 ms** | 868.7 ms → **2.92 ms** | 987.3 ms → **3.56 ms** |
| 1000 sequential inserts | 12.90 ms → **1.05 ms** | 38.58 ms → **1.18 ms** | 256.1 ms → **1.77 ms** | 14.8 s → **2.00 ms** | 29.0 s → **1.48 ms** |
| read all lines after 1000 random edits | 0.296 ms → 1.41 ms | 1.07 ms → 5.36 ms | 9.20 ms → 29.28 ms | 30.83 ms → 120.6 ms | 67.93 ms → 155.8 ms |
| read 10 windows of 100 lines after 1000 random edits | 0.013 ms → 0.060 ms | 0.018 ms → 0.068 ms | 0.047 ms → 0.092 ms | 0.048 ms → 0.062 ms | 0.070 ms → 0.099 ms |
| save (full text) after 1000 random edits | 1.35 ms → **0.628 ms** | 8.08 ms → **3.13 ms** | 25.31 ms → **7.43 ms** | 156.7 ms → **26.00 ms** | 510.6 ms → **88.71 ms** |

</details>
