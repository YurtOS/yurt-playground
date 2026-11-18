// DIAGNOSTIC ONLY (branch diag/ipad-memdiag, never merged): counts shared
// WebAssembly.Memory objects and Workers per realm, and reports them to the
// page over a BroadcastChannel; the page answers `__memdiag()`.
(() => {
  if (globalThis.__memdiagInstalled) return;
  globalThis.__memdiagInstalled = true;
  const isPage = typeof document !== "undefined";
  const path = self.location ? self.location.pathname : "";
  const kind = isPage
    ? "page"
    : path.includes("coordinator")
    ? "coord"
    : path.includes("worker_bootstrap")
    ? "guest"
    : "other:" + path;
  const id = kind + "-" + Math.random().toString(36).slice(2, 8);
  const s = {
    made: 0,
    live: 0,
    mib: 0,
    maxLiveMib: 0,
    workersMade: 0,
    terminated: 0,
    memErrors: 0,
    lastMemError: "",
  };
  const M = WebAssembly.Memory;
  const fr = new FinalizationRegistry((b) => {
    s.live--;
    s.mib -= b;
  });
  function W(d) {
    let m;
    try {
      m = new M(d);
    } catch (e) {
      s.memErrors++;
      s.lastMemError = String(e) + " max=" + (d && d.maximum);
      throw e;
    }
    if (d && d.shared) {
      const b = (d.maximum || 0) / 16;
      s.made++;
      s.live++;
      s.mib += b;
      s.maxLiveMib = Math.max(s.maxLiveMib, s.mib);
      fr.register(m, b);
    }
    return m;
  }
  W.prototype = M.prototype;
  WebAssembly.Memory = W;
  if (typeof Worker !== "undefined") {
    const OW = Worker;
    const term = OW.prototype.terminate;
    OW.prototype.terminate = function () {
      s.terminated++;
      return term.call(this);
    };
    globalThis.Worker = new Proxy(OW, {
      construct(t, a, nt) {
        s.workersMade++;
        return Reflect.construct(t, a, nt);
      },
    });
  }
  const ch = new BroadcastChannel("memdiag");
  const t0 = Date.now();
  const beat = () =>
    ch.postMessage({ id, kind, at: Date.now(), up: Date.now() - t0, ...s });
  if (isPage) {
    const seen = new Map();
    ch.onmessage = (e) => seen.set(e.data.id, e.data);
    globalThis.__memdiag = () => {
      const now = Date.now();
      const rows = [
        { id, kind, at: now, up: now - t0, ...s },
        ...seen.values(),
      ];
      return rows.map((r) => ({ ...r, ageMs: now - r.at }));
    };
  } else {
    setInterval(beat, 1000);
  }
  beat();
})();

// ../../../../.cache/deno/npm/registry.npmjs.org/@litert-lm/core/0.17.1/dist/global_litertlm.js
var LiteRtLmNotLoadedError = class extends Error {
  constructor() {
    super("LiteRT-LM is not initialized yet. Please call loadLiteRtLm() and wait for its promise to resolve to load the LiteRT-LM WASM module.");
  }
};
var globalLiteRtLm = void 0;
var globalLiteRtLmPromise = void 0;
function getGlobalLiteRtLm() {
  if (!globalLiteRtLm) {
    throw new LiteRtLmNotLoadedError();
  }
  return globalLiteRtLm;
}
function setGlobalLiteRtLm(LiteRtLm2) {
  globalLiteRtLm = LiteRtLm2;
}
function getGlobalLiteRtLmPromise() {
  return globalLiteRtLmPromise;
}
function hasGlobalLiteRtLmPromise() {
  return Boolean(globalLiteRtLmPromise);
}
function setGlobalLiteRtLmPromise(promise) {
  globalLiteRtLmPromise = promise;
}

// ../../../../.cache/deno/npm/registry.npmjs.org/@litert-lm/core/0.17.1/dist/litertlm_web.js
var LiteRtLm = class {
  liteRtLmWasm;
  static DEFAULT_WASM_PATH = "https://cdn.jsdelivr.net/npm/@litert-lm/core@0.17.1/wasm";
  constructor(wasmModule) {
    this.liteRtLmWasm = wasmModule;
    this.liteRtLmWasm.setupLogging();
  }
  async setupDefaultWebGpuDevice() {
    if (this.liteRtLmWasm.preinitializedWebGPUDevice) {
      return;
    }
    this.liteRtLmWasm.preinitializedWebGPUDevice = await createDefaultWebGpuDevice();
  }
  delete() {
  }
};
var DESIRED_WEBGPU_FEATURES = [
  "shader-f16",
  "subgroups"
];
async function createDefaultWebGpuDevice() {
  const adapterDescriptor = {
    powerPreference: "high-performance"
  };
  const adapter = await navigator.gpu.requestAdapter(adapterDescriptor);
  if (!adapter) {
    throw new Error("No GPU adapter found.");
  }
  const requiredLimits = {
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
    maxTextureDimension2D: adapter.limits.maxTextureDimension2D
  };
  const requiredFeatures = [];
  for (const feature of DESIRED_WEBGPU_FEATURES) {
    if (adapter.features.has(feature)) {
      requiredFeatures.push(feature);
    }
  }
  return await adapter.requestDevice({
    requiredFeatures,
    requiredLimits
  });
}

// ../../../../.cache/deno/npm/registry.npmjs.org/@litertjs/wasm-utils/2.6.0/dist/index.js
async function runScript(scriptUrl) {
  if (typeof importScripts === "function") {
    importScripts(scriptUrl.toString());
  } else {
    const script = document.createElement("script");
    script.src = scriptUrl.toString();
    script.crossOrigin = "anonymous";
    return new Promise((resolve, revoke) => {
      script.addEventListener("load", () => {
        resolve();
      }, false);
      script.addEventListener("error", (e) => {
        revoke(e);
      }, false);
      document.body.appendChild(script);
    });
  }
}
var createWasmLib = async (constructorFcn, wasmLoaderScript, assetLoaderScript, glCanvas, fileLocator) => {
  if (wasmLoaderScript) {
    await runScript(wasmLoaderScript);
  }
  if (!self.ModuleFactory) {
    throw new Error("ModuleFactory not set.");
  }
  if (assetLoaderScript) {
    await runScript(assetLoaderScript);
    if (!self.ModuleFactory) {
      throw new Error("ModuleFactory not set.");
    }
  }
  if (self.Module && fileLocator) {
    const moduleFileLocator = self.Module;
    moduleFileLocator.locateFile = fileLocator.locateFile;
    if (fileLocator.mainScriptUrlOrBlob) {
      moduleFileLocator.mainScriptUrlOrBlob = fileLocator.mainScriptUrlOrBlob;
    }
  }
  const module = await self.ModuleFactory(self.Module || fileLocator);
  self.ModuleFactory = self.Module = void 0;
  return new constructorFcn(module, glCanvas);
};

