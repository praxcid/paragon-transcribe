/// <reference types="node" />
/// <reference path="./node-shims.d.ts" />

// Allow the project to see basic DOM ReadableStream in server context for our small usage.
declare global {
    interface ReadableStream<R = any> {}
}

export {};
