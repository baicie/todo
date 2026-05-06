import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-plugin-prettier';
import eslintConfigPrettier from 'eslint-config-prettier';
import { builtinModules } from 'node:module';
import { fixupPluginRules } from '@eslint/compat';
import { omit } from 'lodash-es';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// 严格 TypeScript 规则（用于 shared packages 和 backend）
const strictRules = {
  '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
  '@typescript-eslint/consistent-indexed-object-style': ['error', 'record'],
  '@typescript-eslint/no-empty-interface': 'error',
  '@typescript-eslint/no-non-null-assertion': 'warn',
  '@typescript-eslint/prefer-optional-chain': 'error',
  '@typescript-eslint/prefer-nullish-coalescing': 'error',
  '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/return-await': 'error',
  '@typescript-eslint/no-for-in-array': 'error',
  '@typescript-eslint/no-misused-promises': [
    'error',
    { checksVoidReturn: { arguments: false, attributes: false } },
  ],
  '@typescript-eslint/no-unnecessary-condition': 'warn',
  '@typescript-eslint/no-invalid-void-type': 'error',
};

// 前端宽松 TypeScript 规则（不需要类型信息）
const frontendRelaxedRules = {
  '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
  '@typescript-eslint/consistent-indexed-object-style': ['error', 'record'],
  '@typescript-eslint/no-empty-interface': 'error',
  '@typescript-eslint/no-non-null-assertion': 'off',
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/return-await': 'error',
  '@typescript-eslint/no-for-in-array': 'error',
  '@typescript-eslint/no-misused-promises': [
    'error',
    { checksVoidReturn: { arguments: false, attributes: false } },
  ],
  '@typescript-eslint/no-unnecessary-condition': 'warn',
  '@typescript-eslint/no-invalid-void-type': 'error',
};

// 前端类型感知规则（需要 parserOptions.project，无项目级配置时应关闭）
const frontendTypeAwareRules = {
  '@typescript-eslint/prefer-optional-chain': 'error',
  '@typescript-eslint/prefer-nullish-coalescing': 'error',
  '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
};

// 后端/包 类型感知规则（与 frontendTypeAwareRules 相同，额外包含 no-non-null-assertion）
const typeAwareRules = {
  '@typescript-eslint/prefer-optional-chain': 'error',
  '@typescript-eslint/prefer-nullish-coalescing': 'error',
  '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
  '@typescript-eslint/no-non-null-assertion': 'warn',
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
    languageOptions: {
      parserOptions: {
        project: 'apps/backend/tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      ...omit(baseRules, ['@typescript-eslint/consistent-type-imports']),
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-restricted-globals': 'off',
      ...strictRules,
      ...typeAwareRules,
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
        project: 'apps/web/tsconfig.json',
        tsconfigRootDir: __dirname,
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      ...baseRules,
      ...reactRules,
      ...frontendRelaxedRules,
      ...frontendTypeAwareRules,
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
        project: 'apps/desktop/tsconfig.json',
        tsconfigRootDir: __dirname,
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      ...baseRules,
      ...reactRules,
      ...frontendRelaxedRules,
      ...frontendTypeAwareRules,
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
        project: 'apps/mobile/tsconfig.json',
        tsconfigRootDir: __dirname,
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      ...baseRules,
      ...reactRules,
      ...frontendRelaxedRules,
      ...frontendTypeAwareRules,
    },
  },
  // =====================================================
  // Miniprogram (Taro) - 需要 React 规则
  // =====================================================
  {
    files: ['apps/miniprogram/**/*.ts', 'apps/miniprogram/**/*.tsx'],
    ignores: ['apps/miniprogram/config/**'],
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
        project: 'apps/miniprogram/tsconfig.json',
        tsconfigRootDir: __dirname,
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      ...baseRules,
      ...reactRules,
      ...frontendRelaxedRules,
      ...frontendTypeAwareRules,
      '@typescript-eslint/no-import-type-side-effects': 'off',
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
        project: 'apps/browser-ext/tsconfig.json',
        tsconfigRootDir: __dirname,
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      ...baseRules,
      ...reactRules,
      ...frontendRelaxedRules,
      ...frontendTypeAwareRules,
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
      'packages/ui/src/**/*.tsx',
      'packages/plugin-system/src/**/*.ts',
    ],
    extends: [tseslint.configs.base, eslintConfigPrettier],
    plugins: {
      'import-x': patchedImportX,
      prettier: prettier,
    },
    languageOptions: {
      parserOptions: {
        project: [
          'packages/todo-model/tsconfig.json',
          'packages/utils/tsconfig.json',
          'packages/hooks/tsconfig.json',
          'packages/ui/tsconfig.json',
          'packages/plugin-system/tsconfig.json',
        ],
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      ...omit(baseRules, ['@typescript-eslint/consistent-type-imports']),
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-restricted-globals': 'off',
      ...strictRules,
      ...typeAwareRules,
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
    languageOptions: {
      parserOptions: {
        project: 'apps/vscode-ext/tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      ...baseRules,
      ...strictRules,
    },
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
      'apps/miniprogram/config/**',
    ],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-syntax': ['error', banConstEnum],
      'no-console': 'off',
      'import-x/no-nodejs-modules': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/prefer-optional-chain': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/return-await': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
);
