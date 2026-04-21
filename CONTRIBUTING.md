# Contributing to Orbit

Thank you for your interest in contributing to Orbit!

## Development Setup

### Prerequisites

- Node.js >= 22
- pnpm >= 10
- Git

### Getting Started

```bash
# Clone the repository
git clone https://github.com/baicie/orbit.git
cd orbit

# Install dependencies
pnpm install

# Start development servers
pnpm dev
```

## Project Structure

```
orbit/
├── apps/                      # Applications
│   ├── orbit-web/             # Web (Vite + React)
│   ├── orbit-desktop/         # Desktop (Tauri + React)
│   ├── orbit-backend/         # Backend (NestJS)
│   ├── orbit-mobile/          # Mobile (React Native + Expo)
│   ├── orbit-miniprogram/     # Mini Program (Taro)
│   ├── orbit-browser-ext/      # Browser Extension
│   └── orbit-vscode-ext/      # VSCode Extension
├── packages/                  # Shared packages
│   ├── orbit/                 # Core data model
│   ├── orbit-hooks/           # React hooks
│   ├── orbit-ui/              # UI components
│   ├── orbit-utils/           # Utilities
│   └── orbit-tsconfig/        # TypeScript config
└── pnpm-workspace.yaml
```

## Building

```bash
# Build all apps and packages
pnpm build

# Build specific app
pnpm build:web
pnpm build:desktop
pnpm build:browser-ext
pnpm build:backend
pnpm build:miniprogram
pnpm build:mobile
pnpm build:vscode-ext
```

## Code Quality

```bash
# Lint
pnpm lint

# Format
pnpm format

# Type check
pnpm check
```

## Commit Convention

This project uses [Conventional Commits](https://www.conventionalcommits.org/). Commit messages are validated on commit.

Format: `<type>(<scope>): <description>`

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

## Apps in Development

### Web / Desktop / Browser Extension

Standard Vite + React development:

```bash
cd apps/orbit-web
pnpm dev
```

### Backend

```bash
cd apps/orbit-backend
pnpm start:dev
```

### Mobile (Expo)

```bash
cd apps/orbit-mobile
pnpm start
```

### Mini Program (Taro)

```bash
cd apps/orbit-miniprogram
pnpm dev:weapp  # WeChat Mini Program
pnpm dev:h5     # H5
```

### VSCode Extension

```bash
cd apps/orbit-vscode-ext
pnpm watch
# Press F5 in VSCode to debug
```

## Questions?

Open an issue on GitHub for bug reports or feature requests.
