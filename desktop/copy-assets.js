/*
 * copy-assets.js — copy the web UI (repo root) into ./app so electron-builder
 * can package it self-contained. Run by `npm run dist`. Dev (`npm start`) reads
 * the repo root directly and doesn't need this.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dest = path.join(__dirname, 'app');
const items = ['index.html', 'favicon.svg', 'css', 'js'];

function copy(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copy(path.join(src, name), path.join(dst, name));
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

fs.rmSync(dest, { recursive: true, force: true });
for (const item of items) {
  const src = path.join(root, item);
  if (fs.existsSync(src)) copy(src, path.join(dest, item));
}
console.log('Copied web assets to', dest);
