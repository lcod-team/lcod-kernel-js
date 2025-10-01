#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'src', 'core');
const distDir = path.join(root, 'packages', 'node-core-axioms', 'dist');

async function cleanDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

async function copyCoreFiles() {
  await cleanDir(distDir);
  const files = await fs.readdir(srcDir);
  await Promise.all(
    files.map(async file => {
      const srcPath = path.join(srcDir, file);
      const destPath = path.join(distDir, file);
      await fs.copyFile(srcPath, destPath);
    })
  );
}

copyCoreFiles().catch(err => {
  console.error('Failed to build core package:', err);
  process.exit(1);
});
