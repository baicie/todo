import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-plugin-prettier';
import eslintConfigPrettier from 'eslint-config-prettier';
import { builtinModules } from 'node:module';
import { fixupPluginRules } from '@eslint/compat';
import { omit } from 'lodash-es';

const DOMGlobals = ['window', 'document'];
const NodeGlobals = ['module', 'require'];

const banConstEnum = {
  selector: 'TSEnumDeclaration[const=true]',
  message: 'Please use non-const enums. This project automatically inlines enums.',
};

// 基础规则配置（所有项目共享）
const baseRules = {
  'prettier/prettier': 'warn',
  'no-debugger': 'error',
  'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
  'no-restricted-globals': ['error', ...DOMGlobals, ...NodeGlobals],
  'no-restricted-syntax': ['error', banConstEnum],
  'sort-imports': ['error', { ignoreDeclarationSort: true }],
  'import-x/no-nodejs-modules': ['error', { allow: builtinModules.map((mod) => `node:${mod}`) }],

  // TypeScript Rules
  '@typescript-eslint/prefer-ts-expect-error': 'error',
  '@typescript-eslint/consistent-type-imports': [
    'error',
    {
      fixStyle: 'inline-type-imports',
      disallowTypeAnnotations: false,
    },
  ],
  '@typescript-eslint/no-import-type-side-effects': 'error',
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
};

// React 相关规则
const reactRules = {
  ...react.configs.recommended.rules,
  ...reactHooks.configs.recommended.rules,
  'react/react-in-jsx-scope': 'off',
};

// Patch plugins for ESLint 9/10 compatibility
const patchedReact = fixupPluginRules(react);
const patchedReactHooks = fixupPluginRules(reactHooks);
const patchedImportX = fixupPluginRules(importX);

export default tseslint.config(
  {
    ignores: [
      '**/dist/',
      '**/temp/',
      '**/coverage/',
      '.idea/',
      'explorations/',
      'dts-build/packages',
      'playground',
      '**/.next/',
      '**/.turbo/',
      '**/pnpm-lock.yaml',
    ],
  },
  // =====================================================
  // 后端项目 (NestJS) - 不需要 React 规则
  // =====================================================
  {
    files: ['apps/backend/**/*.ts'],
    extends: [tseslint.configs.base, eslintConfigPrettier],
    plugins: {
      'import-x': patchedImportX,
      prettier: prettier,
    },
    rules: {
      ...omit(baseRules, ['@typescript-eslint/consistent-type-imports']),
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-restricted-globals': 'off',
    },
  },
  // =====================================================
  // Web 前端项目 - 需要 React 规则
  // =====================================================
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    extends: [tseslint.configs.base, eslintConfigPrettier],
    plugins: {
      'import-x': patchedImportX,
      react: patchedReact,
      'react-hooks': patchedReactHooks,
      prettier: prettier,
    },
    settings: {
      react: {
        version: '19.0',
      },
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      ...baseRules,
      ...reactRules,
      'no-restricted-globals': ['error', ...NodeGlobals],
    },
  },
  // =====================================================
  // Desktop (Electron) - 需要 React 规则
  // =====================================================
  {
    files: ['apps/desktop/**/*.ts', 'apps/desktop/**/*.tsx'],
    extends: [tseslint.configs.base, eslintConfigPrettier],
    plugins: {
      'import-x': patchedImportX,
      react: patchedReact,
      'react-hooks': patchedReactHooks,
      prettier: prettier,
    },
    settings: {
      react: {
        version: '19.0',
      },
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      ...baseRules,
      ...reactRules,
      'no-restricted-globals': ['error', ...NodeGlobals],
    },
  },
  // Electron Main Process & Preload
  {
    files: ['apps/desktop/src/main/**/*.ts', 'apps/desktop/src/preload/**/*.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'import-x/no-nodejs-modules': 'off',
    },
  },
  // =====================================================
  // Mobile (React Native) - 需要 React 规则
  // =====================================================
  {
    files: ['apps/mobile/**/*.ts', 'apps/mobile/**/*.tsx'],
    extends: [tseslint.configs.base, eslintConfigPrettier],
    plugins: {
      'import-x': patchedImportX,
      react: patchedReact,
      'react-hooks': patchedReactHooks,
      prettier: prettier,
    },
    settings: {
      react: {
        version: '19.0',
      },
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      ...baseRules,
      ...reactRules,
    },
  },
  // =====================================================
  // Miniprogram (Taro) - 需要 React 规则
  // =====================================================
  {
    files: ['apps/miniprogram/**/*.ts', 'apps/miniprogram/**/*.tsx'],
    extends: [tseslint.configs.base, eslintConfigPrettier],
    plugins: {
      'import-x': patchedImportX,
      react: patchedReact,
      'react-hooks': patchedReactHooks,
      prettier: prettier,
    },
    settings: {
      react: {
        version: '19.0',
      },
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      ...baseRules,
      ...reactRules,
      'no-restricted-globals': ['error', ...NodeGlobals],
    },
  },
  // =====================================================
  // Browser Extension - 需要 React 规则
  // =====================================================
  {
    files: ['apps/browser-ext/**/*.ts', 'apps/browser-ext/**/*.tsx'],
    extends: [tseslint.configs.base, eslintConfigPrettier],
    plugins: {
      'import-x': patchedImportX,
      react: patchedReact,
      'react-hooks': patchedReactHooks,
      prettier: prettier,
    },
    settings: {
      react: {
        version: '19.0',
      },
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      ...baseRules,
      ...reactRules,
      'no-restricted-globals': ['error', ...NodeGlobals],
    },
  },
  // =====================================================
  // Shared packages (pure TypeScript, no React)
  // =====================================================
  {
    files: [
      'packages/todo-model/src/**/*.ts',
      'packages/utils/src/**/*.ts',
      'packages/hooks/src/**/*.ts',
      'packages/ui/src/**/*.ts',
    ],
    extends: [tseslint.configs.base, eslintConfigPrettier],
    plugins: {
      'import-x': patchedImportX,
      prettier: prettier,
    },
    rules: {
      ...omit(baseRules, ['@typescript-eslint/consistent-type-imports']),
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-restricted-globals': 'off',
    },
  },
  // =====================================================
  // VS Code Extension - 不需要 React 规则
  // =====================================================
  {
    files: ['apps/vscode-ext/**/*.ts'],
    extends: [tseslint.configs.base, eslintConfigPrettier],
    plugins: {
      'import-x': patchedImportX,
      prettier: prettier,
    },
    rules: baseRules,
  },
  // =====================================================
  // JavaScript 文件
  // =====================================================
  {
    files: ['*.js'],
    rules: {
      'no-unused-vars': ['error', { vars: 'all', args: 'none' }],
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  // =====================================================
  // 配置文件和脚本 - 宽松规则
  // =====================================================
  {
    files: [
      'eslint.config.js',
      'eslint.config.mjs',
      'rollup*.config.js',
      'rolldown.config.ts',
      'scripts/**',
      './*.{js,ts}',
      'packages/*/*.js',
      '**/vite.config.ts',
      '**/vite.config.js',
    ],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-syntax': ['error', banConstEnum],
      'no-console': 'off',
      'import-x/no-nodejs-modules': 'off',
    },
  },
);
