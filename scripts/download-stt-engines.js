/**
 * scripts/download-stt-engines.js
 *
 * Downloads and extracts precompiled local CPU STT (Whisper.cpp) and
 * Diarization (Sherpa-onnx) binaries and model weights for Skipper.
 *
 * Usage:
 *   node scripts/download-stt-engines.js [--skip-large]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const RESOURCES_DIR = path.join(PROJECT_ROOT, 'resources');
const BIN_DIR = path.join(RESOURCES_DIR, 'bin');
const MODELS_DIR = path.join(RESOURCES_DIR, 'models');
const CACHE_DIR = path.join(RESOURCES_DIR, '.cache');

const WHISPER_BIN_DIR = path.join(BIN_DIR, 'whisper');
const SHERPA_BIN_DIR = path.join(BIN_DIR, 'sherpa');
const WHISPER_MODELS_DIR = path.join(MODELS_DIR, 'whisper');
const SHERPA_MODELS_DIR = path.join(MODELS_DIR, 'sherpa');
const FUNASR_MODELS_DIR = path.join(MODELS_DIR, 'funasr-nano');
const SILERO_VAD_DIR = path.join(MODELS_DIR, 'silero-vad');

// Platform detection
const isWin = process.platform === 'win32';
const exeExt = isWin ? '.exe' : '';

// CLI Flags
const args = process.argv.slice(2);
const SKIP_LARGE = args.includes('--skip-large');
const FUNASR_ONLY = args.includes('--funasr-only');
const VAD_ONLY = args.includes('--vad-only');
const SKIP_FUNASR = args.includes('--skip-funasr');
const BIN_ONLY = args.includes('--bin-only');

// Ensure base directories exist
for (const dir of [
  RESOURCES_DIR,
  BIN_DIR,
  MODELS_DIR,
  CACHE_DIR,
  WHISPER_BIN_DIR,
  SHERPA_BIN_DIR,
  WHISPER_MODELS_DIR,
  SHERPA_MODELS_DIR,
  FUNASR_MODELS_DIR,
  SILERO_VAD_DIR,
]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Format bytes into human readable string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Robust file downloader using curl if available, otherwise Node.js native fetch.
 * Supports multiple URL mirrors with automatic fallback.
 */
async function downloadFile(urls, destPath, expectedMinBytes = 0) {
  const urlList = Array.isArray(urls) ? urls : [urls];
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  if (fs.existsSync(destPath)) {
    const stat = fs.statSync(destPath);
    if (stat.size >= expectedMinBytes && expectedMinBytes > 0) {
      console.log(`[SKIP] Already exists: ${path.relative(PROJECT_ROOT, destPath)} (${formatBytes(stat.size)})`);
      return;
    }
  }

  let lastError = null;
  for (let i = 0; i < urlList.length; i++) {
    const url = urlList[i];
    try {
      console.log(`[DOWNLOAD] Fetching (source ${i + 1}/${urlList.length}): ${url}`);
      console.log(`       To: ${path.relative(PROJECT_ROOT, destPath)}`);

      let curlAvailable = false;
      try {
        const test = spawnSync('curl', ['--version'], { stdio: 'ignore' });
        if (test.status === 0) curlAvailable = true;
      } catch {}

      if (curlAvailable) {
        // Use curl with follow redirects, retry, and resume
        const curlArgs = [
          '-fSL',
          '--retry', '3',
          '--retry-delay', '2',
          '-C', '-', // Resume if partially downloaded
          url,
          '-o', destPath,
        ];
        const res = spawnSync('curl', curlArgs, { stdio: 'inherit' });
        if (res.status !== 0) {
          throw new Error(`curl failed with exit code ${res.status} for ${url}`);
        }
      } else {
        // Fallback to native Node.js fetch with streaming
        const response = await fetch(url, { redirect: 'follow' });
        if (!response.ok) {
          throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
        }
        const fileStream = fs.createWriteStream(destPath);
        const reader = response.body.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fileStream.write(Buffer.from(value));
        }
        await new Promise((resolve, reject) => {
          fileStream.end(resolve);
          fileStream.on('error', reject);
        });
      }

      const finalStat = fs.statSync(destPath);
      console.log(`[DOWNLOAD COMPLETE] ${path.relative(PROJECT_ROOT, destPath)} (${formatBytes(finalStat.size)})`);
      if (expectedMinBytes > 0 && finalStat.size < expectedMinBytes) {
        throw new Error(`Downloaded file size ${finalStat.size} is smaller than expected minimum ${expectedMinBytes}`);
      }
      return;
    } catch (err) {
      console.warn(`[WARN] Download from ${url} failed: ${err.message}`);
      lastError = err;
    }
  }
  throw lastError || new Error(`Failed to download from all provided sources for ${destPath}`);
}