// ../../../../.cache/deno/npm/registry.npmjs.org/@litert-lm/core/0.17.1/dist/url_path_utils.js
function pathToString(path) {
  return path;
}
function appendPathSegment(path, segment) {
  if (!path) return segment;
  if (!segment) return path;
  const pathWithSlash = path.endsWith("/") ? path : path + "/";
  const segmentWithoutSlash = segment.startsWith("/") ? segment.substring(1) : segment;
  return pathWithSlash + segmentWithoutSlash;
}

// ../../../../.cache/deno/npm/registry.npmjs.org/@litert-lm/core/0.17.1/dist/wasm_feature_detect.js
var WASM_RELAXED_SIMD_CHECK = new Uint8Array([
  0,
  97,
  115,
  109,
  1,
  0,
  0,
  0,
  1,
  5,
  1,
  96,
  0,
  1,
  123,
  3,
  2,
  1,
  0,
  10,
  15,
  1,
  13,
  0,
  65,
  1,
  253,
  15,
  65,
  2,
  253,
  15,
  253,
  128,
  2,
  11
]);
var WASM_THREADS_CHECK = new Uint8Array([
  0,
  97,
  115,
  109,
  1,
  0,
  0,
  0,
  1,
  4,
  1,
  96,
  0,
  0,
  3,
  2,
  1,
  0,
  5,
  4,
  1,
  3,
  1,
  1,
  10,
  11,
  1,
  9,
  0,
  65,
  0,
  254,
  16,
  2,
  0,
  26,
  11
]);
var WASM_FEATURE_VALUES = {
  "relaxedSimd": void 0,
  "threads": void 0,
  "jspi": void 0
};
function isJspiSupported() {
  return "Suspending" in WebAssembly;
}
async function tryWasm(wasm) {
  try {
    await WebAssembly.instantiate(wasm);
    return {
      supported: true
    };
  } catch (e) {
    return {
      supported: false,
      error: e
    };
  }
}
var WASM_FEATURE_CHECKS = {
  "relaxedSimd": () => {
    if (WASM_FEATURE_VALUES.relaxedSimd === void 0) {
      WASM_FEATURE_VALUES.relaxedSimd = tryWasm(WASM_RELAXED_SIMD_CHECK);
    }
    return WASM_FEATURE_VALUES.relaxedSimd;
  },
  "threads": () => {
    if (WASM_FEATURE_VALUES.threads === void 0) {
      try {
        if (typeof MessageChannel !== "undefined") {
          new MessageChannel().port1.postMessage(new SharedArrayBuffer(1));
        }
        WASM_FEATURE_VALUES.threads = tryWasm(WASM_THREADS_CHECK);
      } catch (e) {
        WASM_FEATURE_VALUES.threads = Promise.resolve({
          supported: false,
          error: e
        });
      }
    }
    return WASM_FEATURE_VALUES.threads;
  },
  "jspi": () => {
    if (WASM_FEATURE_VALUES.jspi === void 0) {
      try {
        const supported = isJspiSupported();
        WASM_FEATURE_VALUES.jspi = Promise.resolve({
          supported,
          error: supported ? void 0 : new Error("JSPI is not supported")
        });
      } catch (e) {
        WASM_FEATURE_VALUES.jspi = Promise.resolve({
          supported: false,
          error: e
        });
      }
    }
    return WASM_FEATURE_VALUES.jspi;
  }
};
async function supportsFeature(feature) {
  const check = WASM_FEATURE_CHECKS[feature]?.();
  if (!check) {
    throw new Error(`Unknown feature: ${feature}`);
  }
  return (await check).supported;
}

// ../../../../.cache/deno/npm/registry.npmjs.org/@litert-lm/core/0.17.1/dist/load.js
var WASM_JS_FILE_NAME = "litertlm_wasm_internal.js";
var WASM_JS_COMPAT_FILE_NAME = "litertlm_wasm_compat_internal.js";
var WASM_JS_ASYNCIFY_FILE_NAME = "litertlm_wasm_asyncify_internal.js";
var WASM_JS_COMPAT_ASYNCIFY_FILE_NAME = "litertlm_wasm_compat_asyncify_internal.js";
async function load(path, options) {
  const pathString = pathToString(path);
  const relaxedSimd = await supportsFeature("relaxedSimd");
  const jspi = await supportsFeature("jspi");
  let fileName = "";
  if (relaxedSimd) {
    fileName = jspi ? WASM_JS_FILE_NAME : WASM_JS_ASYNCIFY_FILE_NAME;
  } else {
    fileName = jspi ? WASM_JS_COMPAT_FILE_NAME : WASM_JS_COMPAT_ASYNCIFY_FILE_NAME;
  }
  let jsFilePath = path;
  if (pathString.endsWith(".wasm")) {
    throw new Error("Please load the `.js` file corresponding to the `.wasm` file, or load the directory containing it.");
  } else if (!pathString.endsWith(".js")) {
    jsFilePath = appendPathSegment(path, fileName);
  }
  return createWasmLib(LiteRtLm, jsFilePath);
}

// ../../../../.cache/deno/npm/registry.npmjs.org/@litert-lm/core/0.17.1/dist/load_litertlm.js
var globalLiteRtLmPath = void 0;
function loadLiteRtLm(path, options) {
  if (hasGlobalLiteRtLmPromise()) {
    throw new Error("LiteRT-LM is already loading / loaded.");
  }
  setGlobalLiteRtLmPromise(load(path, options).then(async (liteRtLm) => {
    setGlobalLiteRtLm(liteRtLm);
    return liteRtLm;
  }).catch((error) => {
    setGlobalLiteRtLmPromise(void 0);
    throw error;
  }));
  return getGlobalLiteRtLmPromise();
}
function getOrLoadGlobalLiteRtLm(path) {
  const liteRtLmPromise = getGlobalLiteRtLmPromise();
  if (liteRtLmPromise) {
    if (path && globalLiteRtLmPath !== path) {
      throw new Error(`LiteRT-LM is already loading / loaded with a different path ${globalLiteRtLmPath} but was requested to load ${path}. To reload with a different path, call unloadLiteRtLm() first.`);
    }
    return liteRtLmPromise;
  }
  globalLiteRtLmPath = path ?? LiteRtLm.DEFAULT_WASM_PATH;
  return liteRtLmPromise ?? loadLiteRtLm(globalLiteRtLmPath);
}

