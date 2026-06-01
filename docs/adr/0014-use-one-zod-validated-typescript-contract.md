# Use one Zod-validated TypeScript contract

The project will use TypeScript strict mode, `tsc`, Vitest, ESLint, Prettier, and Zod. Zod schemas define and validate the public request and result envelopes used by both the TypeScript API and the JSON CLI, preventing separate validation logic from drifting across integration paths.
