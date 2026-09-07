import * as fs from 'fs';
import { CORPUS_DIR, CORPUS_FILES, corpusPath, ICorpusFile } from './corpus';

/**
 * Downloads the public files used in the VS Code blog post
 * "Text Buffer Reimplementation" (2018-03-23) into bench-corpus/, pinned to
 * the revisions that match the sizes quoted there, so that
 * `npm run bench -- --corpus` reproduces its comparisons on the same input.
 *
 * The two "manually created" large files of the post are covered differently:
 * "checker.ts x 128" is produced on the fly (--huge), and the Chromium heap
 * snapshot of a VS Code window is stood in for by the synthetic "huge" document.
 */
async function download(file: ICorpusFile): Promise<void> {
	const target = corpusPath(file);
	if (fs.existsSync(target)) {
		console.log(`${file.file}: already present (${fs.statSync(target).size} bytes)`);
		return;
	}
	console.log(`${file.file}: downloading ${file.url}`);
	const response = await fetch(file.url);
	if (!response.ok) {
		throw new Error(`${file.url}: HTTP ${response.status}`);
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	fs.mkdirSync(CORPUS_DIR, { recursive: true });
	fs.writeFileSync(target, bytes);
	console.log(`${file.file}: ${bytes.length} bytes (blog post: ${file.quoted})`);
}

async function main(): Promise<void> {
	for (const file of CORPUS_FILES) {
		await download(file);
	}
	console.log(`\nCorpus is in ${CORPUS_DIR}. Run: npm run bench -- --corpus`);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