// ../../../../.cache/deno/npm/registry.npmjs.org/@litert-lm/core/0.17.1/dist/wasm_binding_types.js
var Backend = {
  // Ideally, we'd pull these from the Wasm module, but we want them to be
  // available in JS before the Wasm module is loaded.
  UNSPECIFIED: 0,
  CPU_ARTISAN: 1,
  GPU_ARTISAN: 2,
  CPU: 3,
  GPU: 4,
  GOOGLE_TENSOR_ARTISAN: 5,
  NPU: 6
};

// ../../../../.cache/deno/npm/registry.npmjs.org/@litert-lm/core/0.17.1/dist/wasm_utils.js
function consumeEmscriptenVectorToArray(vector) {
  const array = new Array(vector.size());
  for (let i = 0; i < vector.size(); ++i) {
    array[i] = vector.get(i);
  }
  vector.delete();
  return array;
}
function fillEmscriptenVector(data, vector) {
  for (const item of data) {
    vector.push_back(item);
  }
}

// ../../../../.cache/deno/npm/registry.npmjs.org/@litert-lm/core/0.17.1/dist/engine_settings.js
function fillWasmEngineSettingsFromEngineSettings(wasmEngineSettings, engineSettings, backend, wasm = getGlobalLiteRtLm().liteRtLmWasm) {
  const wasmExecutorSettings = wasmEngineSettings.getMutableMainExecutorSettings();
  wasmExecutorSettings.setCacheDir(":nocache");
  if (engineSettings.benchmarkEnabled) {
    wasmEngineSettings.enableBenchmark();
  }
  if (engineSettings.mainExecutorSettings) {
    const mainExecutorSettings = engineSettings.mainExecutorSettings;
    if (mainExecutorSettings.maxNumTokens !== void 0) {
      wasmExecutorSettings.setMaxNumTokens(mainExecutorSettings.maxNumTokens);
    }
    if (mainExecutorSettings.samplerBackend !== void 0) {
      wasmExecutorSettings.setSamplerBackend({
        value: mainExecutorSettings.samplerBackend
      });
    }
    if (mainExecutorSettings.backendConfig !== void 0) {
      const backendConfig = mainExecutorSettings.backendConfig;
      if (backend === Backend.CPU) {
        wasmExecutorSettings.setBackendConfigCpu(backendConfig);
      } else if (backend === Backend.GPU) {
        wasmExecutorSettings.setBackendConfigGpu(backendConfig);
      } else if (backend === Backend.GPU_ARTISAN) {
        const gpuArtisanConfig = backendConfig;
        const loraRanksVec = new wasm.VectorUint32();
        fillEmscriptenVector(gpuArtisanConfig.supported_lora_ranks, loraRanksVec);
        const wasmGpuArtisanConfig = {
          ...gpuArtisanConfig,
          supported_lora_ranks: loraRanksVec
        };
        wasmExecutorSettings.setBackendConfigGpuArtisan(wasmGpuArtisanConfig);
        loraRanksVec.delete();
      }
    }
    if (mainExecutorSettings.advancedSettings !== void 0) {
      const defaultAdv = wasmExecutorSettings.getAdvancedSettings();
      const newAdv = {
        ...defaultAdv,
        ...mainExecutorSettings.advancedSettings
      };
      wasmExecutorSettings.setAdvancedSettings(newAdv);
    }
  }
}
function wasmEngineSettingsToEngineSettings(wasmEngineSettings) {
  const wasmExecutorSettings = wasmEngineSettings.getMutableMainExecutorSettings();
  let backendConfig;
  let backend;
  try {
    backendConfig = wasmExecutorSettings.getBackendConfigCpu();
    backend = Backend.CPU;
  } catch (e) {
    try {
      backendConfig = wasmExecutorSettings.getBackendConfigGpu();
      backend = Backend.GPU;
    } catch (e2) {
      try {
        const wasmGpuArtisanConfig = wasmExecutorSettings.getBackendConfigGpuArtisan();
        backendConfig = {
          ...wasmGpuArtisanConfig,
          supported_lora_ranks: consumeEmscriptenVectorToArray(wasmGpuArtisanConfig.supported_lora_ranks)
        };
        backend = Backend.GPU_ARTISAN;
      } catch (e3) {
        throw new Error("Unsupported backend config");
      }
    }
  }
  return {
    backend,
    mainExecutorSettings: {
      maxNumTokens: wasmExecutorSettings.getMaxNumTokens(),
      samplerBackend: wasmExecutorSettings.getSamplerBackend().value,
      backendConfig,
      advancedSettings: wasmExecutorSettings.getAdvancedSettings()
    },
    benchmarkEnabled: false
  };
}

// ../../../../.cache/deno/npm/registry.npmjs.org/@litert-lm/core/0.17.1/dist/cleanup.js
var Cleanup = class {
  callbacks = /* @__PURE__ */ new Set();
  add(callback) {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
      callback();
    };
  }
  run() {
    for (const callback of this.callbacks) {
      callback();
    }
    this.callbacks.clear();
  }
};

