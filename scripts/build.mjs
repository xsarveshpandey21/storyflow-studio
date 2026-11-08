import path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

console.log('⚡ Bundling StoryFlow Studio modules into js/bundle.js...');

await esbuild.build({
  entryPoints: [path.join(projectRoot, 'js', 'app.js')],
  bundle: true,
  outfile: path.join(projectRoot, 'js', 'bundle.js'),
  format: 'iife',
  target: ['es2020', 'chrome88', 'edge88'],
  sourcemap: false
});

console.log('✅ Bundle successfully updated: js/bundle.js');