/**
 * Extract an archive using Windows built-in tar.exe
 */
function extractArchive(archivePath, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  console.log(`[EXTRACT] ${path.relative(PROJECT_ROOT, archivePath)} -> ${path.relative(PROJECT_ROOT, targetDir)}`);
  const res = spawnSync('tar', ['-xf', archivePath, '-C', targetDir], { stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`tar extraction failed with exit code ${res.status}`);
  }
}

/**
 * Recursively copy a directory's contents
 */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Recursively find a file by name
 */
function findFileRecursive(dir, fileName) {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileRecursive(fullPath, fileName);
      if (found) return found;
    } else if (entry.name.toLowerCase() === fileName.toLowerCase()) {
      return fullPath;
    }
  }
  return null;
}

async function downloadFunAsrModel() {
  const funasrEncoder = findFileRecursive(FUNASR_MODELS_DIR, 'encoder_adaptor.int8.onnx') ||
    findFileRecursive(FUNASR_MODELS_DIR, 'encoder_adaptor.onnx');
  const funasrLlm = findFileRecursive(FUNASR_MODELS_DIR, 'llm.int8.onnx') ||
    findFileRecursive(FUNASR_MODELS_DIR, 'llm.onnx');

  if (funasrEncoder && funasrLlm && fs.statSync(funasrLlm).size > 100 * 1024 * 1024) {
    console.log(`[SKIP] Fun-ASR-Nano model already installed: ${FUNASR_MODELS_DIR}\n`);
    return;
  }

  console.log('[FUNASR] Downloading Fun-ASR-Nano INT8 model package (~716MB)...');
  const funasrTarUrls = [
    'https://modelscope.cn/models/csukuangfj/asr-models/resolve/master/sherpa-onnx-funasr-nano-int8-2025-12-30.tar.bz2',
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-funasr-nano-int8-2025-12-30.tar.bz2',
  ];
  const funasrTarPath = path.join(CACHE_DIR, 'sherpa-onnx-funasr-nano-int8-2025-12-30.tar.bz2');
  await downloadFile(funasrTarUrls, funasrTarPath, 500 * 1024 * 1024);

  console.log('[EXTRACT] Extracting Fun-ASR-Nano model archive...');
  extractArchive(funasrTarPath, FUNASR_MODELS_DIR);

  // Flatten subdirectory if created by tar extraction
  const subFolder = path.join(FUNASR_MODELS_DIR, 'sherpa-onnx-funasr-nano-int8-2025-12-30');
  if (fs.existsSync(subFolder)) {
    const items = fs.readdirSync(subFolder);
    for (const item of items) {
      const srcPath = path.join(subFolder, item);
      const dstPath = path.join(FUNASR_MODELS_DIR, item);
      if (!fs.existsSync(dstPath)) {
        fs.renameSync(srcPath, dstPath);
      }
    }
    try { fs.rmdirSync(subFolder); } catch {}
  }
  console.log(`[SUCCESS] Fun-ASR-Nano model installed to: ${FUNASR_MODELS_DIR}\n`);
}

async function downloadSileroVadModel() {
  const sileroVadPath = path.join(SILERO_VAD_DIR, 'silero_vad.onnx');
  if (fs.existsSync(sileroVadPath) && fs.statSync(sileroVadPath).size > 500 * 1024) {
    console.log(`[SKIP] Silero-VAD model already installed: ${sileroVadPath}\n`);
    return sileroVadPath;
  }
  console.log('[DOWNLOAD] Downloading Silero-VAD neural model (~628KB)...');
  const urls = [
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    'https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx',
  ];
  await downloadFile(urls, sileroVadPath, 500 * 1024);
  console.log(`[SUCCESS] Silero-VAD model installed to: ${sileroVadPath}\n`);
  return sileroVadPath;
}

