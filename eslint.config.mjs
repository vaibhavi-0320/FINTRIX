import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "contracts/**",
      "target/**",
      "frontend/design-references/**",
      "frontend/public/**",
      "data/**",
      "ml/.venv/**",
      ".data/**",
      ".vercel/**",
      "test-results/**",
      "playwright-report/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["backend/**/*.ts", "api/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["frontend/src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    // CLI scripts and evaluation reports print results by design.
    files: ["scripts/**", "ml/**", "tests/**", "e2e/**"],
    languageOptions: { globals: globals.node },
    rules: { "no-console": "off" },
  },
);