// ../../../../.cache/deno/npm/registry.npmjs.org/@litert-lm/core/0.17.1/dist/conversation.js
var BUSY_MESSAGE = "Conversation is busy. A generation is already in progress.";
var Conversation = class _Conversation {
  conversation;
  engine;
  mutexes;
  isBusy = false;
  constructor(conversation, engine2, mutexes) {
    this.conversation = conversation;
    this.engine = engine2;
    this.mutexes = mutexes;
  }
  async sendMessage(message) {
    if (this.isBusy) {
      throw new Error(BUSY_MESSAGE);
    }
    this.isBusy = true;
    try {
      return await this.mutexes.executor.acquireAndRun(async () => {
        const currentMessageJson = messageToJsonString(message);
        const resultStr = await this.conversation.sendMessage(currentMessageJson);
        return JSON.parse(resultStr);
      });
    } finally {
      this.isBusy = false;
    }
  }
  /**
     * Sends a message to the LLM and returns a ReadableStream that yields
     * message chunks as they are generated.
     */
  sendMessageStreaming(message) {
    if (this.isBusy) {
      throw new Error(BUSY_MESSAGE);
    }
    this.isBusy = true;
    let isCancelled = false;
    let hasErrored = false;
    return new ReadableStream({
      start: (controller) => {
        const currentMessageJson = messageToJsonString(message);
        const executeGeneration = async () => {
          await this.mutexes.executor.acquireAndRun(async () => {
            await this.conversation.sendMessageAsync(currentMessageJson, (chunk, isDone, error) => {
              if (isCancelled || hasErrored) return;
              if (error) {
                hasErrored = true;
                this.isBusy = false;
                controller.error(new Error(error));
                return;
              }
              if (chunk) {
                try {
                  const msg = JSON.parse(chunk);
                  controller.enqueue(msg);
                } catch (e) {
                  hasErrored = true;
                  this.isBusy = false;
                  controller.error(e);
                }
              }
            });
            await this.engine.waitUntilDone();
          });
          if (isCancelled || hasErrored) return;
          this.isBusy = false;
          controller.close();
        };
        executeGeneration().catch((e) => {
          if (isCancelled || hasErrored) return;
          this.isBusy = false;
          controller.error(e);
        });
      },
      cancel: () => {
        isCancelled = true;
        this.isBusy = false;
        this.cancel();
      }
    });
  }
  /**
     * Sends a signal to cancel any current generation.
     */
  cancel() {
    this.conversation.cancelProcess();
  }
  async getHistory() {
    return this.mutexes.executor.acquireAndRun(() => {
      const historyStr = this.conversation.getHistory();
      return JSON.parse(historyStr);
    });
  }
  async getTokenCount() {
    return this.mutexes.executor.acquireAndRun(() => {
      return this.conversation.getTokenCount();
    });
  }
  async getBenchmarkInfo() {
    return this.mutexes.executor.acquireAndRun(() => {
      return this.conversation.getBenchmarkInfo();
    });
  }
  /**
     * Clones the conversation. The cloned conversation will be independent of the
     * original conversation, including the history, state, etc.
     */
  async clone() {
    if (this.isBusy) {
      throw new Error(BUSY_MESSAGE);
    }
    this.isBusy = true;
    try {
      return await this.mutexes.executor.acquireAndRun(() => {
        const wasmClonedConversation = this.conversation.clone();
        return new _Conversation(wasmClonedConversation, this.engine, this.mutexes);
      });
    } finally {
      this.isBusy = false;
    }
  }
  async delete() {
    await this.mutexes.executor.acquireAndRun(() => {
      this.conversation.delete();
    });
  }
};
function messageToJsonString(messageLike) {
  let message;
  if (Array.isArray(messageLike)) {
    message = messageLike.map(toMessage);
  } else {
    message = toMessage(messageLike);
  }
  return JSON.stringify(message);
}
function toMessage(messageLike) {
  if (typeof messageLike === "string") {
    return {
      role: "user",
      content: messageLike
    };
  }
  return messageLike;
}

// ../../../../.cache/deno/npm/registry.npmjs.org/@litert-lm/core/0.17.1/dist/mutex.js
var Mutex = class {
  mutexPromise = Promise.resolve();
  queueCount = 0;
  /**
     * Whether the mutex is currently locked.
     */
  get isLocked() {
    return this.queueCount > 0;
  }
  /**
     * Executes the provided function once the mutex is acquired, and releases
     * the mutex when the function completes.
     */
  async acquireAndRun(fn) {
    this.queueCount++;
    const previousPromise = this.mutexPromise;
    let resolveMutex;
    this.mutexPromise = new Promise((resolve) => {
      resolveMutex = resolve;
    });
    try {
      await previousPromise;
      return await fn();
    } finally {
      this.queueCount--;
      resolveMutex();
    }
  }
};

