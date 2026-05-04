import 'dotenv/config';
import path from 'path';
import { createServer } from './server';
import { ServiceConfig } from './types';

// ─────────────────────────────────────────────────────────────
//  Load config from environment (with defaults)
// ─────────────────────────────────────────────────────────────
const config: ServiceConfig = {
  port:             parseInt(process.env.PORT ?? '3100', 10),
  host:             process.env.HOST ?? '0.0.0.0',
  maxFileSizeBytes: parseInt(process.env.MAX_FILE_SIZE_MB ?? '50', 10) * 1024 * 1024,
  outputDir:        path.resolve(process.env.OUTPUT_DIR ?? './output'),
  tesseractLang:    process.env.TESSERACT_LANG ?? 'eng',
  logLevel:         process.env.LOG_LEVEL ?? 'info',
  lmstudioUrl:      (process.env.LMSTUDIO_URL   ?? 'http://127.0.0.1:1234/v1').replace(/\/+$/, ''),
  lmstudioModel:    process.env.LMSTUDIO_MODEL  ?? 'gemma-4-e2b-it:2',
  classifyPromptFile: process.env.CLASSIFY_PROMPT_FILE
    ? path.resolve(process.env.CLASSIFY_PROMPT_FILE)
    : '',
};

// ─────────────────────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────────────────────
const app = createServer(config);

const server = app.listen(config.port, config.host, () => {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    msg: '🚀 doc-extractor-service started',
    host: config.host,
    port: config.port,
    outputDir: config.outputDir,
    maxFileSizeMb: config.maxFileSizeBytes / 1024 / 1024,
    tesseractLang: config.tesseractLang,
    lmstudioUrl:         config.lmstudioUrl,
    lmstudioModel:       config.lmstudioModel,
    classifyPromptFile:  config.classifyPromptFile || '(auto-discover)',
    endpoints: {
      health:              `GET  http://localhost:${config.port}/health`,
      extract:             `POST http://localhost:${config.port}/extract`,
      extractBatch:        `POST http://localhost:${config.port}/extract/batch`,
      outputs:             `GET  http://localhost:${config.port}/outputs`,
      llmHealth:           `GET  http://localhost:${config.port}/llm/health`,
      llmModels:           `GET  http://localhost:${config.port}/llm/models`,
      llmClassify:         `POST http://localhost:${config.port}/llm/classify`,
      llmClassifySse:      `POST http://localhost:${config.port}/llm/classify/stream`,
      llmReloadPrompt:     `POST http://localhost:${config.port}/llm/reload-prompt`,
    },
  }));
});

// ─────────────────────────────────────────────────────────────
//  Graceful shutdown
// ─────────────────────────────────────────────────────────────
const shutdown = (signal: string) => {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    msg: `${signal} received — shutting down`,
  }));
  server.close(() => {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      msg: 'server closed',
    }));
    process.exit(0);
  });
};

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;
