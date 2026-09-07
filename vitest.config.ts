import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			// report on the whole library, not only on files the tests happen to load
			include: ['src/**/*.ts'],
			exclude: ['src/test/**'],
			reporter: ['text', 'lcov'],
		},
	},
});
