import js from "@eslint/js";
import tseslint from "typescript-eslint";

const config = [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.next/**", "**/coverage/**", "**/*.sql"],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
    },
  },
  {
    files: ["**/test/**/*.ts", "scripts/**/*.ts", "apps/api/src/server.ts", "**/*-cli.ts"],
    rules: { "no-console": "off" },
  },
];

export default config;
