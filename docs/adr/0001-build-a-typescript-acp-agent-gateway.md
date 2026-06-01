# Build a TypeScript ACP Agent Gateway

The project will be a standalone TypeScript ACP Agent Gateway with both a TypeScript API and a JSON CLI boundary. Business projects may import the package directly or invoke the JSON CLI from another language. This keeps Agent integration reusable while avoiding a direct dependency on any consumer's implementation language.

## Considered Options

- Extend each business project's existing language-specific Agent client: simpler for the first consumer, but repeats adapter, permission, timeout, and event handling work.
- Provide only an importable TypeScript package: sufficient for TypeScript consumers, but inconvenient for Python, Go, or shell consumers.
- Provide a TypeScript package and JSON CLI: chosen because it supports native TypeScript usage and language-neutral integration.
