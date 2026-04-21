# Orbit - Cross-Platform Todo Application

A comprehensive monorepo template for building cross-platform todo applications with shared packages.

## Structure

- **apps/**
  - `orbit-web`: Web Application (Vite + React + TS)
  - `orbit-desktop`: Desktop Application (Tauri + React + TS)
  - `orbit-backend`: Backend Application (NestJS + Docker)
  - `orbit-mobile`: Mobile Application (React Native + Expo)
  - `orbit-miniprogram`: Mini Program (Taro + React)
  - `orbit-vscode-ext`: VSCode Extension
  - `orbit-browser-ext`: Browser Extension (Manifest V3)

- **packages/**
  - `orbit`: Core data model and storage abstraction
  - `orbit-hooks`: Shared React hooks
  - `orbit-ui`: Shared React UI Components
  - `orbit-utils`: Shared Utility Functions
  - `orbit-tsconfig`: Shared TypeScript Configuration

## Getting Started

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Run development servers:

   ```bash
   pnpm dev
   ```

## Deployment

### Docker

To deploy the Web App and Backend using Docker:

```bash
./deploy.sh
```

Or manually:

```bash
docker-compose up -d --build
```

- Web App: http://localhost:8080
- Backend: http://localhost:3001

## Features

- **Monorepo**: Managed by pnpm workspaces.
- **Shared Code**: Data model, hooks, UI components and utility functions shared across all apps.
- **Docker Ready**: Backend and Web apps are containerized.
- **Cross-Platform**: Covers Web, Desktop (Tauri), Mobile, Mini Program, VSCode, and Browser Extensions.
