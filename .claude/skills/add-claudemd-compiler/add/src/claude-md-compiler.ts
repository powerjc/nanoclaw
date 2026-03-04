import fs from 'fs';
import path from 'path';

/**
 * Expand @-imports in a CLAUDE.md file recursively.
 * Lines matching ^@(.+)$ are replaced with the compiled content of the referenced file.
 * Circular imports are detected and skipped with a warning comment.
 */
export function compileClaudeMd(
  filePath: string,
  visited = new Set<string>(),
): string {
  if (!fs.existsSync(filePath)) return '';
  const resolved = path.resolve(filePath);
  if (visited.has(resolved)) return `<!-- @import circular: ${filePath} -->`;
  visited.add(resolved);
  const content = fs.readFileSync(resolved, 'utf-8');
  const dir = path.dirname(resolved);
  return content
    .split('\n')
    .map((line) => {
      const match = line.match(/^@(.+)$/);
      if (match) {
        const importPath = path.resolve(dir, match[1].trim());
        if (!fs.existsSync(importPath))
          return `<!-- @import not found: ${match[1].trim()} -->`;
        return compileClaudeMd(importPath, visited);
      }
      return line;
    })
    .join('\n');
}
