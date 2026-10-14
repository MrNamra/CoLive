# Contributing to CoLive

Thank you for your interest in contributing to CoLive! We welcome bug reports, feature requests, documentation improvements, and code contributions.

## Development Workflow

### Prerequisites
- Node.js 20.x or higher
- npm 10.x or higher
- Git

### Monorepo Structure
- `packages/protocol`: Wire protocol definitions, Zod validation schemas, binary framing, path utilities, and WebCrypto E2EE primitives.
- `packages/server`: Standalone Node.js WebSocket relay server with token bucket rate limiting and session management.
- `packages/extension`: The VS Code-compatible extension (`colive`).
- `packages/e2e`: Headless end-to-end integration and stress tests.
- `docs`: Architectural blueprints, protocol specifications, security threat models, and deployment guides.
- `scripts`: Developer utilities, two-window launchers, and load testing harnesses.

### Setup Instructions
```bash
# 1. Clone repository
git clone https://github.com/MrNamra/CoLive.git
cd CoLive

# 2. Install dependencies across workspaces
npm install

# 3. Build all packages
npm run build

# 4. Run test suites
npm test

# 5. Run ESLint
npm run lint
```

### Local Testing with Two Windows
To test real-time collaboration with two instances of VS Code side-by-side:
```bash
# On Linux/macOS
./scripts/dev-two-windows.sh

# On Windows PowerShell
.\scripts\dev-two-windows.ps1
```

### Code Style & Standards
1. **TypeScript Strictness**: Keep `noImplicitAny: true` and `strict: true`. Avoid unhandled `any`; if necessary, add an explanatory comment justifying the type boundary.
2. **Standard APIs**: Use VS Code `^1.90.0` stable public APIs only. Avoid proposed or internal undocumented APIs.
3. **Commit Messages**: Write concise, descriptive commit messages following conventional commits or milestone format: `milestone N: <feature name>` / `fix: <description>`.
4. **Testing**: Any new protocol message, RPC, or file system operation must be accompanied by unit or integration tests in the relevant workspace.

## Submitting Pull Requests
1. Fork the repository and create your branch from `master` (`git checkout -b feature/my-feature`).
2. Verify all checks pass locally:
   ```bash
   npm run build && npm run lint && npm test
   ```
3. Commit your changes and push to your fork.
4. Open a Pull Request with a clear description of the problem solved and test steps.
