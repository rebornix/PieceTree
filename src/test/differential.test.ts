import { createTree, expectNoDivergence, generateScenario, Mode, runScenario, Scenario } from './differential';

/**
 * Differential tests: random editing sessions are applied to the piece tree
 * and to the array-of-lines reference buffer (LinesTextBuffer), and all
 * observable behaviour is compared after every edit.
 *
 * Failures print a shrunk, replayable scenario. Paste it into PINNED below to
 * turn it into a permanent regression test.
 */

const PINNED: { name: string; scenario: Scenario }[] = [
	{
		// upstream 'random insert/delete \r bug 1', expressed as a scenario
		name: 'CR/LF stitching across pieces',
		scenario: {
			mode: 'mixed',
			chunks: ['a'],
			defaultEOL: '\n',
			ops: [
				{ op: 'delete', offset: 0, length: 1 },
				{ op: 'insert', offset: 0, text: '\r\r\n\n' },
				{ op: 'delete', offset: 3, length: 1 },
				{ op: 'insert', offset: 2, text: '\n\n\ra' },
				{ op: 'delete', offset: 4, length: 3 },
				{ op: 'insert', offset: 2, text: '\na\r\r' },
			],
		},
	},
	{
		// shrunk output of the harness for the builder bug fixed in #5
		name: 'document reduced to a lone \\r',
		scenario: { mode: 'mixed', chunks: ['\n'], defaultEOL: '\n', ops: [{ op: 'insert', offset: 1, text: 'c\r' }, { op: 'delete', offset: 0, length: 2 }] },
	},
	{
		// upstream 'delete random bug rb tree 1', expressed as a scenario
		name: 'rb tree delete',
		scenario: {
			mode: 'normalized',
			chunks: [''],
			defaultEOL: '\n',
			ops: [
				{ op: 'insert', offset: 0, text: 'YXXZ\n\nYY\n' },
				{ op: 'delete', offset: 0, length: 5 },
				{ op: 'insert', offset: 0, text: 'ZXYY\nX\nZ\n' },
				{ op: 'insert', offset: 10, text: '\nXY\nYXYXY' },
			],
		},
	},
];

describe('differential: piece tree vs LinesTextBuffer', () => {
	describe('pinned scenarios', () => {
		for (const { name, scenario } of PINNED) {
			it(name, () => {
				expectNoDivergence(scenario);
			});
		}
	});

	describe('harness', () => {
		it('generation is deterministic', () => {
			const a = generateScenario({ seed: 42, mode: 'mixed', opCount: 50 });
			const b = generateScenario({ seed: 42, mode: 'mixed', opCount: 50 });
			const c = generateScenario({ seed: 43, mode: 'mixed', opCount: 50 });
			expect(a).toEqual(b);
			expect(a).not.toEqual(c);
			expect(a.ops).toHaveLength(50);
		});

		it('detects a divergence, shrinks it and the shrunk scenario replays', () => {
			// a tree that returns the wrong content for line 2 once the document is long enough
			const createSabotagedTree = (scenario: Scenario) => {
				const tree = createTree(scenario);
				const original = tree.getLineContent.bind(tree);
				tree.getLineContent = (lineNumber: number) => {
					const value = original(lineNumber);
					return (lineNumber === 2 && tree.getLength() > 60) ? value + '!' : value;
				};
				return tree;
			};
			const scenario = generateScenario({ seed: 7, mode: 'normalized', opCount: 200, initialLength: 30 });
			expect(runScenario(scenario)).toBeNull();
			expect(runScenario(scenario, { createTree: createSabotagedTree })).not.toBeNull();

			let message = '';
			try {
				expectNoDivergence(scenario, { createTree: createSabotagedTree });
			} catch (e) {
				message = (e as Error).message;
			}
			expect(message).toContain('getLineContent(2)');
			expect(message).toContain('Shrunk to');

			const shrunk: Scenario = JSON.parse(message.substring(message.indexOf('{"mode"')));
			expect(shrunk.ops.length).toBeLessThan(scenario.ops.length);
			expect(shrunk.ops.length).toBeLessThanOrEqual(3);
			// the shrunk scenario still exposes the sabotage but is fine on the real tree
			expect(runScenario(shrunk, { createTree: createSabotagedTree })).not.toBeNull();
			expect(runScenario(shrunk)).toBeNull();
		});
	});

	const modes: Mode[] = ['normalized', 'mixed'];
	for (const mode of modes) {
		describe(`${mode} EOL, small documents, checked after every op`, () => {
			for (let seed = 1; seed <= 12; seed++) {
				it(`seed ${seed}`, () => {
					expectNoDivergence(generateScenario({ seed, mode, opCount: 150, initialLength: 120, insertLength: 12 }));
				});
			}
		});

		describe(`${mode} EOL, empty start, heavy typing`, () => {
			for (let seed = 100; seed <= 105; seed++) {
				it(`seed ${seed}`, () => {
					const scenario = generateScenario({ seed, mode, opCount: 300, initialLength: 0, insertLength: 4, bigEditRate: 0.01 });
					expectNoDivergence(scenario);
				});
			}
		});

		describe(`${mode} EOL, larger documents, sampled checks`, () => {
			for (let seed = 200; seed <= 203; seed++) {
				it(`seed ${seed}`, () => {
					const scenario = generateScenario({ seed, mode, opCount: 400, initialLength: 20000, insertLength: 40, bigEditRate: 0.08 });
					expectNoDivergence(scenario, { checkEvery: 25, thorough: false });
				});
			}
		});
	}

	describe('inserts larger than AverageBufferSize are split into several pieces', () => {
		for (const mode of modes) {
			it(mode, () => {
				const eol = mode === 'normalized' ? '\n' : '\r\n';
				const line = 'abcdefghijklmnopqrstuvwxyz'.repeat(3) + eol;
				// in mixed mode the big insert ends with a dangling \r that the next insert completes
				const big = line.repeat(Math.ceil(200000 / line.length)) + (mode === 'mixed' ? '\r' : '');
				const scenario: Scenario = {
					mode,
					chunks: ['start' + eol, 'end'],
					defaultEOL: '\n',
					ops: [
						{ op: 'insert', offset: 5 + eol.length, text: big },
						{ op: 'insert', offset: 5 + eol.length + big.length, text: mode === 'normalized' ? 'x' : '\n' },
						{ op: 'delete', offset: 65530, length: 20 },
						{ op: 'insert', offset: 65535, text: big },
						{ op: 'delete', offset: 100, length: 250000 },
						{ op: 'setEOL', eol: '\r\n' },
						{ op: 'delete', offset: 0, length: 3 },
					],
				};
				expectNoDivergence(scenario, { checkEvery: 1, thorough: true });
			});
		}
	});
});