async function downloadWhisperBinary() {
  const whisperCliExe = path.join(WHISPER_BIN_DIR, `whisper-cli${exeExt}`);
  if (fs.existsSync(whisperCliExe)) {
    console.log(`[SKIP] Whisper binary already installed: ${whisperCliExe}`);
    return whisperCliExe;
  }
  console.log(`Downloading Whisper.cpp ${isWin ? 'Windows x64' : 'Linux x64'} binary...`);
  const whisperArchiveName = isWin ? 'whisper-bin-x64.zip' : 'whisper-bin-ubuntu-x64.tar.gz';
  const whisperZipUrl = `https://github.com/ggml-org/whisper.cpp/releases/download/b5130/${whisperArchiveName}`;
  const whisperZipPath = path.join(CACHE_DIR, whisperArchiveName);
  await downloadFile(whisperZipUrl, whisperZipPath, 5 * 1024 * 1024);

  const tempExtractDir = path.join(CACHE_DIR, 'whisper-extract-temp');
  if (fs.existsSync(tempExtractDir)) {
    fs.rmSync(tempExtractDir, { recursive: true, force: true });
  }
  extractArchive(whisperZipPath, tempExtractDir);

  const targetCliName = `whisper-cli${exeExt}`;
  const foundExe = findFileRecursive(tempExtractDir, targetCliName);
  if (!foundExe) {
    throw new Error(`${targetCliName} not found in extracted whisper.cpp archive!`);
  }
  const exeDir = path.dirname(foundExe);
  const files = fs.readdirSync(exeDir);
  for (const f of files) {
    const srcFile = path.join(exeDir, f);
    const destFile = path.join(WHISPER_BIN_DIR, f);
    if (fs.statSync(srcFile).isFile()) {
      fs.copyFileSync(srcFile, destFile);
      if (!isWin) {
        try { fs.chmodSync(destFile, 0o755); } catch {}
      }
    }
  }
  fs.rmSync(tempExtractDir, { recursive: true, force: true });
  console.log(`[SUCCESS] Whisper.cpp installed to: ${WHISPER_BIN_DIR}\n`);
  return whisperCliExe;
}

