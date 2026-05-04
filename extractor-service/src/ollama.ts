// ─────────────────────────────────────────────────────────────
//  DEPRECATED — kept only as a re-export shim.
//
//  The Ollama integration has been removed in favour of LM Studio
//  (OpenAI-compatible /v1 API). All real logic now lives in
//  ./lmstudio.ts. This file exists so any straggling
//  `import { ... } from './ollama'` keeps compiling — delete it
//  whenever you're confident nothing else references it.
// ─────────────────────────────────────────────────────────────

export {
  CategoryInput,
  ClassificationResult,
  LMStudioModelInfo,
  LMStudioHealth,
  buildClassificationPrompt,
  extractJsonObject,
  extractPromptBody,
  loadPromptTemplate,
  clearPromptCache,
  renderPrompt,
  checkLlmHealth as checkOllamaHealth,
  classify,
  streamClassify,
} from './lmstudio';
