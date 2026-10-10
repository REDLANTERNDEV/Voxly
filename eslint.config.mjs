import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier";
import hooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/dist-test/**",
    "**/target/**",
    "coverage/**",
    "test-results/**",
    "playwright-report/**",
    "voice-lab-results/**",
    ".scratch/**",
    "docs/superpowers/**",
    "sast/**",
    "Voxly-App-UI/**",
    "voxly-*-pack*/**",
    "voxly-monochrome-logo-bundle/**",
    "Old-ui-and-logopack/**"
  ]),
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    extends: [js.configs.recommended],
    rules: { "no-empty": ["error", { allowEmptyCatch: true }] }
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }
      ],
      // Named DTO interfaces may extend an existing subset without adding fields.
      "@typescript-eslint/no-empty-object-type": ["error", { allowInterfaces: "with-single-extends" }]
    }
  },
  {
    files: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.ts"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }]
    }
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": hooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn"
    }
  },
  {
    files: ["**/test/**", "**/*.test.{ts,mjs}"],
    rules: {
      // Browser/native fixtures deliberately use partial objects and runtime replacement.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-this-alias": "off"
    }
  },
  {
    files: ["apps/web/src/worklets/*.js"],
    languageOptions: { globals: { AudioWorkletProcessor: "readonly", registerProcessor: "readonly" } }
  },
  prettier
);
