import fs from 'fs';

const html = fs.readFileSync('index.html', 'utf8');
const btnRegex = /<button[^>]+id="([^"]+)"/g;
let m;
const buttons = [];
while ((m = btnRegex.exec(html)) !== null) {
  buttons.push(m[1]);
}

const jsFiles = ['js/app.js', 'js/story_controller.js', 'js/ui.js', 'js/youtube.js', 'js/voice.js'];
const jsContents = jsFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');

const unhandled = [];
buttons.forEach(b => {
  if (!jsContents.includes(b)) {
    unhandled.push(b);
  }
});

console.log(`Total buttons: ${buttons.length}`);
console.log(`Unhandled buttons (${unhandled.length}):`, unhandled);

