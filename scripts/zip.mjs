import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const animRoot = path.resolve(projectRoot, '..');

const zipInProject = path.join(projectRoot, 'storyflow-studio.zip');
const zip1 = path.join(animRoot, 'storyflow-studio.zip');
const zip2 = path.join(animRoot, 'deploy.zip');

if (fs.existsSync(zipInProject)) fs.unlinkSync(zipInProject);
if (fs.existsSync(zip1)) fs.unlinkSync(zip1);
if (fs.existsSync(zip2)) fs.unlinkSync(zip2);

const psCommand = `$items = Get-ChildItem -Path '${projectRoot}' | Where-Object { $_.Name -ne 'node_modules' -and $_.Extension -ne '.zip' -and $_.Name -ne '.git' -and $_.Name -ne '.env' -and $_.Name -ne '.env.local' }; Compress-Archive -Path $items.FullName -DestinationPath '${zipInProject}' -Force; Copy-Item '${zipInProject}' '${zip1}' -Force; Copy-Item '${zipInProject}' '${zip2}' -Force`;

execSync(`powershell -NoProfile -Command "${psCommand}"`, { stdio: 'inherit' });
console.log('✅ Updated zip archives:');
console.log('  👉 ' + zipInProject);
console.log('  👉 ' + zip1);
console.log('  👉 ' + zip2);

