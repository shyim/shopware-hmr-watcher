import js from '@eslint/js';
import globals from 'globals';
export default [
  { ignores: ['node_modules/**', 'reports/**'] },
  js.configs.recommended,
  { files: ['test/**/*.js', 'src/runtime/**/*.js'], languageOptions: { globals: globals.browser } },
  { languageOptions: { globals: { ...globals.node } } },
];
