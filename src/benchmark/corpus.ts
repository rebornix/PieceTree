import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { Prng } from '../test/prng';

/** fs.readFile / streams hand text to the editor in 64 KB chunks. */
export const CHUNK_SIZE = 64 * 1024;

export interface IDocument {
	name: string;
	/** The UTF-8 bytes, kept off the JS heap so that only the buffers under test hold text strings. */
	buffer: Buffer;
	bytes: number;
	lines: number;
	/**
	 * Decode the document into fresh chunk strings, independent of any string
	 * held elsewhere, so that a buffer's retained memory can be measured.
	 */
	load(): string[];
}

/** Decode a UTF-8 buffer into independent strings of at most `chunkSize` bytes. */
export function chunkBuffer(buffer: Buffer, chunkSize: number = CHUNK_SIZE): string[] {
	const decoder = new StringDecoder('utf8');
	const chunks: string[] = [];
	for (let offset = 0; offset < buffer.length; offset += chunkSize) {
		const chunk = decoder.write(buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length)));
		if (chunk.length > 0) {
			chunks.push(chunk);
		}
	}
	const rest = decoder.end();
	if (rest.length > 0) {
		chunks.push(rest);
	}
	return chunks;
}

export function countLines(buffer: Buffer): number {
	let lines = 1;
	for (let i = 0, len = buffer.length; i < len; i++) {
		const b = buffer[i];
		if (b === 10 /* \n */) {
			lines++;
		} else if (b === 13 /* \r */ && buffer[i + 1] !== 10) {
			lines++;
		}
	}
	return lines;
}

export function bufferDocument(name: string, buffer: Buffer): IDocument {
	return {
		name,
		buffer,
		bytes: buffer.length,
		lines: countLines(buffer),
		load: () => chunkBuffer(buffer)
	};
}

export function fileDocument(filePath: string, name: string = path.basename(filePath)): IDocument {
	return bufferDocument(name, fs.readFileSync(filePath));
}

/** The document repeated `times` times, like the blog post's "checker.ts x 128". */
export function repeatDocument(doc: IDocument, times: number): IDocument {
	const parts: Buffer[] = [];
	for (let i = 0; i < times; i++) {
		parts.push(doc.buffer);
		if (i < times - 1 && doc.buffer[doc.buffer.length - 1] !== 10) {
			parts.push(Buffer.from('\n'));
		}
	}
	return bufferDocument(`${doc.name} x ${times}`, Buffer.concat(parts));
}

/* ------------------------------------------------------------------------- */
/* The blog post's files                                                     */
/* ------------------------------------------------------------------------- */

export const CORPUS_DIR = path.resolve(__dirname, '..', '..', 'bench-corpus');

export interface ICorpusFile {
	file: string;
	url: string;
	/** As quoted in the blog post. */
	quoted: string;
}

/** Pinned to the revisions whose sizes match the blog post. Downloaded by fetchCorpus.ts. */
export const CORPUS_FILES: ICorpusFile[] = [
	{
		file: 'checker.ts',
		url: 'https://raw.githubusercontent.com/microsoft/TypeScript/v2.7.1/src/compiler/checker.ts',
		quoted: '1.46 MB, 26k lines'
	},
	{
		file: 'sqlite3.c',
		url: 'https://raw.githubusercontent.com/emscripten-core/emscripten/1.37.36/tests/sqlite/sqlite3.c',
		quoted: '4.31 MB, 128k lines'
	},
	{
		file: 'Russian-English Bilingual.dic',
		url: 'https://raw.githubusercontent.com/titoBouzout/Dictionaries/344c988aa3b05cf3d9691bdada2fd629795d7468/Russian-English%20Bilingual.dic',
		quoted: '14 MB, 552k lines'
	}
];

export function corpusPath(file: ICorpusFile): string {
	return path.join(CORPUS_DIR, file.file);
}

/* ------------------------------------------------------------------------- */
/* Synthetic documents                                                       */
/* ------------------------------------------------------------------------- */

export interface ISyntheticSpec {
	name: string;
	/** Target size in bytes and number of lines; both are matched approximately. */
	bytes: number;
	lines: number;
	/** What the shape of the text is modelled on. */
	modelledOn: string;
}

const MiB = 1024 * 1024;

/**
 * Shaped like the files of the blog post, so the same categories can be run
 * without downloading anything (see fetchCorpus.ts for the real ones).
 */
export const SYNTHETIC_SPECS: Record<string, ISyntheticSpec> = {
	tiny: { name: 'synthetic tiny', bytes: 100 * 1024, lines: 2_000, modelledOn: 'smoke test' },
	small: { name: 'synthetic small', bytes: 1.46 * MiB, lines: 26_000, modelledOn: 'checker.ts (1.46 MB, 26k lines)' },
	medium: { name: 'synthetic medium', bytes: 4.31 * MiB, lines: 128_000, modelledOn: 'sqlite3.c (4.31 MB, 128k lines)' },
	large: { name: 'synthetic large', bytes: 14 * MiB, lines: 552_000, modelledOn: 'Russian-English dictionary (14 MB, 552k lines)' },
	huge: { name: 'synthetic huge', bytes: 54 * MiB, lines: 3_000_000, modelledOn: 'Chromium heap snapshot (54 MB, 3M lines)' },
};

const WORDS = ('function return const let if else for while switch case break continue new this class extends ' +
	'import export from default interface type number string boolean void null undefined true false ' +
	'node value length offset index count line column start end buffer chunk piece tree result item ' +
	'static int char void struct unsigned const sizeof return NULL assert memcpy malloc free ' +
	'select insert update delete where order by group having join left inner outer').split(' ');
const PUNCTUATION = ['', '', '', ';', ',', ' {', '}', ')', '(', ' =', ' +', '.', ':'];

/**
 * Deterministic code-like text: indented lines of words and punctuation whose
 * lengths spread around the target average (a mix of short, typical and long
 * lines), ASCII only so that bytes == chars.
 */
export function generateSyntheticText(spec: ISyntheticSpec, seed: number = 12345): string {
	const rng = new Prng(seed);
	const targetLineCount = spec.lines;
	const meanLength = Math.max(1, spec.bytes / targetLineCount - 1); // -1 for the line break
	// the mixture below has an expected length of 0.9 * m + 0.45 (for m >= 6)
	const m = Math.max(1, (meanLength - 0.45) / 0.9);
	const lines: string[] = [];
	for (let i = 0; i < targetLineCount; i++) {
		const roll = rng.next();
		let targetLength: number;
		if (roll < 0.15) {
			targetLength = rng.nextIntBetween(0, Math.min(6, Math.round(m)));
		} else if (roll < 0.9) {
			targetLength = rng.nextIntBetween(Math.round(m * 0.5), Math.round(m * 1.3));
		} else {
			targetLength = rng.nextIntBetween(Math.round(m * 1.5), Math.round(m * 3));
		}
		let line = '\t'.repeat(Math.min(rng.nextInt(4), targetLength));
		while (line.length < targetLength) {
			line += WORDS[rng.nextInt(WORDS.length)] + PUNCTUATION[rng.nextInt(PUNCTUATION.length)] + ' ';
		}
		lines.push(line.length > targetLength ? line.substring(0, targetLength) : line);
	}
	return lines.join('\n');
}

export function syntheticDocument(spec: ISyntheticSpec, seed?: number): IDocument {
	return bufferDocument(spec.name, Buffer.from(generateSyntheticText(spec, seed), 'utf8'));
}
