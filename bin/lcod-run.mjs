#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const runtimeRoot = path.join(root, 'runtime');
if (!process.env.LCOD_HOME) {
  process.env.LCOD_HOME = runtimeRoot;
}
if (!process.env.SPEC_REPO_PATH) {
  process.env.SPEC_REPO_PATH = runtimeRoot;
}
if (!process.env.LCOD_SPEC_PATH) {
  process.env.LCOD_SPEC_PATH = runtimeRoot;
}

const composeUrl = pathToFileURL(path.join(__dirname, 'run-compose.mjs')); // same directory
await import(composeUrl.href);
