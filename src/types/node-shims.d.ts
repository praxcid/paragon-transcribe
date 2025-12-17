// Local shims for missing Node 20 lib types used in the project
// These are small, non-exhaustive declarations to satisfy the TypeScript checker.

declare module 'node:fs' {
    export * from 'fs';
}

declare module 'stream/promises' {
    export * from 'stream';
}
