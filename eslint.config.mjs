import { defineConfig } from "eslint/config";
import typescriptEslint from "typescript-eslint";

export default defineConfig({
	files: ["**/*.ts"],
	extends: typescriptEslint.configs.recommended,
	rules: {
		"@typescript-eslint/no-explicit-any": "off",
		"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
		"@typescript-eslint/naming-convention": [
			"warn",
			{
				selector: "import",
				format: ["camelCase", "PascalCase"],
			},
		],
		curly: "warn",
		eqeqeq: "warn",
		"no-throw-literal": "warn",
		semi: "warn",
	},
});
