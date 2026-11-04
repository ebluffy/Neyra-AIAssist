import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
export default tseslint.config({ ignores: ['dist', 'src-tauri/target'] }, js.configs.recommended, ...tseslint.configs.recommended, { files: ['scripts/**/*.mjs'], languageOptions: { globals: globals.node } }, { files: ['src/**/*.{ts,tsx}'], languageOptions: { globals: globals.browser }, plugins: { 'react-hooks': hooks }, rules: hooks.configs.recommended.rules });