async function downloadSherpaBinary() {
  const sherpaDiarizationExe = path.join(SHERPA_BIN_DIR, `sherpa-onnx-offline-speaker-diarization${exeExt}`);
  if (fs.existsSync(sherpaDiarizationExe)) {
    console.log(`[SKIP] Sherpa diarization binary already installed: ${sherpaDiarizationExe}`);
    return sherpaDiarizationExe;
  }
  console.log(`Downloading Sherpa-onnx static Release binary archive (${isWin ? 'Windows x64' : 'Linux x64'})...`);
  const sherpaTarName = isWin
    ? 'sherpa-onnx-v1.13.8-win-x64-static-MT-Release.tar.bz2'
    : 'sherpa-onnx-v1.13.8-linux-x64-static.tar.bz2';
  const sherpaTarUrl = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/${sherpaTarName}`;
  const sherpaTarPath = path.join(CACHE_DIR, sherpaTarName);
  await downloadFile(sherpaTarUrl, sherpaTarPath, 150 * 1024 * 1024);

  const tempSherpaExtractDir = path.join(CACHE_DIR, 'sherpa-extract-temp');
  if (fs.existsSync(tempSherpaExtractDir)) {
    fs.rmSync(tempSherpaExtractDir, { recursive: true, force: true });
  }
  extractArchive(sherpaTarPath, tempSherpaExtractDir);

  const targetDiarizeName = `sherpa-onnx-offline-speaker-diarization${exeExt}`;
  const foundDiarize = findFileRecursive(tempSherpaExtractDir, targetDiarizeName);
  if (!foundDiarize) {
    throw new Error(`${targetDiarizeName} not found in extracted sherpa-onnx archive!`);
  }
  const sherpaExeDir = path.dirname(foundDiarize);
  const sherpaFiles = fs.readdirSync(sherpaExeDir);
  for (const f of sherpaFiles) {
    const srcFile = path.join(sherpaExeDir, f);
    const destFile = path.join(SHERPA_BIN_DIR, f);
    if (fs.statSync(srcFile).isFile()) {
      fs.copyFileSync(srcFile, destFile);
      if (!isWin) {
        try { fs.chmodSync(destFile, 0o755); } catch {}
      }
    }
  }
  fs.rmSync(tempSherpaExtractDir, { recursive: true, force: true });
  console.log(`[SUCCESS] Sherpa-onnx installed to: ${SHERPA_BIN_DIR}\n`);
  return sherpaDiarizationExe;
}

function verifyBinaries() {
  console.log('====================================================');
  console.log('  Verifying Executables');
  console.log('====================================================\n');
  const whisperCliExe = path.join(WHISPER_BIN_DIR, `whisper-cli${exeExt}`);
  const sherpaDiarizationExe = path.join(SHERPA_BIN_DIR, `sherpa-onnx-offline-speaker-diarization${exeExt}`);
  const sherpaOfflineExe = path.join(SHERPA_BIN_DIR, `sherpa-onnx-offline${exeExt}`);
  const sherpaVadExe = path.join(SHERPA_BIN_DIR, `sherpa-onnx-vad${exeExt}`);

  if (fs.existsSync(whisperCliExe)) {
    console.log(`Testing: ${whisperCliExe} --help`);
    const t = spawnSync(whisperCliExe, ['--help'], { encoding: 'utf-8' });
    const out = (t.stdout || '') + (t.stderr || '');
    if (t.status === 0 || out.includes('usage:') || out.includes('-m FNAME') || out.includes('whisper-cli')) {
      console.log('  -> Whisper CLI execution test: PASSED');
    }
  }

  if (fs.existsSync(sherpaDiarizationExe)) {
    console.log(`Testing: ${sherpaDiarizationExe} --help`);
    const t = spawnSync(sherpaDiarizationExe, ['--help'], { encoding: 'utf-8' });
    const out = (t.stdout || '') + (t.stderr || '');
    if (t.status === 0 || out.includes('--segmentation-model') || out.includes('Usage:')) {
      console.log('  -> Sherpa Diarization execution test: PASSED');
    }
  }

  if (fs.existsSync(sherpaOfflineExe)) {
    console.log(`Testing: ${sherpaOfflineExe} --help`);
    const t = spawnSync(sherpaOfflineExe, ['--help'], { encoding: 'utf-8' });
    const out = (t.stdout || '') + (t.stderr || '');
    if (out.includes('--funasr-nano-encoder-adaptor') || t.status === 0) {
      console.log('  -> Sherpa Offline execution test: PASSED');
    }
  }

  if (fs.existsSync(sherpaVadExe)) {
    console.log(`Testing: ${sherpaVadExe} --help`);
    const t = spawnSync(sherpaVadExe, ['--help'], { encoding: 'utf-8' });
    const out = (t.stdout || '') + (t.stderr || '');
    if (out.includes('--silero-vad-model') || t.status === 0) {
      console.log('  -> Sherpa VAD execution test: PASSED');
    }
  }
}

async function main() {
  console.log('====================================================');
  console.log('  Skipper STT & Diarization Engine / Model Downloader');
  console.log('====================================================\n');

  if (BIN_ONLY) {
    console.log('Mode: --bin-only (Downloading and verifying native engine binaries)\n');
    await downloadWhisperBinary();
    await downloadSherpaBinary();
    verifyBinaries();
    return;
  }

  if (VAD_ONLY) {
    console.log('Mode: --vad-only (Downloading Silero-VAD model)\n');
    await downloadSileroVadModel();

    const vadExe = path.join(SHERPA_BIN_DIR, `sherpa-onnx-vad${exeExt}`);
    if (fs.existsSync(vadExe)) {
      console.log(`Testing: ${vadExe} --help`);
      const vadTest = spawnSync(vadExe, ['--help'], { encoding: 'utf-8' });
      const vadOut = (vadTest.stdout || '') + (vadTest.stderr || '');
      if (vadOut.includes('--silero-vad-model')) {
        console.log('  -> Sherpa-onnx VAD native engine support: PASSED\n');
      }
    }
    return;
  }

  if (FUNASR_ONLY) {
    console.log('Mode: --funasr-only (Downloading Fun-ASR-Nano & Silero-VAD models)\n');
    await downloadSileroVadModel();
    await downloadFunAsrModel();

    const sherpaOfflineExe = path.join(SHERPA_BIN_DIR, `sherpa-onnx-offline${exeExt}`);
    if (fs.existsSync(sherpaOfflineExe)) {
      console.log(`\nTesting: ${sherpaOfflineExe} --help (for Fun-ASR-Nano support)`);
      const sherpaOfflineTest = spawnSync(sherpaOfflineExe, ['--help'], { encoding: 'utf-8' });
      const sherpaOfflineOutput = (sherpaOfflineTest.stdout || '') + (sherpaOfflineTest.stderr || '');
      if (sherpaOfflineOutput.includes('--funasr-nano-encoder-adaptor')) {
        console.log('  -> Sherpa-onnx Fun-ASR-Nano native engine support: PASSED\n');
      }
    }

    const resolvedEncoder = findFileRecursive(FUNASR_MODELS_DIR, 'encoder_adaptor.int8.onnx') ||
      findFileRecursive(FUNASR_MODELS_DIR, 'encoder_adaptor.onnx');
    if (resolvedEncoder) {
      console.log(`Fun-ASR-Nano Model:  ${FUNASR_MODELS_DIR} (Encoder: ${formatBytes(fs.statSync(resolvedEncoder).size)})\n`);
    }
    return;
  }

  // ----------------------------------------------------
  // 1. Whisper.cpp Binary
  // ----------------------------------------------------
  console.log('[STEP 1/7] Whisper.cpp Binary');
  const whisperCliExe = await downloadWhisperBinary();

  // ----------------------------------------------------
  // 2. Whisper Small Model (ggml-small.bin)
  // ----------------------------------------------------
  const whisperSmallPath = path.join(WHISPER_MODELS_DIR, 'ggml-small.bin');
  console.log('[STEP 2/7] Checking Whisper Small model (ggml-small.bin)...');
  await downloadFile(
    'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    whisperSmallPath,
    450 * 1024 * 1024
  );
  console.log();

  // ----------------------------------------------------
  // 3. Whisper Medium Model (ggml-medium.bin)
  // ----------------------------------------------------
  const whisperMediumPath = path.join(WHISPER_MODELS_DIR, 'ggml-medium.bin');
  if (SKIP_LARGE) {
    console.log('[STEP 3/7] [SKIPPED (--skip-large)] Whisper Medium model (ggml-medium.bin)\n');
  } else {
    console.log('[STEP 3/7] Checking Whisper Medium model (ggml-medium.bin)...');
    await downloadFile(
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
      whisperMediumPath,
      1400 * 1024 * 1024
    );
    console.log();
  }

  // ----------------------------------------------------
  // 4. Sherpa-onnx Diarization Binary
  // ----------------------------------------------------
  console.log('[STEP 4/7] Sherpa-onnx Diarization Binary');
  const sherpaDiarizationExe = await downloadSherpaBinary();

  // ----------------------------------------------------
  // 5. Sherpa Pyannote Segmentation Model
  // ----------------------------------------------------
  const pyannoteDir = path.join(SHERPA_MODELS_DIR, 'sherpa-onnx-pyannote-segmentation-3-0');
  const pyannoteModel = path.join(pyannoteDir, 'model.onnx');
  if (fs.existsSync(pyannoteModel) && fs.statSync(pyannoteModel).size > 5 * 1024 * 1024) {
    console.log(`[SKIP] Sherpa segmentation model already installed: ${pyannoteModel}`);
  } else {
    console.log('[STEP 5/7] Downloading Sherpa pyannote segmentation model...');
    const segUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2';
    const segTarPath = path.join(CACHE_DIR, 'sherpa-onnx-pyannote-segmentation-3-0.tar.bz2');
    await downloadFile(segUrl, segTarPath, 5 * 1024 * 1024);

    extractArchive(segTarPath, SHERPA_MODELS_DIR);
    if (!fs.existsSync(pyannoteModel)) {
      throw new Error(`Extraction finished but ${pyannoteModel} does not exist!`);
    }
    console.log(`[SUCCESS] Pyannote segmentation model ready at: ${pyannoteDir}\n`);
  }

  // ----------------------------------------------------
  // 6. Sherpa Embedding Model: 3dspeaker campplus (Standard)
  // ----------------------------------------------------
  const campplusPath = path.join(SHERPA_MODELS_DIR, '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx');
  console.log('[STEP 6/7] Checking Sherpa campplus embedding model...');
  await downloadFile(
    'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
    campplusPath,
    25 * 1024 * 1024
  );
  console.log();

  // ----------------------------------------------------
  // 7. Sherpa Embedding Model: 3dspeaker eres2netv2 (Large)
  // ----------------------------------------------------
  const eres2netPath = path.join(SHERPA_MODELS_DIR, '3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx');
  if (SKIP_LARGE) {
    console.log('[STEP 7/7] [SKIPPED (--skip-large)] Sherpa eres2netv2 embedding model\n');
  } else {
    console.log('[STEP 7/7] Checking Sherpa eres2netv2 embedding model...');
    await downloadFile(
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx',
      eres2netPath,
      65 * 1024 * 1024
    );
    console.log();
  }

  // ----------------------------------------------------
  // 8. Fun-ASR-Nano INT8 Model (for Fun-ASR-Nano STT backend)
  // ----------------------------------------------------
  const funasrEncoder = findFileRecursive(FUNASR_MODELS_DIR, 'encoder_adaptor.int8.onnx') ||
    findFileRecursive(FUNASR_MODELS_DIR, 'encoder_adaptor.onnx');
  const funasrLlm = findFileRecursive(FUNASR_MODELS_DIR, 'llm.int8.onnx') ||
    findFileRecursive(FUNASR_MODELS_DIR, 'llm.onnx');

  if (funasrEncoder && funasrLlm && fs.statSync(funasrLlm).size > 100 * 1024 * 1024) {
    console.log(`[SKIP] Fun-ASR-Nano model already installed: ${FUNASR_MODELS_DIR}\n`);
  } else if (!SKIP_FUNASR || FUNASR_ONLY) {
    console.log('[STEP 8/8] Downloading Fun-ASR-Nano INT8 model package (~716MB)...');
    const funasrTarUrls = [
      'https://modelscope.cn/models/csukuangfj/asr-models/resolve/master/sherpa-onnx-funasr-nano-int8-2025-12-30.tar.bz2',
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-funasr-nano-int8-2025-12-30.tar.bz2',
    ];
    const funasrTarPath = path.join(CACHE_DIR, 'sherpa-onnx-funasr-nano-int8-2025-12-30.tar.bz2');
    await downloadFile(funasrTarUrls, funasrTarPath, 500 * 1024 * 1024);

    console.log('[EXTRACT] Extracting Fun-ASR-Nano model archive...');
    extractArchive(funasrTarPath, FUNASR_MODELS_DIR);

    // Flatten subdirectory if created by tar extraction
    const subFolder = path.join(FUNASR_MODELS_DIR, 'sherpa-onnx-funasr-nano-int8-2025-12-30');
    if (fs.existsSync(subFolder)) {
      const items = fs.readdirSync(subFolder);
      for (const item of items) {
        const srcPath = path.join(subFolder, item);
        const dstPath = path.join(FUNASR_MODELS_DIR, item);
        if (!fs.existsSync(dstPath)) {
          fs.renameSync(srcPath, dstPath);
        }
      }
      try { fs.rmdirSync(subFolder); } catch {}
    }
    console.log(`[SUCCESS] Fun-ASR-Nano model installed to: ${FUNASR_MODELS_DIR}\n`);
  }

  // ----------------------------------------------------
  // 9. Silero-VAD Model (for voice activity detection)
  // ----------------------------------------------------
  await downloadSileroVadModel();

  // ----------------------------------------------------
  // Verification: Test running --help on executables
  // ----------------------------------------------------
  console.log('====================================================');
  console.log('  Verifying Executables & Models');
  console.log('====================================================\n');

  console.log(`Testing: ${whisperCliExe} --help`);
  const whisperTest = spawnSync(whisperCliExe, ['--help'], { encoding: 'utf-8' });
  const whisperOutput = (whisperTest.stdout || '') + (whisperTest.stderr || '');
  if (whisperTest.status === 0 || whisperOutput.includes('usage:') || whisperOutput.includes('-m FNAME') || whisperOutput.includes('whisper-cli')) {
    console.log('  -> Whisper CLI execution test: PASSED');
    const firstLine = whisperOutput.trim().split('\n')[0];
    console.log(`     Output snippet: ${firstLine}`);
  } else {
    console.error('  -> Whisper CLI execution test FAILED with output:');
    console.error(whisperOutput);
    throw new Error('Whisper CLI test failed');
  }

  console.log(`\nTesting: ${sherpaDiarizationExe} --help`);
  const sherpaTest = spawnSync(sherpaDiarizationExe, ['--help'], { encoding: 'utf-8' });
  const sherpaOutput = (sherpaTest.stdout || '') + (sherpaTest.stderr || '');
  if (sherpaTest.status === 0 || sherpaOutput.includes('--segmentation-model') || sherpaOutput.includes('--embedding-model') || sherpaOutput.includes('Usage:')) {
    console.log('  -> Sherpa Diarization execution test: PASSED');
    const lines = sherpaOutput.trim().split('\n').slice(0, 3).join('\n     ');
    console.log(`     Output snippet: ${lines}`);
  } else {
    console.error('  -> Sherpa Diarization test FAILED with output:');
    console.error(sherpaOutput);
    throw new Error('Sherpa Diarization test failed');
  }

  const sherpaOfflineExe = path.join(SHERPA_BIN_DIR, `sherpa-onnx-offline${exeExt}`);
  if (fs.existsSync(sherpaOfflineExe)) {
    console.log(`\nTesting: ${sherpaOfflineExe} --help (for Fun-ASR-Nano support)`);
    const sherpaOfflineTest = spawnSync(sherpaOfflineExe, ['--help'], { encoding: 'utf-8' });
    const sherpaOfflineOutput = (sherpaOfflineTest.stdout || '') + (sherpaOfflineTest.stderr || '');
    if (sherpaOfflineOutput.includes('--funasr-nano-encoder-adaptor')) {
      console.log('  -> Sherpa-onnx Fun-ASR-Nano native engine support: PASSED');
    } else {
      console.warn('  -> Warning: --funasr-nano-encoder-adaptor not found in sherpa-onnx-offline --help output.');
    }
  }

  console.log('\n====================================================');
  console.log('  All Engines and Models Ready:');
  console.log('====================================================');
  console.log(`Whisper CLI:         ${whisperCliExe} (${formatBytes(fs.statSync(whisperCliExe).size)})`);
  console.log(`Whisper Small Model: ${whisperSmallPath} (${formatBytes(fs.statSync(whisperSmallPath).size)})`);
  if (fs.existsSync(whisperMediumPath)) {
    console.log(`Whisper Medium Model:${whisperMediumPath} (${formatBytes(fs.statSync(whisperMediumPath).size)})`);
  }
  console.log(`Sherpa Diarization:  ${sherpaDiarizationExe} (${formatBytes(fs.statSync(sherpaDiarizationExe).size)})`);
  console.log(`Pyannote Seg Model:  ${pyannoteModel} (${formatBytes(fs.statSync(pyannoteModel).size)})`);
  console.log(`Campplus Model:      ${campplusPath} (${formatBytes(fs.statSync(campplusPath).size)})`);
  if (fs.existsSync(eres2netPath)) {
    console.log(`Eres2NetV2 Model:    ${eres2netPath} (${formatBytes(fs.statSync(eres2netPath).size)})`);
  }
  const resolvedEncoder = findFileRecursive(FUNASR_MODELS_DIR, 'encoder_adaptor.int8.onnx') ||
    findFileRecursive(FUNASR_MODELS_DIR, 'encoder_adaptor.onnx');
  if (resolvedEncoder) {
    console.log(`Fun-ASR-Nano Model:  ${FUNASR_MODELS_DIR} (Encoder: ${formatBytes(fs.statSync(resolvedEncoder).size)})`);
  }
  console.log('====================================================\n');
}

main().catch((err) => {
  console.error('\n[ERROR]', err.message || err);
  process.exit(1);
});
