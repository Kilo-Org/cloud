// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const tseslint = require('typescript-eslint');
const reactNativePlugin = require('eslint-plugin-react-native');
const importXPlugin = require('eslint-plugin-import-x');
const unicornPlugin = require('eslint-plugin-unicorn').default;
const promisePlugin = require('eslint-plugin-promise');
const sonarjsPlugin = require('eslint-plugin-sonarjs');

module.exports = defineConfig([
  // Base Expo config (includes React, React Hooks, basic TS rules)
  expoConfig,

  // TypeScript strict type-checked rules (overrides Expo's loose TS config)
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
  },

  // React Native
  {
    plugins: {
      'react-native': reactNativePlugin,
    },
    rules: {
      'react-native/no-unused-styles': 'error',
      'react-native/no-inline-styles': 'error',
      'react-native/no-raw-text': 'error',
      'react-native/no-single-element-style-arrays': 'error',
      'react-native/no-color-literals': 'error',
    },
  },

  // Import hygiene
  importXPlugin.flatConfigs.recommended,
  importXPlugin.flatConfigs.typescript,
  {
    rules: {
      'import-x/no-unresolved': 'error',
      'import-x/no-cycle': 'error',
      'import-x/no-self-import': 'error',
      'import-x/no-useless-path-segments': 'error',
      'import-x/no-duplicates': 'error',
      'import-x/no-mutable-exports': 'error',
      'import-x/no-default-export': 'error',
      'import-x/consistent-type-specifier-style': ['error', 'prefer-inline'],
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },

  // Unicorn — all recommended rules as errors
  unicornPlugin.configs['flat/all'],
  {
    rules: {
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/no-keyword-prefix': ['error', { disallowedPrefixes: ['new', 'for'] }],
    },
  },

  // Promise
  promisePlugin.configs['flat/recommended'],
  {
    rules: {
      'promise/always-return': 'error',
      'promise/no-return-wrap': 'error',
      'promise/catch-or-return': 'error',
      'promise/no-nesting': 'error',
      'promise/no-promise-in-callback': 'error',
      'promise/no-callback-in-promise': 'error',
      'promise/no-return-in-finally': 'error',
      'promise/prefer-await-to-then': 'error',
      'promise/prefer-await-to-callbacks': 'error',
    },
  },

  // SonarJS — all recommended rules
  sonarjsPlugin.configs.recommended,

  // Restricted imports
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-native',
              importNames: ['Image'],
              message: 'Import Image from @/components/ui/image instead.',
            },
            {
              name: 'expo-image',
              message: 'Import Image from @/components/ui/image instead.',
            },
          ],
        },
      ],
    },
  },

  // Upgrade all warnings from Expo's config to errors
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          vars: 'all',
          args: 'all',
          argsIgnorePattern: '^_',
          ignoreRestSiblings: true,
          caughtErrors: 'all',
        },
      ],
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/no-empty-object-type': 'error',
      '@typescript-eslint/no-wrapper-object-types': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        {
          assertionStyle: 'as',
          objectLiteralTypeAssertions: 'never',
        },
      ],
    },
  },

  // Allow expo-image import in the wrapper component
  {
    files: ['src/components/ui/image.tsx'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  // Allow default exports in route/layout files (Expo Router requires them)
  {
    files: ['src/app/**/_layout.tsx', 'src/app/**/*.tsx'],
    rules: {
      'import-x/no-default-export': 'off',
    },
  },

  {
    ignores: ['dist/*'],
  },
]);