// ../../../../.cache/deno/npm/registry.npmjs.org/@litert-lm/core/0.17.1/dist/readable_stream_data_stream_wrapper.js
var Slice = class {
  size;
  data;
  fullyDiscarded = false;
  discardedRegions = [];
  constructor(size) {
    this.size = size;
  }
  discard(start, end) {
    if (this.fullyDiscarded) return;
    if (this.discardedRegions.length === 0) {
      this.discardedRegions.push([
        start,
        end
      ]);
      this.checkFullyDiscarded();
      return;
    }
    this.discardedRegions.push([
      start,
      end
    ]);
    this.discardedRegions.sort((a, b) => a[0] - b[0]);
    const mergedRegions = [];
    for (const region of this.discardedRegions) {
      const lastRegion = mergedRegions[mergedRegions.length - 1];
      if (!lastRegion || lastRegion[1] < region[0]) {
        mergedRegions.push(region);
      } else {
        lastRegion[1] = Math.max(lastRegion[1], region[1]);
      }
    }
    this.discardedRegions = mergedRegions;
    this.checkFullyDiscarded();
  }
  getDiscardedRegions(start = 0, end = this.size) {
    const result = [];
    for (const [rStart, rEnd] of this.discardedRegions) {
      if (rStart >= end) {
        break;
      }
      if (rEnd <= start) {
        continue;
      }
      result.push([
        rStart,
        rEnd
      ]);
    }
    return result;
  }
  checkFullyDiscarded() {
    if (this.discardedRegions.length === 1 && this.discardedRegions[0][0] === 0 && this.discardedRegions[0][1] === this.size) {
      this.fullyDiscarded = true;
      this.data = void 0;
    }
  }
};
var ReadableStreamDataStreamWrapper = class {
  stream;
  getWasmHeap;
  bytesPerSlice;
  slices = [];
  streamDone = false;
  globalPosition = 0;
  reader;
  leftoverData;
  isReading = false;
  constructor(stream, getWasmHeap, bytesPerSlice = 1e7) {
    this.stream = stream;
    this.getWasmHeap = getWasmHeap;
    this.bytesPerSlice = bytesPerSlice;
    try {
      this.reader = {
        byobReader: this.stream.getReader({
          mode: "byob"
        })
      };
    } catch (e) {
      this.reader = {
        defaultReader: this.stream.getReader()
      };
    }
  }
  *getViews(start, end) {
    if (start >= end) {
      return;
    }
    let scratchBuffer;
    let previousSlice;
    let position = start;
    while (position < end) {
      const sliceIndex = Math.floor(position / this.bytesPerSlice);
      const slicePosition = position % this.bytesPerSlice;
      const sliceStartGlobalPosition = sliceIndex * this.bytesPerSlice;
      let slice = this.slices[sliceIndex];
      if (!slice) {
        if (!previousSlice || !previousSlice.fullyDiscarded) {
          scratchBuffer = new Uint8Array(this.bytesPerSlice);
        }
        slice = new Slice(this.bytesPerSlice);
        slice.data = scratchBuffer;
        this.slices[sliceIndex] = slice;
      }
      const viewEnd = Math.min(this.bytesPerSlice, end - sliceStartGlobalPosition);
      const discardView = () => {
        slice.discard(slicePosition, viewEnd);
      };
      const viewLength = viewEnd - slicePosition;
      const setView = (view) => {
        slice.data = new Uint8Array(view.buffer, 0, view.buffer.byteLength);
        scratchBuffer = slice.data;
      };
      const checkReadable = () => {
        const discardedRegions = slice.getDiscardedRegions(slicePosition, viewEnd);
        if (discardedRegions.length > 0) {
          const globalDiscardedRegions = discardedRegions.map(([start2, end2]) => `[${start2 + sliceStartGlobalPosition}, ${end2 + sliceStartGlobalPosition}]`);
          throw new Error(`Slice ${sliceIndex} for data at ${position} overlaps discarded regions: [${globalDiscardedRegions.join(", ")}]`);
        }
        if (!slice.data) {
          throw new Error(`No ArrayBuffer for slice ${sliceIndex} at position ${position}`);
        }
      };
      const getView = () => {
        checkReadable();
        return new Uint8Array(slice.data.buffer, slice.data.byteOffset + slicePosition, slice.data.byteOffset + viewLength);
      };
      yield {
        getView,
        discardView,
        setView,
        checkReadable
      };
      previousSlice = slice;
      position += viewLength;
    }
  }
  async readInternal(destAddress, offset, count, discard) {
    if (this.isReading) {
      throw new Error("Concurrent reads are not supported");
    }
    this.isReading = true;
    try {
      for (const { getView, setView, checkReadable } of this.getViews(this.globalPosition, offset)) {
        checkReadable();
        const newView = await this.fillBufferFromStream(getView());
        setView(newView);
        if (newView.length === 0) {
          break;
        }
      }
      const endOfCachedRead = Math.min(this.globalPosition, offset + count);
      for (const { getView, discardView } of this.getViews(offset, endOfCachedRead)) {
        const view = getView();
        this.getWasmHeap().set(view, destAddress);
        if (discard) discardView();
        destAddress += view.length;
      }
      const startOfUncachedRead = Math.max(endOfCachedRead, offset);
      for (const { getView, setView, discardView } of this.getViews(startOfUncachedRead, offset + count)) {
        if (this.streamDone && this.globalPosition <= startOfUncachedRead) break;
        const newView = await this.fillBufferFromStream(getView());
        setView(newView);
        this.getWasmHeap().set(newView, destAddress);
        if (discard) discardView();
        destAddress += newView.length;
      }
    } finally {
      this.isReading = false;
    }
  }
  async fillBufferFromStream(buffer) {
    const byteLength = buffer.byteLength;
    if (byteLength === 0) {
      return buffer;
    }
    const byteOffset = buffer.byteOffset;
    let bytesRead = 0;
    let arrayBuffer = buffer.buffer;
    while (bytesRead < byteLength) {
      if (this.streamDone && (!this.leftoverData || this.leftoverData.length === 0)) {
        throw new Error(`Read from stream returned early EOF at position ${this.globalPosition}. Expected ${byteLength - bytesRead} more bytes.`);
      }
      if (this.reader.byobReader) {
        const view = new Uint8Array(arrayBuffer, byteOffset + bytesRead, byteLength - bytesRead);
        const result2 = await this.reader.byobReader.read(view);
        if (result2.done) {
          this.streamDone = true;
        }
        if (!result2.value) {
          throw new Error("Read from stream returned null value");
        }
        this.globalPosition += result2.value.byteLength;
        bytesRead += result2.value.byteLength;
        arrayBuffer = result2.value.buffer;
      } else {
        let chunk;
        if (this.leftoverData && this.leftoverData.length > 0) {
          chunk = this.leftoverData;
          this.leftoverData = void 0;
        } else {
          const result2 = await this.reader.defaultReader.read();
          if (result2.done) {
            this.streamDone = true;
            if (!result2.value) {
              continue;
            }
          }
          if (!result2.value) {
            throw new Error("Read from stream returned null value");
          }
          chunk = result2.value;
        }
        const bytesNeeded = byteLength - bytesRead;
        const bytesToCopy = Math.min(chunk.length, bytesNeeded);
        const destView = new Uint8Array(arrayBuffer, byteOffset + bytesRead, bytesToCopy);
        destView.set(chunk.subarray(0, bytesToCopy));
        if (chunk.length > bytesToCopy) {
          this.leftoverData = chunk.subarray(bytesToCopy);
        }
        this.globalPosition += bytesToCopy;
        bytesRead += bytesToCopy;
      }
    }
    const result = new Uint8Array(arrayBuffer, byteOffset, bytesRead);
    if (result.length !== byteLength) {
      throw new Error(`Read from stream returned ${result.length} bytes, expected ${byteLength}`);
    }
    return result;
  }
  doDiscard(offset, count) {
    for (const { discardView } of this.getViews(offset, offset + count)) {
      discardView();
    }
  }
  async readAndDiscard(destAddress, offset, count) {
    try {
      await this.readInternal(destAddress >>> 0, toNumber(offset), toNumber(count), true);
      return {};
    } catch (e) {
      return {
        error: e
      };
    }
  }
  async readAndPreserve(destAddress, offset, count) {
    try {
      await this.readInternal(destAddress >>> 0, toNumber(offset), toNumber(count), false);
      return {};
    } catch (e) {
      return {
        error: e
      };
    }
  }
  discard(offset, count) {
    try {
      this.doDiscard(toNumber(offset), toNumber(count));
      return {};
    } catch (e) {
      return {
        error: e
      };
    }
  }
};
function toNumber(val) {
  if (typeof val === "number") {
    return val;
  }
  if (val > Number.MAX_SAFE_INTEGER) {
    throw new Error(`BigInt value ${val} too large to be represented as a number`);
  }
  return Number(val);
}

