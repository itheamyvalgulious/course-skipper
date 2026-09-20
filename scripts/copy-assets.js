const fs = require('fs');
const path = require('path');

function copyRecursive(srcDir, destDir) {
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      // Copy non-ts files (HTML, CSS, JSON, media)
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

const srcDir = path.join(__dirname, '..', 'src');
const distDir = path.join(__dirname, '..', 'dist');

copyRecursive(srcDir, distDir);
console.log('Assets copied from src to dist successfully.');
