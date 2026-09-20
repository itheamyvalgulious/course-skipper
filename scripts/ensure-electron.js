const fs = require('fs');
const path = require('path');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const pathTxt = path.join(electronDir, 'path.txt');
const distDir = path.join(electronDir, 'dist');
const electronBin = path.join(distDir, 'electron');

if (fs.existsSync(electronBin)) {
  fs.writeFileSync(pathTxt, 'electron', 'utf-8');
}