// ../../../../.cache/deno/npm/registry.npmjs.org/@litert-lm/core/0.17.1/dist/session_config.js
function sessionConfigToWasmSessionConfig(sessionConfig, wasm = getGlobalLiteRtLm().liteRtLmWasm) {
  const wasmSessionConfig = wasm.SessionConfig.createDefault();
  if (sessionConfig.audioModalityEnabled !== void 0) {
    wasmSessionConfig.setAudioModalityEnabled(sessionConfig.audioModalityEnabled);
  }
  if (sessionConfig.visionModalityEnabled !== void 0) {
    wasmSessionConfig.setVisionModalityEnabled(sessionConfig.visionModalityEnabled);
  }
  if (sessionConfig.samplerParams !== void 0) {
    const samplerParams = wasmSessionConfig.getMutableSamplerParams();
    if (sessionConfig.samplerParams.type !== void 0) {
      samplerParams.setType({
        value: sessionConfig.samplerParams.type
      });
    }
    if (sessionConfig.samplerParams.k !== void 0) {
      samplerParams.setK(sessionConfig.samplerParams.k);
    }
    if (sessionConfig.samplerParams.p !== void 0) {
      samplerParams.setP(sessionConfig.samplerParams.p);
    }
    if (sessionConfig.samplerParams.temperature !== void 0) {
      samplerParams.setTemperature(sessionConfig.samplerParams.temperature);
    }
    if (sessionConfig.samplerParams.seed !== void 0) {
      samplerParams.setSeed(sessionConfig.samplerParams.seed);
    }
  }
  if (sessionConfig.startTokenId !== void 0) {
    wasmSessionConfig.setStartTokenId(sessionConfig.startTokenId);
  }
  if (sessionConfig.numOutputCandidates !== void 0) {
    wasmSessionConfig.setNumOutputCandidates(sessionConfig.numOutputCandidates);
  }
  if (sessionConfig.samplerBackend !== void 0) {
    wasmSessionConfig.setSamplerBackend({
      value: sessionConfig.samplerBackend
    });
  }
  if (sessionConfig.applyPromptTemplateInSession !== void 0) {
    wasmSessionConfig.setApplyPromptTemplateInSession(sessionConfig.applyPromptTemplateInSession);
  }
  if (sessionConfig.useExternalSampler !== void 0) {
    wasmSessionConfig.setUseExternalSampler(sessionConfig.useExternalSampler);
  }
  if (sessionConfig.maxOutputTokens !== void 0) {
    wasmSessionConfig.setMaxOutputTokens(sessionConfig.maxOutputTokens);
  }
  if (sessionConfig.stopTokenIds !== void 0) {
    const outerVec = new wasm.VectorVectorInt();
    for (const innerArr of sessionConfig.stopTokenIds) {
      const innerVec = new wasm.VectorInt();
      fillEmscriptenVector(innerArr, innerVec);
      outerVec.push_back(innerVec);
      innerVec.delete();
    }
    wasmSessionConfig.setStopTokenIds(outerVec);
    outerVec.delete();
  }
  return wasmSessionConfig;
}
function wasmSessionConfigToSessionConfig(wasmSessionConfig) {
  const samplerParams = wasmSessionConfig.getMutableSamplerParams();
  return {
    audioModalityEnabled: wasmSessionConfig.getAudioModalityEnabled(),
    visionModalityEnabled: wasmSessionConfig.getVisionModalityEnabled(),
    samplerParams: {
      type: samplerParams.type().value,
      k: samplerParams.k(),
      p: samplerParams.p(),
      temperature: samplerParams.temperature(),
      seed: samplerParams.seed()
    },
    stopTokenIds: consumeEmscriptenVectorToArray(wasmSessionConfig.getStopTokenIds()).map(consumeEmscriptenVectorToArray),
    startTokenId: wasmSessionConfig.getStartTokenId(),
    numOutputCandidates: wasmSessionConfig.getNumOutputCandidates(),
    samplerBackend: wasmSessionConfig.getSamplerBackend().value,
    applyPromptTemplateInSession: wasmSessionConfig.getApplyPromptTemplateInSession(),
    useExternalSampler: wasmSessionConfig.getUseExternalSampler(),
    maxOutputTokens: wasmSessionConfig.getMaxOutputTokens()
  };
}

// ../../../../.cache/deno/npm/registry.npmjs.org/@litert-lm/core/0.17.1/dist/session.js
var BUSY_MESSAGE2 = "Session is busy. An operation is already in progress.";
var Session = class _Session {
  session;
  mutexes;
  config;
  isBusy = false;
  constructor(session, mutexes) {
    this.session = session;
    this.mutexes = mutexes;
    const wasmSessionConfig = session.getSessionConfig();
    this.config = wasmSessionConfigToSessionConfig(wasmSessionConfig);
    wasmSessionConfig.delete();
  }
  async runPrefill(inputs) {
    if (this.isBusy) {
      throw new Error(BUSY_MESSAGE2);
    }
    this.isBusy = true;
    try {
      await this.mutexes.executor.acquireAndRun(async () => {
        await this.session.runPrefill(inputs);
      });
    } finally {
      this.isBusy = false;
    }
  }
  async runDecode() {
    if (this.isBusy) {
      throw new Error(BUSY_MESSAGE2);
    }
    this.isBusy = true;
    try {
      return await this.mutexes.executor.acquireAndRun(async () => {
        const wasmResponses = await this.session.runDecode();
        return new Responses(wasmResponses);
      });
    } finally {
      this.isBusy = false;
    }
  }
  /**
     * Sends a signal to cancel any current generation.
     */
  cancel() {
    this.session.cancelProcess();
  }
  /**
     * Clones the session. The cloned session will have all the settings and
     * context of the original session up to the point that clone is called.
     */
  async clone() {
    if (this.isBusy) {
      throw new Error(BUSY_MESSAGE2);
    }
    this.isBusy = true;
    try {
      return await this.mutexes.executor.acquireAndRun(() => {
        const wasmClonedSession = this.session.clone();
        return new _Session(wasmClonedSession, this.mutexes);
      });
    } finally {
      this.isBusy = false;
    }
  }
  async delete() {
    await this.mutexes.executor.acquireAndRun(() => {
      this.session.delete();
    });
  }
};
var Responses = class {
  responses;
  constructor(responses) {
    this.responses = responses;
  }
  getTexts() {
    const texts = this.responses.getTexts();
    return consumeEmscriptenVectorToArray(texts);
  }
  delete() {
    this.responses.delete();
  }
};

