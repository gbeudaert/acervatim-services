// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    languageOptions: {
      parserOptions: { sourceType: 'module', ecmaVersion: 2022 },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
      // Les decorateurs Nest reposent sur des classes vides (DTO Zod) et des
      // constructeurs uniquement parametres : ces deux regles produisent du bruit.
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
);
