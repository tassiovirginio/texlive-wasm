'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const gunzip = promisify(zlib.gunzip);

function confinedPath(root, name) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
    throw new Error(`Unsafe archive path: ${name}`);
  }
  const output = path.resolve(root, name);
  if (output !== root && !output.startsWith(root + path.sep)) throw new Error(`Archive path escapes destination: ${name}`);
  // Refuse existing symlinks in every component, including the destination
  // root: a lexical containment check cannot detect those redirects.
  let current = path.parse(output).root;
  for (const component of output.slice(current.length).split(path.sep)) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Archive destination contains symlink: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return output;
}
function cstring(block, start, length) {
  const end = block.indexOf(0, start);
  return block.subarray(start, end >= start && end < start + length ? end : start + length).toString('utf8');
}
function octal(block, start, length) {
  const value = cstring(block, start, length).trim();
  if (!/^[0-7]*$/.test(value)) throw new Error('Invalid tar octal field');
  const result = value ? parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(result)) throw new Error('Invalid tar size');
  return result;
}
async function extractTarGz(bytes, destination, {maxBytes = 512 * 1024 * 1024, maxEntries = 250000} = {}) {
  const raw = await gunzip(bytes, { maxOutputLength: maxBytes });
  const root = path.resolve(destination);
  const entries = [];
  const names = new Set();
  let offset = 0;
  let ended = false;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) { ended = true; break; }
    if (entries.length >= maxEntries) throw new Error('Tar entry limit exceeded');
    const expected = octal(header, 148, 8);
    const actual = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (actual !== expected) throw new Error('Invalid tar header checksum');
    const name = cstring(header, 0, 100);
    const prefix = cstring(header, 345, 155);
    const full = prefix ? `${prefix}/${name}` : name;
    const size = octal(header, 124, 12);
    const type = header[156];
    offset += 512;
    if (offset + Math.ceil(size / 512) * 512 > raw.length) throw new Error('Truncated tar entry');
    if (type !== 0 && type !== 48 && type !== 53) throw new Error(`Unsupported tar entry type: ${type}`);
    if (type === 53 && size !== 0) throw new Error('Tar directory has a payload');
    const output = confinedPath(root, full);
    if (names.has(output)) throw new Error(`Duplicate tar entry: ${full}`);
    names.add(output);
    entries.push({output, directory: type === 53, content: raw.subarray(offset, offset + size)});
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended) throw new Error('Truncated tar archive');
  // Validate the complete archive before touching destination files.
  for (const entry of entries) {
    confinedPath(root, path.relative(root, entry.output) || '.');
    if (entry.directory) fs.mkdirSync(entry.output, {recursive: true});
    else {
      fs.mkdirSync(path.dirname(entry.output), {recursive: true});
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0);
      const fd = fs.openSync(entry.output, flags, 0o644);
      try { fs.writeFileSync(fd, entry.content); } finally { fs.closeSync(fd); }
    }
  }
}
module.exports = { extractTarGz, confinedPath };
