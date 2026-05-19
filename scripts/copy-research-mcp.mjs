import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const sourceFile = path.join(rootDir, 'src', 'subagents', 'research_mcp.js');
const targetDir = path.join(rootDir, 'dist');
const targetFile = path.join(targetDir, 'research_mcp.js');

if (!existsSync(sourceFile)) {
  throw new Error(`Missing source MCP runtime: ${sourceFile}`);
}

mkdirSync(targetDir, { recursive: true });
copyFileSync(sourceFile, targetFile);