// ../../../../.cache/deno/npm/registry.npmjs.org/@litert-lm/core/0.17.1/dist/engine.js
var modelPathIndex = 0;
var Engine = class _Engine {
  wasm;
  engine;
  deleteCallback;
  settings;
  mutexes = {
    executor: new Mutex()
  };
  constructor(wasm, engine2, modelSource, deleteCallback) {
    this.wasm = wasm;
    this.engine = engine2;
    this.deleteCallback = deleteCallback;
    const wasmEngineSettings = engine2.getEngineSettings();
    const settingsWithoutModel = wasmEngineSettingsToEngineSettings(wasmEngineSettings);
    this.settings = {
      ...settingsWithoutModel,
      model: modelSource
    };
    wasmEngineSettings.delete();
  }
  static async create(engineSettings, inputPromptAsHint = "") {
    const litertlm = await getOrLoadGlobalLiteRtLm();
    const wasm = litertlm.liteRtLmWasm;
    const dstPath = `/model_${modelPathIndex++}.litertlm`;
    const backend = engineSettings.backend ?? Backend.GPU_ARTISAN;
    engineSettings = {
      ...engineSettings,
      backend
    };
    const samplerBackend = engineSettings.mainExecutorSettings?.samplerBackend;
    if (backend === Backend.GPU || backend === Backend.GPU_ARTISAN || samplerBackend === Backend.GPU || samplerBackend === Backend.GPU_ARTISAN) {
      await litertlm.setupDefaultWebGpuDevice();
    }
    const cleanup = new Cleanup();
    const modelStream = await modelToStream(engineSettings.model);
    let engine2;
    try {
      let modelAssets;
      const isStreaming = backend === Backend.GPU_ARTISAN;
      if (isStreaming) {
        const streamWrapper = new ReadableStreamDataStreamWrapper(modelStream, () => wasm.HEAPU8);
        const dataStream = wasm.ReadableStreamDataStream.create(streamWrapper);
        cleanup.add(() => {
          dataStream.delete();
        });
        modelAssets = wasm.ModelAssets.createStreaming(dataStream);
      } else {
        await loadModelToVfs(wasm, modelStream, dstPath);
        cleanup.add(() => {
          try {
            wasm.FS.unlink(dstPath);
          } catch (e) {
            console.error(`Error removing file from VFS:`, e);
          }
        });
        modelAssets = wasm.ModelAssets.create(dstPath);
      }
      const cleanupModelAssets = cleanup.add(() => {
        modelAssets.delete();
      });
      const wasmEngineSettings = wasm.EngineSettings.createDefault(modelAssets, {
        value: backend
      });
      cleanupModelAssets();
      const cleanupWasmEngineSettings = cleanup.add(() => {
        wasmEngineSettings.delete();
      });
      fillWasmEngineSettingsFromEngineSettings(wasmEngineSettings, engineSettings, backend, wasm);
      wasmEngineSettings.setParallelFileSectionLoading(false);
      wasmEngineSettings.setSingleThreadedExecution(true);
      if (isStreaming) {
        engine2 = await wasm.Engine.createStreaming(wasmEngineSettings, inputPromptAsHint);
      } else {
        engine2 = await wasm.Engine.createEngine(wasmEngineSettings, inputPromptAsHint);
      }
      cleanupWasmEngineSettings();
      cleanup.add(() => {
        engine2.delete();
      });
      return new _Engine(wasm, engine2, engineSettings.model, () => cleanup.run());
    } catch (e) {
      cleanup.run();
      throw e;
    }
  }
  async createSession(sessionConfig = {}) {
    return this.mutexes.executor.acquireAndRun(() => {
      const wasmSessionConfig = sessionConfigToWasmSessionConfig(sessionConfig, this.wasm);
      const wasmSession = this.engine.createSession(wasmSessionConfig);
      wasmSessionConfig.delete();
      return new Session(wasmSession, this.mutexes);
    });
  }
  async createConversation(config) {
    return this.mutexes.executor.acquireAndRun(async () => {
      let wasmConfig;
      let wasmSessionConfig;
      if (config) {
        wasmSessionConfig = sessionConfigToWasmSessionConfig(config.sessionConfig || {}, this.wasm);
        const prefaceJson = config.preface ? JSON.stringify(config.preface) : "";
        wasmConfig = this.wasm.ConversationConfig.createCustom(this.engine, wasmSessionConfig, !!config.enableConstrainedDecoding, !!config.prefillPrefaceOnInit, !!config.filterChannelContentFromKvCache, prefaceJson);
      } else {
        wasmConfig = this.wasm.ConversationConfig.createDefault(this.engine);
      }
      const wasmConversation = await this.wasm.Conversation.create(this.engine, wasmConfig);
      wasmConfig.delete();
      if (wasmSessionConfig) {
        wasmSessionConfig.delete();
      }
      return new Conversation(wasmConversation, this.engine, this.mutexes);
    });
  }
  async delete() {
    await this.mutexes.executor.acquireAndRun(() => {
      this.deleteCallback();
    });
  }
};
async function modelToStream(model) {
  if (model instanceof ReadableStream) {
    return model;
  }
  if (model instanceof Blob) {
    return model.stream();
  }
  const modelUrl = model;
  const response = await fetch(modelUrl, {
    credentials: "same-origin"
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch model file from ${modelUrl}`);
  }
  return response.body;
}
async function loadModelToVfs(module, modelStream, dstPath) {
  let fileContent;
  const reader = modelStream.getReader();
  const chunks = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalLength += value.length;
    }
  }
  fileContent = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    fileContent.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    module.FS.writeFile(dstPath, fileContent);
  } catch (e) {
    console.error(`Error writing file to VFS:`, e);
    throw e;
  }
}

// src/llm_models.ts
var MODEL_CACHE = "yurt-llm";

// src/llm_store.ts
var PART_BYTES = 64 * 1024 * 1024;
var PARTS_HEADER = "x-yurt-parts";
function withModelLock(requestLock, key, operation) {
  const pathname = new URL(key, "https://yurt.invalid").pathname;
  return requestLock(`yurt-model-cache:${pathname}`, operation).then((value) => value);
}
function partKey(key, index) {
  return `${key}${key.includes("?") ? "&" : "?"}part=${index}`;
}
async function readModel(cache, key) {
  const head = await cache.match(key);
  if (head === void 0) return void 0;
  const count = head.headers.get(PARTS_HEADER);
  if (count === null) return await head.blob();
  const n = Number(count);
  if (!Number.isInteger(n) || n < 0) return void 0;
  const parts = [];
  for (let index = 0; index < n; index++) {
    const part = await cache.match(partKey(key, index));
    if (part === void 0) return void 0;
    parts.push(await part.blob());
  }
  return new Blob(parts);
}
async function storeModel(cache, key, body, partBytes = PART_BYTES) {
  const pending = [];
  let pendingBytes = 0;
  let parts = 0;
  let total = 0;
  const flush = async (bytes) => {
    const out = [];
    let need = bytes;
    while (need > 0) {
      const chunk = pending[0];
      if (chunk.byteLength <= need) {
        out.push(chunk);
        pending.shift();
        need -= chunk.byteLength;
      } else {
        out.push(chunk.subarray(0, need));
        pending[0] = chunk.subarray(need);
        need = 0;
      }
    }
    pendingBytes -= bytes;
    await cache.put(partKey(key, parts), new Response(new Blob(out)));
    parts++;
  };
  const reader = body.getReader();
  try {
    for (; ; ) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
      total += chunk.byteLength;
      while (pendingBytes >= partBytes) await flush(partBytes);
    }
    if (pendingBytes > 0) await flush(pendingBytes);
    await cache.put(key, new Response(null, {
      headers: {
        [PARTS_HEADER]: String(parts)
      }
    }));
  } catch (error) {
    await reader.cancel(error).catch(() => {
    });
    for (let index = 0; index <= parts; index++) {
      await cache.delete(partKey(key, index)).catch(() => false);
    }
    await cache.delete(key).catch(() => false);
    throw error;
  }
  return total;
}

// src/llm_worker.ts
var post = (msg) => self.postMessage(msg);
var engine;
var active;
var cancelRequested = false;
async function modelBlob(url, key) {
  return await withModelLock((name, operation) => navigator.locks.request(name, operation), key, async () => {
    const cache = await caches.open(MODEL_CACHE);
    const cached = await readModel(cache, key);
    if (cached !== void 0) {
      return {
        blob: cached,
        fromCache: true,
        downloadBytes: 0,
        downloadMs: 0
      };
    }
    const started = performance.now();
    const response = await fetch(url);
    if (!response.ok || response.body === null) {
      throw new Error(`${url}: HTTP ${response.status}`);
    }
    const total = Number(response.headers.get("content-length") ?? 0);
    let loaded = 0;
    let lastPost = 0;
    const counted = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        if (loaded - lastPost > 16 * 1024 * 1024 || loaded === total) {
          lastPost = loaded;
          post({
            type: "progress",
            loaded,
            total
          });
        }
        controller.enqueue(chunk);
      }
    }));
    for (const request of await cache.keys()) {
      const old = new URL(request.url);
      if (old.pathname === new URL(key, location.href).pathname) {
        await cache.delete(request);
      }
    }
    await storeModel(cache, key, counted);
    const stored = await readModel(cache, key);
    if (stored === void 0) {
      throw new Error("model vanished from the cache");
    }
    return {
      blob: stored,
      fromCache: false,
      downloadBytes: loaded,
      downloadMs: performance.now() - started
    };
  });
}
async function instantiateGzipped(url, imports) {
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  const wasm = new Response(response.body.pipeThrough(new DecompressionStream("gzip")), {
    headers: {
      "content-type": "application/wasm"
    }
  });
  return (await WebAssembly.instantiateStreaming(wasm, imports)).instance;
}
async function load2(model, cacheKey, maxNumTokens) {
  let glue = "";
  const scope = self;
  const importScripts2 = scope.importScripts.bind(self);
  scope.importScripts = (...urls) => {
    glue = String(urls.at(-1) ?? "");
    importScripts2(...urls);
  };
  self.Module = {
    instantiateWasm(imports, done) {
      instantiateGzipped(glue.replace(/\.js$/, ".wasm.gz"), imports).then(done, (error) => post({
        type: "error",
        message: `runtime wasm: ${error}`
      }));
      return {};
    }
  };
  let t = performance.now();
  await loadLiteRtLm(new URL("./llm/wasm/", self.location.href).href);
  const wasmMs = performance.now() - t;
  const wasmVariant = glue.replace(/\.js$/, ".wasm");
  const got = await modelBlob(model, cacheKey);
  t = performance.now();
  engine = await Engine.create({
    model: got.blob,
    mainExecutorSettings: {
      maxNumTokens
    },
    benchmarkEnabled: true
  });
  post({
    type: "loaded",
    wasmVariant: wasmVariant.split("/").pop(),
    fromCache: got.fromCache,
    downloadBytes: got.downloadBytes,
    downloadMs: got.downloadMs,
    wasmMs,
    engineMs: performance.now() - t
  });
}
async function generate(msg) {
  if (engine === void 0) throw new Error("no model loaded");
  const conversation = await engine.createConversation({
    preface: {
      messages: [
        {
          role: "system",
          content: msg.system
        }
      ]
    },
    sessionConfig: {
      maxOutputTokens: msg.maxOutputTokens
    }
  });
  active = conversation;
  if (cancelRequested) conversation.cancel();
  const started = performance.now();
  let firstTokenMs = null;
  let text = "";
  try {
    const reader = conversation.sendMessageStreaming(msg.prompt).getReader();
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      firstTokenMs ??= performance.now() - started;
      const parts = typeof value.content === "string" ? [
        {
          type: "text",
          text: value.content
        }
      ] : value.content ?? [];
      for (const part of parts) {
        if (part.type === "text") {
          text += part.text;
          post({
            type: "token",
            id: msg.id,
            text: part.text
          });
        }
      }
    }
    post({
      type: "done",
      id: msg.id,
      text,
      firstTokenMs,
      wallMs: performance.now() - started,
      bench: await conversation.getBenchmarkInfo()
    });
  } finally {
    active = void 0;
    await conversation.delete();
  }
}
self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === "cancel") {
    cancelRequested = true;
    active?.cancel();
    return;
  }
  try {
    if (msg.type === "load") {
      await load2(msg.model, msg.cacheKey ?? msg.model, msg.maxNumTokens);
    } else {
      cancelRequested = false;
      await generate(msg);
    }
  } catch (error) {
    post({
      type: "error",
      id: msg.type === "generate" ? msg.id : void 0,
      message: error instanceof Error ? error.message : String(error)
    });
  }
};
