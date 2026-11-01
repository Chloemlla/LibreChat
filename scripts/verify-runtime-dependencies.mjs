import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));

function commonJsFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return commonJsFiles(path);
    return entry.isFile() && entry.name.endsWith('.cjs') ? [path] : [];
  });
}

/** Ignore quoted examples and comments; only literal CommonJS calls name dependencies. */
function literalRequires(source) {
  const specifiers = new Set();
  for (let index = 0; index < source.length; index++) {
    const quote = source[index];
    if (quote === '"' || quote === "'" || quote === '`') {
      while (++index < source.length) {
        if (source[index] === '\\') index++;
        else if (source[index] === quote) break;
      }
      continue;
    }
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (!source.startsWith('require', index) || /[\w$.]/.test(source[index - 1] ?? '')) continue;
    const match = source.slice(index).match(/^require\s*\(\s*(['"])([^'"\\]+)\1\s*\)/);
    if (match) specifiers.add(match[2]);
  }
  return specifiers;
}

const workspaces = ['api', 'data-schemas', 'data-provider'];
const unresolved = [];
let files = 0;
let specifiers = 0;
for (const workspace of workspaces) {
  const outputs = commonJsFiles(join(projectRoot, 'packages', workspace, 'dist'));
  if (outputs.length === 0) throw new Error('No CommonJS build output for ' + workspace);
  for (const path of outputs) {
    files++;
    const require = createRequire(path);
    for (const specifier of literalRequires(readFileSync(path, 'utf8'))) {
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:') || builtins.has(specifier)) continue;
      specifiers++;
      try {
        require.resolve(specifier);
      } catch {
        unresolved.push({ file: relative(projectRoot, path), specifier });
      }
    }
  }
}
console.log(JSON.stringify({ files, specifiers, unresolved }, null, 2));
if (unresolved.length > 0) process.exitCode = 1;
