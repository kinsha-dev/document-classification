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
  lmstudioUrl:      (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
  lmstudioModel:    process.env.OPENROUTER_MODEL ?? 'google/gemma-4-26b-a4b-it',
  classifyPromptFile: process.env.CLASSIFY_PROMPT_FILE
    ? path.resolve(process.env.CLASSIFY_PROMPT_FILE)
    : '',
  metadataSchemaFile: process.env.METADATA_SCHEMA_FILE
    ? path.resolve(process.env.METADATA_SCHEMA_FILE)
    : '',
  embeddingModel:   process.env.EMBEDDING_MODEL ?? '',
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
      search:              `POST http://localhost:${config.port}/search`,
      metadataSchema:      `GET  http://localhost:${config.port}/metadata/schema`,
      indexStats:          `GET  http://localhost:${config.port}/index/stats`,
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
  try { app.locals.flushIndex?.(); } catch { /* nothing to flush */ }
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
