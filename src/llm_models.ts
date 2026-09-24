/**
 * The local models the agent can run (#140), pinned to a Hugging Face
 * commit. The page's worker downloads the weights from there once
 * ({@link modelUrl}; the CSP names those hosts, `MODEL_ORIGINS` in csp.ts)
 * and keeps them in Cache Storage under {@link modelCacheKey}, which names
 * the sha256, so a new pin never reads an old model back as cached.
 */
export type LocalModel = {
  id: string;
  label: string;
  file: string;
  commit: string;
  sha256: string;
  bytes: number;
  /** How the pane offers it. */
  choice: string;
  /** Peak memory with the sandbox and Jupyter beside it, renderer plus GPU
   * process, measured on an M4 (docs/superpowers/specs/
   * 2026-09-23-local-agent-feasibility.md), rounded up. */
  memoryGB: number;
};

export const LOCAL_MODELS: LocalModel[] = [
  {
    id: "E4B",
    label: "Gemma 4 E4B",
    file: "gemma-4-E4B-it-web.litertlm",
    commit: "2eee7ac325f20eb8c9ac1d0e972f7c84663062da",
    sha256: "3904d826d5dddd25ea173e85204caec09e68ba038116e9b992b69cbdc94f57a0",
    bytes: 2969059328,
    choice: "Recommended — more reliable",
    memoryGB: 8,
  },
  {
    id: "E2B",
    label: "Gemma 4 E2B",
    file: "gemma-4-E2B-it-web.litertlm",
    commit: "b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1",
    sha256: "3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5",
    bytes: 2008432640,
    choice: "Faster — less reliable",
    memoryGB: 6,
  },
];

/** Where the weights live: a commit-pinned Hugging Face URL, so the bytes
 * behind it cannot change. It answers with a redirect to Hugging Face's CDN,
 * CORS-enabled, which is what lets a COEP `require-corp` page read it. */
export function modelUrl(model: LocalModel): string {
  return `https://huggingface.co/litert-community/gemma-4-${model.id}-it-litert-lm/resolve/${model.commit}/${model.file}`;
}

/** The Cache Storage the worker keeps downloaded models in. */
export const MODEL_CACHE = "yurt-llm";

/** The model's Cache Storage key: on the page's origin, naming the pin. */
export function modelCacheKey(model: LocalModel): string {
  return `/llm/${model.file}?sha256=${model.sha256}`;
}

/** Engine budget: prompt + reply, in tokens. */
export const MAX_NUM_TOKENS = 4096;
