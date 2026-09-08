// @ts-check
// Deliberately small: the correctness rules microsoft/vscode enables for all of
// its TypeScript (eslint.config.js on main), the conventions this code already
// follows (tabs, single quotes, semicolons, PascalCase classes), and a layering
// check standing in for VS Code's `local/code-layering` / `local/code-import-patterns`.
import { defineConfig, globalIgnores } from 'eslint/config';
import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';
import { builtinModules } from 'node:module';

const nodeBuiltins = [...builtinModules, ...builtinModules.map(name => `node:${name}`)];

// Options of `no-restricted-syntax` do not merge between config objects, so the
// selectors that apply to every file live here and are spread into each override.
const noUnsafeCasts = [
	{
		selector: 'TSTypeAssertion[typeAnnotation.type="TSAnyKeyword"], TSAsExpression[typeAnnotation.type="TSAnyKeyword"]',
		message: 'Do not cast to `any`; use a more specific type or a type guard. (VS Code: local/code-no-any-casts)'
	},
	{
		selector: ':matches(TSTypeAssertion, TSAsExpression)[typeAnnotation.type!="TSAnyKeyword"] > ObjectExpression',
		message: 'Do not type-assert an object literal, it hides missing or misspelled properties. (VS Code: local/code-no-dangerous-type-assertions)'
	}
];

export default defineConfig(
	globalIgnores(['lib/', 'coverage/', 'bench-corpus/']),

	// ---- every TypeScript file ------------------------------------------------
	{
		files: ['**/*.ts'],
		languageOptions: { parser: tseslint.parser },
		plugins: { '@typescript-eslint': tseslint.plugin, '@stylistic': stylistic },
		rules: {
			// Correctness: microsoft/vscode eslint.config.js, the block for all files.
			'constructor-super': 'error',
			'curly': 'error',
			'eqeqeq': 'error',
			'no-async-promise-executor': 'error',
			'no-caller': 'error',
			'no-case-declarations': 'error',
			'no-debugger': 'error',
			'no-duplicate-case': 'error',
			'no-duplicate-imports': 'error',
			'no-eval': 'error',
			'no-misleading-character-class': 'error',
			'no-new-wrappers': 'error',
			'no-restricted-globals': ['error', 'name', 'length', 'event', 'closed', 'external', 'status', 'origin', 'orientation', 'context'],
			'no-sparse-arrays': 'error',
			'no-throw-literal': 'error',
			'no-unsafe-finally': 'error',
			'no-unused-labels': 'error',
			'no-var': 'error',
			'prefer-const': ['error', { destructuring: 'all' }],
			// VS Code's `local/code-no-unused-expressions` is a fork of this rule.
			'@typescript-eslint/no-unused-expressions': ['error', { allowTernary: true }],
			'@typescript-eslint/no-explicit-any': 'error',
			'no-restricted-syntax': ['error', ...noUnsafeCasts],

			// Conventions the code already follows. VS Code enforces the first three
			// through ESLint and the rest through build/hygiene.ts and its formatter.
			'@typescript-eslint/naming-convention': ['error', { selector: 'class', format: ['PascalCase'] }],
			'@stylistic/semi': 'error',
			'@stylistic/member-delimiter-style': 'error',
			'@stylistic/no-extra-semi': 'error',
			'@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'always' }],
			'@stylistic/indent': ['error', 'tab', { SwitchCase: 1 }],
			'@stylistic/no-trailing-spaces': 'error',
			'@stylistic/eol-last': 'error'
		}
	},

	// ---- the library: src/*.ts and src/common/ --------------------------------
	// Platform-neutral and self-contained: no Node.js modules, no tests, no benchmarks.
	{
		files: ['src/*.ts', 'src/common/**/*.ts'],
		rules: {
			'no-restricted-imports': ['error', {
				paths: nodeBuiltins.map(name => ({ name, message: 'The library must stay platform-neutral: no Node.js modules in src/*.ts or src/common/.' })),
				patterns: [{
					group: ['./test/*', '../test/*', './benchmark/*', '../benchmark/*', 'vitest', 'vitest/*'],
					message: 'The library must not depend on its tests or benchmarks.'
				}]
			}]
		}
	},
	// src/common/ is the leaf layer (VS Code's vs/base and editor/common/core): it must not import the tree.
	{
		files: ['src/common/**/*.ts'],
		rules: {
			'no-restricted-imports': ['error', {
				paths: nodeBuiltins.map(name => ({ name, message: 'src/common/ must stay platform-neutral.' })),
				patterns: [{ group: ['../*'], message: 'src/common/ must not import the piece tree; only other src/common/ modules.' }]
			}]
		}
	},

	// ---- tests ------------------------------------------------------------------
	{
		files: ['src/test/**/*.ts'],
		rules: {
			'no-restricted-imports': ['error', {
				patterns: [{ group: ['../benchmark/*'], message: 'Tests must not depend on the benchmark.' }]
			}],
			'no-restricted-syntax': [
				'error',
				...noUnsafeCasts,
				{
					selector: 'MemberExpression[object.name=/^(describe|it|test|suite)$/][property.name="only"]',
					message: '`.only` is a dev-time tool and must not be committed. (VS Code: local/code-no-test-only)'
				},
				{
					selector: ':matches(CallExpression[callee.name=/^(describe|suite)$/], CallExpression[callee.object.name=/^(describe|suite)$/]) > :function[async=true]',
					message: 'describe() callbacks must not be async; register tests synchronously. (VS Code: local/code-no-test-async-suite)'
				}
			]
		}
	},

	// ---- benchmark ----------------------------------------------------------------
	{
		files: ['src/benchmark/**/*.ts'],
		rules: {
			// The benchmark shares the deterministic PRNG with the tests and nothing else.
			'no-restricted-imports': ['error', {
				patterns: [{ group: ['../test/*', '!../test/prng'], message: 'The benchmark may only use src/test/prng from the tests.' }]
			}]
		}
	}
);
