const fs = require('fs');
const path = require('path');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const pathTxt = path.join(electronDir, 'path.txt');
const distDir = path.join(electronDir, 'dist');
const isWin = process.platform === 'win32';
const targetBinName = isWin ? 'electron.exe' : 'electron';
const electronBin = path.join(distDir, targetBinName);

if (fs.existsSync(electronBin)) {
  fs.writeFileSync(pathTxt, targetBinName, 'utf-8');
}
