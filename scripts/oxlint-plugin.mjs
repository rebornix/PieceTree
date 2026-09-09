// Stand-ins for VS Code local rules and for typescript-eslint/naming-convention,
// which Oxlint does not implement natively yet.
const pascalCase = /^[A-Z][a-zA-Z0-9]*$/;

function selectorRule(selector, message) {
	return {
		create(context) {
			return {
				[selector](node) {
					context.report({ node, message });
				}
			};
		}
	};
}

export default {
	meta: { name: 'local' },
	rules: {
		'code-no-any-casts': selectorRule(
			'TSTypeAssertion[typeAnnotation.type="TSAnyKeyword"], TSAsExpression[typeAnnotation.type="TSAnyKeyword"]',
			'Do not cast to `any`; use a more specific type or a type guard. (VS Code: local/code-no-any-casts)'
		),
		'code-no-dangerous-type-assertions': selectorRule(
			':matches(TSTypeAssertion, TSAsExpression)[typeAnnotation.type!="TSAnyKeyword"] > ObjectExpression',
			'Do not type-assert an object literal, it hides missing or misspelled properties. (VS Code: local/code-no-dangerous-type-assertions)'
		),
		'code-no-test-async-suite': selectorRule(
			':matches(CallExpression[callee.name=/^(describe|suite)$/], CallExpression[callee.object.name=/^(describe|suite)$/]) > :function[async=true]',
			'describe() callbacks must not be async; register tests synchronously. (VS Code: local/code-no-test-async-suite)'
		),
		'class-pascal-case': {
			create(context) {
				function check(node) {
					if (node.id && !pascalCase.test(node.id.name)) {
						context.report({
							node: node.id,
							message: 'Class names must be PascalCase.'
						});
					}
				}
				return {
					ClassDeclaration: check,
					ClassExpression: check
				};
			}
		}
	}
};
