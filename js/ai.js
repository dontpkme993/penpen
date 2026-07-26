'use strict';
/* ═══════════════════════════════════════════════════════
   ai.js — AI Tools
   AiRmbg    : Transformers.js + briaai/RMBG-1.4
   AiInpaint : onnxruntime-web + Carve/LaMa-ONNX (direct ONNX)
   AiUpsample: Transformers.js image-to-image pipeline
   AiSam     : Transformers.js + Xenova/slimsam-77-uniform (點擊式選取)
   AiOutpaint: onnxruntime-web + Carve/LaMa-ONNX (擴展畫面)

   五個工具都優先使用 WebGPU，取不到 adapter 或載入失敗時自動退回 CPU(WASM)。
   ═══════════════════════════════════════════════════════ */

const AI_CDN       = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4';
// 必須用 ort.webgpu.min.mjs：預設的 ort.min.mjs bundle 不含 WebGPU EP，
// 指定 executionProviders:['webgpu'] 會被忽略而永遠退回 WASM。
// 此 bundle 同時含 WASM CPU EP，因此退回路徑不需要另外載入。
const ORT_CDN      = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1/dist/ort.webgpu.min.mjs';
const RMBG_DEFAULT = 'briaai/RMBG-1.4';
// 明確指定，否則 Transformers.js 挑預設 dtype，ModelRegistry 統計到的
// 權重檔會與實際載入的不一致（大小顯示錯誤）
const RMBG_DTYPE   = 'fp32';
const LAMA_DEFAULT = 'Carve/LaMa-ONNX';
const LAMA_FILE    = 'lama_fp32.onnx'; // 208 MB, fixed 512×512 input
const AI_MODEL_CACHE = 'penpen-ai-models-v1'; // Cache API bucket，存放裸 ONNX 權重


/* ── Shared module-level helpers ── */
let _aiTf  = null;
let _inpOrt = null;  // onnxruntime-web instance for AiInpaint

// Make a dialog draggable by its .dlg-header
function _makeDlgDraggable(dlg) {
  const header = dlg.querySelector('.dlg-header');
  if (!header) return;
  header.style.cursor = 'move';
  let startX, startY, startLeft, startTop;
  header.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const rect = dlg.getBoundingClientRect();
    startX    = e.clientX;
    startY    = e.clientY;
    startLeft = rect.left;
    startTop  = rect.top;
    e.preventDefault();
    const onMove = e => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const maxL = window.innerWidth  - dlg.offsetWidth;
      const maxT = window.innerHeight - dlg.offsetHeight;
      dlg.style.left = Math.max(0, Math.min(maxL, startLeft + dx)) + 'px';
      dlg.style.top  = Math.max(0, Math.min(maxT, startTop  + dy)) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}
const _aiTick = () => new Promise(r => setTimeout(r, 0));
// Wait for next paint frame before heavy work (ensures shimmer renders before blocking)
const _aiTickRender = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
/* ── WebGPU 能力偵測 ──
   navigator.gpu 存在不代表真的拿得到 adapter（無相容 GPU、驅動被封鎖、
   Linux 未開 flag 等情況都會回 null）。實測一次並快取結果；若之後實際
   載入模型時 WebGPU 仍失敗，_aiGpuOk 會被標為 false，本工作階段不再重試。 */
let _aiGpuOk = null;   // null = 尚未偵測

async function _aiHasWebGpu() {
  if (_aiGpuOk !== null) return _aiGpuOk;
  _aiGpuOk = false;
  try {
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      _aiGpuOk = !!(await navigator.gpu.requestAdapter());
    }
  } catch (err) {
    console.warn('[AI] WebGPU adapter 偵測失敗：', err);
    _aiGpuOk = false;
  }
  return _aiGpuOk;
}

/* Transformers.js device 字串。
   注意：v4 只接受 'webgpu' 或 'wasm'，v3 的 'cpu' 會直接丟
   Unsupported device 錯誤，升級時務必一起改。 */
const AI_DEV_CPU = 'wasm';

async function _aiPickDevice() {
  return (await _aiHasWebGpu()) ? 'webgpu' : AI_DEV_CPU;
}

/* 以偏好裝置載入 Transformers.js 模型，WebGPU 失敗時自動退回 CPU。
   loader(device) → Promise<模型物件>
   onFallback(err) → 可選，用來更新 UI 狀態
   回傳 { obj, device } —— device 為實際生效的裝置 */
async function _aiLoadWithFallback(loader, onFallback) {
  const device = await _aiPickDevice();
  try {
    return { obj: await loader(device), device };
  } catch (err) {
    if (device !== 'webgpu') throw err;
    console.warn('[AI] WebGPU 載入失敗，退回 CPU：', err);
    _aiGpuOk = false;              // 本工作階段後續一律走 CPU
    if (onFallback) onFallback(err);
    return { obj: await loader(AI_DEV_CPU), device: AI_DEV_CPU };
  }
}

/* 下載裸 ONNX 權重，優先命中 Cache API。
   LaMa fp32 有 208 MB，只靠 HTTP cache 很容易被瀏覽器淘汰而重複下載。
   onProgress(ratio, fromCache) */
async function _aiFetchModelBuf(url, onProgress) {
  let cache = null;
  try {
    cache = await caches.open(AI_MODEL_CACHE);
  } catch (err) {
    // 無痕模式、儲存權限被拒等情況沒有 caches，直接走網路
    console.warn('[AI] 模型快取不可用：', err);
  }

  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      if (onProgress) onProgress(1, true);
      return await hit.arrayBuffer();
    }
  }

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} — ${url}`);

  const total  = +resp.headers.get('Content-Length') || 0;
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total && onProgress) onProgress(received / total, false);
  }
  const buf = await new Blob(chunks).arrayBuffer();

  // 存回快取（不用 resp.clone()：對 200 MB 的模型會多佔一份記憶體）
  if (cache) {
    try {
      await cache.put(url, new Response(buf, {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.byteLength) },
      }));
    } catch (err) {
      console.warn('[AI] 模型快取寫入失敗（可能超出儲存配額）：', err);
    }
  }
  return buf;
}

/* 建立 ORT InferenceSession：優先 WebGPU，失敗退回純 WASM。
   forceWasm=true 時直接走 WASM（LaMa 這類含 DFT 的模型在部分裝置上
   WebGPU 反而較慢，保留手動關閉的出口）。
   回傳 { session, ep } */
async function _aiCreateOrtSession(ort, buf, tag, forceWasm = false) {
  if (!forceWasm && await _aiHasWebGpu()) {
    try {
      const session = await ort.InferenceSession.create(buf, {
        executionProviders: ['webgpu', 'wasm'],  // 不支援的節點自動退回 WASM
      });
      return { session, ep: 'webgpu' };
    } catch (err) {
      console.warn(`[${tag}] WebGPU Session 建立失敗，退回 WASM：`, err);
      _aiGpuOk = false;
    }
  }
  const session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
  return { session, ep: 'wasm' };
}

/* 載入 Transformers.js（v4）並套用全域設定。
   注意 AI_CDN 必須是 bare package 形式，讓 jsdelivr 解析到已打包好的
   dist/transformers.min.js；直接指定 dist/transformers.web.js 會因為裡面
   有 'onnxruntime-web/webgpu' 這個 bare specifier 而無法在瀏覽器解析。 */
async function _aiLoadTf() {
  if (!_aiTf) {
    _aiTf = await import(AI_CDN);
    _aiTf.env.allowLocalModels = false;  // 一律從 HuggingFace 下載
    _aiTf.env.useWasmCache    = true;    // v4：快取 ORT wasm，離線時仍可用
  }
  return _aiTf;
}

const _aiFmtBytes = b => b >= 1048576
  ? Math.round(b / 1048576) + ' MB'
  : Math.max(1, Math.round(b / 1024)) + ' KB';

/* 查詢模型的下載大小與快取狀態（v4 ModelRegistry）。
   dtype 必須與該工具實際載入時傳入的值一致，否則會統計到不同的權重檔。
   純資訊用途：任何失敗都回 null，絕不影響主流程。 */
async function _aiModelInfo(modelId, dtype) {
  try {
    const { ModelRegistry } = await _aiLoadTf();
    const opts  = dtype ? { dtype } : {};
    const files = await ModelRegistry.get_model_files(modelId, opts);
    let bytes = 0, unknown = false;
    for (const f of files) {
      const md = await ModelRegistry.get_file_metadata(modelId, f);
      if (md && md.exists && md.size) bytes += md.size;
      else unknown = true;
    }
    const cached = await ModelRegistry.is_cached(modelId, opts);
    return { bytes, unknown, cached };
  } catch (err) {
    console.warn('[AI] 模型資訊查詢失敗：', err);
    return null;
  }
}

/* 產生「模型 ID · 大小 · 快取狀態」說明字串，查不到則回 null。 */
async function _aiModelInfoText(modelId, dtype) {
  const info = await _aiModelInfo(modelId, dtype);
  if (!info) return null;
  const size = info.unknown ? '大小未知' : _aiFmtBytes(info.bytes);
  return `${modelId} · ${size} · ${info.cached ? '已快取，無須重新下載' : '尚未下載'}`;
}

/* 供各工具共用：非阻塞地把模型資訊寫進狀態列。
   查詢期間先顯示 fallback 文字，避免開啟對話框時空白。 */
function _aiShowModelInfo(tool, modelId, dtype, fallback) {
  if (fallback) tool._setStatus(fallback);
  _aiModelInfoText(modelId, dtype).then(text => {
    // 查詢是非同步的，期間使用者可能已改模型或開始執行 —— 只在仍然相關時才覆寫
    if (text && tool._infoToken === modelId + '|' + (dtype || '')) tool._setStatus(text);
  });
}

async function _loadOrt() {
  if (_inpOrt) return _inpOrt;
  _inpOrt = await import(ORT_CDN);
  // Point WASM files to the same CDN directory
  _inpOrt.env.wasm.wasmPaths = ORT_CDN.replace(/ort\.webgpu\.min\.mjs$/, '');
  return _inpOrt;
}

function _aiAddConfigRow(container, key = '', val = '', onReset) {
  const row = document.createElement('div');
  row.className = 'ai-config-row';

  const keyIn = document.createElement('input');
  keyIn.type = 'text'; keyIn.className = 'ai-config-key';
  keyIn.placeholder = 'key'; keyIn.value = key;

  const valIn = document.createElement('input');
  valIn.type = 'text'; valIn.className = 'ai-config-val';
  valIn.placeholder = 'JSON 值（true / 1024 / [0.5,0.5,0.5]）'; valIn.value = val;

  const del = document.createElement('button');
  del.className = 'ai-config-del'; del.textContent = '×'; del.title = '刪除';
  del.addEventListener('click', () => { row.remove(); if (onReset) onReset(); });

  row.append(keyIn, valIn, del);
  container.appendChild(row);
}

function _aiReadConfigRows(container) {
  const cfg = {};
  container.querySelectorAll('.ai-config-row').forEach(row => {
    const key = row.querySelector('.ai-config-key').value.trim();
    const raw = row.querySelector('.ai-config-val').value.trim();
    if (!key) return;
    try { cfg[key] = JSON.parse(raw); }
    catch { cfg[key] = raw; }
  });
  return cfg;
}

// Morphological dilation (amount>0) or erosion (amount<0) on a Float32Array mask
function _aiMorphMask(mask, w, h, amount) {
  const r = Math.round(Math.abs(amount));
  if (r === 0) return mask;
  const tmp    = new Float32Array(w * h);
  const dilate = amount > 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = dilate ? 0 : 1;
      for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const v = mask[ny * w + nx];
          best = dilate ? Math.max(best, v) : Math.min(best, v);
        }
      }
      tmp[y * w + x] = best;
    }
  }
  return tmp;
}

// Separable box-blur on a Float32Array mask (O(w×h) per pass)
function _aiBoxBlur(mask, w, h, fr) {
  fr = Math.round(fr);
  if (fr <= 0) return mask;
  // Horizontal pass
  const h1 = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let sum = 0, cnt = 0;
    const lim = Math.min(fr, w - 1);
    for (let x = 0; x <= lim; x++) { sum += mask[y * w + x]; cnt++; }
    for (let x = 0; x < w; x++) {
      h1[y * w + x] = sum / cnt;
      if (x - fr >= 0)    { sum -= mask[y * w + (x - fr)];     cnt--; }
      if (x + fr + 1 < w) { sum += mask[y * w + (x + fr + 1)]; cnt++; }
    }
  }
  // Vertical pass
  const h2 = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    let sum = 0, cnt = 0;
    const lim = Math.min(fr, h - 1);
    for (let y = 0; y <= lim; y++) { sum += h1[y * w + x]; cnt++; }
    for (let y = 0; y < h; y++) {
      h2[y * w + x] = sum / cnt;
      if (y - fr >= 0)    { sum -= h1[(y - fr) * w + x];     cnt--; }
      if (y + fr + 1 < h) { sum += h1[(y + fr + 1) * w + x]; cnt++; }
    }
  }
  return h2;
}

/* ════════════════════════════════════════════════════════
   AiRmbg — AI Background Removal (briaai/RMBG-1.4)
   ════════════════════════════════════════════════════════ */
const AiRmbg = {
  _model:              null,
  _processor:          null,
  _loaded:             false,
  _loading:            false,
  _loadedModelId:      null,
  _pendingTargetId:    null,   // layer.id of the image being processed
  _pendingMaskLayerId: null,   // layer.id of the editable mask layer
  _maskEditHistoryBase: -1,    // Hist.index at the moment mask edit mode was entered

  _getModelId() {
    return (document.getElementById('ai-model-id').value || RMBG_DEFAULT).trim();
  },

  _isCustomConfig() {
    return document.getElementById('ai-custom-config').checked;
  },

  _getProcessorConfig() {
    if (!this._isCustomConfig()) {
      return {
        do_normalize: true, do_pad: false, do_rescale: true, do_resize: true,
        image_mean: [0.5, 0.5, 0.5], image_std: [0.5, 0.5, 0.5],
        resample: 2, rescale_factor: 0.00392156862745098,
        size: { width: 1024, height: 1024 },
      };
    }
    return _aiReadConfigRows(document.getElementById('ai-config-rows'));
  },

  _resetModel() {
    this._model = null; this._processor = null;
    this._loaded = false; this._loadedModelId = null;
  },

  _populateDefaultConfig() {
    const defaults = {
      do_normalize: true, do_pad: false, do_rescale: true, do_resize: true,
      image_mean: [0.5, 0.5, 0.5], image_std: [0.5, 0.5, 0.5],
      resample: 2, rescale_factor: 0.00392156862745098,
      size: { width: 1024, height: 1024 },
    };
    const rows = document.getElementById('ai-config-rows');
    Object.entries(defaults).forEach(([k, v]) => {
      _aiAddConfigRow(rows, k, JSON.stringify(v), () => this._resetModel());
    });
  },

  init() {
    _makeDlgDraggable(document.getElementById('dlg-ai-rmbg'));
    document.getElementById('ai-run-btn').addEventListener('click', () => this._onRun());
    document.getElementById('ai-close-btn').addEventListener('click', () => {
      document.getElementById('dlg-ai-rmbg').classList.add('hidden');
    });
    document.getElementById('ai-confirm-btn').addEventListener('click', () => this._confirmApply());
    document.getElementById('ai-cancel-mask-btn').addEventListener('click', () => this._cancelMask());

    document.getElementById('ai-model-id').addEventListener('change', () => {
      const id = this._getModelId();
      if (id !== this._loadedModelId) {
        this._resetModel();
        this._refreshModelInfo();
      }
    });

    document.getElementById('ai-custom-config').addEventListener('change', e => {
      const custom = e.target.checked;
      document.getElementById('ai-mask-section').classList.toggle('hidden', custom);
      document.getElementById('ai-config-section').classList.toggle('hidden', !custom);
      if (custom && document.getElementById('ai-config-rows').children.length === 0) {
        this._populateDefaultConfig();
      }
      this._resetModel();
      this._setStatus(custom
        ? '自訂 Config 模式：調整後執行去背將重新載入 Processor'
        : `預設模式：${RMBG_DEFAULT}`);
    });

    document.getElementById('ai-config-rows').addEventListener('change', () => {
      this._resetModel();
    });

    document.getElementById('ai-config-add').addEventListener('click', () => {
      _aiAddConfigRow(
        document.getElementById('ai-config-rows'), '', '', () => this._resetModel()
      );
    });

    [
      ['ai-threshold', 'ai-threshold-num'],
      ['ai-feather',   'ai-feather-num'],
      ['ai-expand',    'ai-expand-num'],
    ].forEach(([rid, nid]) => {
      const r = document.getElementById(rid), n = document.getElementById(nid);
      r.addEventListener('input',  () => n.value = r.value);
      n.addEventListener('change', () => { r.value = n.value; });
    });

    this._refreshModelInfo();
  },

  // 顯示目前模型的下載大小與快取狀態
  _refreshModelInfo() {
    const id = this._getModelId();
    this._infoToken = id + '|' + RMBG_DTYPE;
    _aiShowModelInfo(this, id, RMBG_DTYPE, `模型：${id}（查詢大小中…）`);
  },

  open() {
    document.getElementById('dlg-ai-rmbg').classList.remove('hidden');
    if (!this._loaded) this._refreshModelInfo();
  },

  _setStatus(msg, isError = false) {
    const el = document.getElementById('ai-status');
    el.textContent = msg;
    el.style.color = isError ? 'var(--c-danger)' : 'var(--c-text-dim)';
  },

  _setProgress(pct) {
    const bar  = document.getElementById('ai-progress-bar');
    const fill = document.getElementById('ai-progress-fill');
    if (pct < 0) {
      bar.style.display = 'block';
      bar.classList.add('ai-indeterminate');
      fill.style.width = '100%';
    } else {
      bar.classList.remove('ai-indeterminate');
      bar.style.display = (pct > 0 && pct < 100) ? 'block' : 'none';
      fill.style.width  = pct + '%';
    }
  },

  async _ensureModel() {
    if (this._loaded)  return true;
    if (this._loading) return false;
    this._loading = true;
    document.getElementById('ai-run-btn').disabled = true;

    const modelId = this._getModelId();
    try {
      this._setStatus('載入 Transformers.js…');
      const { AutoModel, AutoProcessor } = await _aiLoadTf();

      this._setStatus(`下載模型 ${modelId}（首次需等待）…`);
      this._setProgress(5);

      const { obj: model, device } = await _aiLoadWithFallback(
        dev => AutoModel.from_pretrained(modelId, {
          config: { model_type: 'custom' },
          dtype: RMBG_DTYPE,
          device: dev,
          progress_callback: info => {
            if (info.status === 'progress') {
              this._setProgress(5 + info.progress * 0.85);
              this._setStatus(`下載模型… ${Math.round(info.progress)}%`);
            }
          }
        }),
        () => this._setStatus('WebGPU 不可用，改用 CPU 重新載入…')
      );
      this._model = model;

      this._setProgress(93);
      this._setStatus('載入處理器…');
      const procConfig = this._getProcessorConfig();
      this._processor = await AutoProcessor.from_pretrained(modelId, {
        config: Object.keys(procConfig).length > 0 ? procConfig : undefined,
      });

      this._loaded = true; this._loadedModelId = modelId;
      this._setProgress(0);
      this._setStatus(`✓ ${modelId} 載入完成（${device === 'webgpu' ? 'WebGPU' : 'CPU'}）`);
      return true;

    } catch (err) {
      this._setProgress(0);
      this._setStatus('載入失敗：' + err.message, true);
      console.error('[AiRmbg] load error:', err);
      return false;
    } finally {
      this._loading = false;
      document.getElementById('ai-run-btn').disabled = false;
    }
  },

  _getParams() {
    return {
      threshold: +document.getElementById('ai-threshold').value / 100,
      feather:   +document.getElementById('ai-feather').value,
      expand:    +document.getElementById('ai-expand').value,
    };
  },

  async _onRun() {
    if (this._pendingMaskLayerId !== null) {
      this._setStatus('請先確認或取消目前的遮罩編輯', true); return;
    }
    const layer = LayerMgr.active();
    if (!layer || layer.type === 'text' || layer.type === 'rmbg-mask') {
      this._setStatus('請先選取一個圖像圖層', true); return;
    }

    const ready = await this._ensureModel();
    if (!ready) return;

    document.getElementById('ai-run-btn').disabled = true;
    let entered = false;

    try {
      const { RawImage } = await _aiLoadTf();
      const src = layer.canvas;
      const w = src.width, h = src.height;

      this._setStatus('分析影像…');    this._setProgress(10); await _aiTick();
      const image = await RawImage.fromCanvas(src);

      this._setStatus('前處理…');      this._setProgress(25); await _aiTick();
      const { pixel_values } = await this._processor(image);

      this._setStatus('AI 推論中…');   this._setProgress(-1); await _aiTickRender();
      const { output } = await this._model({ input: pixel_values });

      this._setStatus('建立遮罩圖層…'); this._setProgress(80); await _aiTick();
      const rawMask = await RawImage
        .fromTensor(output[0].mul(255).to('uint8'))
        .resize(w, h);

      this._enterMaskEditMode(layer, rawMask, this._getParams());
      entered = true;

    } catch (err) {
      this._setProgress(0);
      this._setStatus('處理失敗：' + err.message, true);
      console.error('[AiRmbg] run error:', err);
    } finally {
      if (!entered) document.getElementById('ai-run-btn').disabled = false;
    }
  },

  // Switch between normal mode (run/close buttons) and mask-edit mode (confirm/cancel)
  _setEditMode(active) {
    const runBtn = document.getElementById('ai-run-btn');
    runBtn.style.display   = active ? 'none' : '';
    if (!active) runBtn.disabled = false;   // re-enable after confirm/cancel
    document.getElementById('ai-close-btn').style.display  = active ? 'none' : '';
    document.getElementById('ai-edit-section').classList.toggle('hidden', !active);
    document.getElementById('ai-mask-section').style.pointerEvents = active ? 'none' : '';
    document.getElementById('ai-model-id').disabled = active;
  },

  // After inference: create an editable grayscale mask layer instead of applying directly
  _enterMaskEditMode(targetLayer, rawMask, { threshold, feather, expand }) {
    const w = targetLayer.canvas.width, h = targetLayer.canvas.height;
    const src = rawMask.data;

    // Build float mask with threshold/expand/feather applied
    let mask = new Float32Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = src[i] / 255;
    mask = _aiMorphMask(mask, w, h, expand);
    mask = _aiBoxBlur(mask, w, h, feather);
    const t = threshold;
    const scale = t < 1 ? 1 / (1 - t) : 1;
    for (let i = 0; i < mask.length; i++) {
      const m = mask[i];
      mask[i] = m < t ? 0 : Math.min(1, (m - t) * scale);
    }

    // Create mask layer: white = keep, black = remove
    const maskLayer = new Layer('去背遮罩', w, h);
    maskLayer.type = 'rmbg-mask';
    maskLayer.opacity = 70;  // semi-transparent so original is visible underneath
    const imgData = maskLayer.ctx.createImageData(w, h);
    for (let i = 0; i < mask.length; i++) {
      const v = Math.round(mask[i] * 255);
      imgData.data[i * 4]     = v;
      imgData.data[i * 4 + 1] = v;
      imgData.data[i * 4 + 2] = v;
      imgData.data[i * 4 + 3] = 255;
    }
    maskLayer.ctx.putImageData(imgData, 0, 0);

    // Insert mask layer above target layer (lower array index = visually above)
    const targetIdx = App.layers.indexOf(targetLayer);
    App.layers.splice(targetIdx, 0, maskLayer);
    App.activeLayerIndex = targetIdx;  // select the mask layer

    this._maskEditHistoryBase = Hist.index;
    this._pendingTargetId    = targetLayer.id;
    this._pendingMaskLayerId = maskLayer.id;
    Hist.snapshot('建立去背遮罩');

    Engine.composite();
    UI.refreshLayerPanel();
    UI.updateLayerControls();

    this._setEditMode(true);
    this._setProgress(0);
    this._setStatus('遮罩已建立。用白色筆刷保留、黑色或橡皮擦移除，完成後確認套用');
  },

  // Apply the edited mask layer to the original image, then clean up
  _confirmApply() {
    const maskLayer   = App.layers.find(l => l.id === this._pendingMaskLayerId);
    const targetLayer = App.layers.find(l => l.id === this._pendingTargetId);
    if (!maskLayer || !targetLayer) {
      this._setEditMode(false);
      this._setStatus('找不到遮罩或目標圖層', true);
      return;
    }

    const histBase = this._maskEditHistoryBase;

    // Scale mask canvas to target size if they differ (shouldn't normally happen)
    const tw = targetLayer.canvas.width, th = targetLayer.canvas.height;
    let maskPx;
    if (maskLayer.canvas.width === tw && maskLayer.canvas.height === th) {
      maskPx = maskLayer.ctx.getImageData(0, 0, tw, th).data;
    } else {
      const tmp = document.createElement('canvas');
      tmp.width = tw; tmp.height = th;
      tmp.getContext('2d').drawImage(maskLayer.canvas, 0, 0, tw, th);
      maskPx = tmp.getContext('2d').getImageData(0, 0, tw, th).data;
    }

    // Apply mask R channel as alpha multiplier on target layer
    const imgData = targetLayer.ctx.getImageData(0, 0, tw, th);
    const d = imgData.data;
    for (let i = 0; i < tw * th; i++) {
      d[i * 4 + 3] = Math.round(d[i * 4 + 3] * maskPx[i * 4] / 255);
    }
    targetLayer.ctx.putImageData(imgData, 0, 0);

    // Remove mask layer
    const maskIdx = App.layers.indexOf(maskLayer);
    if (maskIdx >= 0) App.layers.splice(maskIdx, 1);
    App.activeLayerIndex = Math.max(0, Math.min(App.activeLayerIndex, App.layers.length - 1));

    this._clearMaskEditState();

    // Discard all mask-editing history, then record a single "after AI" state
    if (histBase >= 0) {
      Hist.stack.splice(histBase + 1);
      Hist.index = histBase;
    }
    Hist.snapshot('AI 去背');
    Engine.composite();
    UI.refreshLayerPanel();
    UI.updateLayerControls();

    this._setStatus('✓ 去背完成');
  },

  // Discard the mask layer and leave the original image unchanged
  _cancelMask() {
    const histBase = this._maskEditHistoryBase;
    const maskLayer = App.layers.find(l => l.id === this._pendingMaskLayerId);
    if (maskLayer) {
      const maskIdx = App.layers.indexOf(maskLayer);
      if (maskIdx >= 0) App.layers.splice(maskIdx, 1);
      App.activeLayerIndex = Math.max(0, Math.min(App.activeLayerIndex, App.layers.length - 1));
    }
    this._clearMaskEditState();

    // Discard all mask-editing history, leaving history at pre-mask state
    if (histBase >= 0) {
      Hist.stack.splice(histBase + 1);
      Hist.index = histBase;
      UI.refreshHistory();
    }

    Engine.composite();
    UI.refreshLayerPanel();
    UI.updateLayerControls();

    this._setStatus('已取消');
  },

  // Reset pending mask-edit state and exit edit UI mode
  _clearMaskEditState() {
    this._pendingTargetId    = null;
    this._pendingMaskLayerId = null;
    this._maskEditHistoryBase = -1;
    this._setEditMode(false);
  },

  _applyMask(layer, rawMask, { threshold, feather, expand }) {
    const w = layer.canvas.width, h = layer.canvas.height;
    const src = rawMask.data;

    let mask = new Float32Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = src[i] / 255;

    mask = _aiMorphMask(mask, w, h, expand);
    mask = _aiBoxBlur(mask, w, h, feather);

    const imgData = layer.ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const t = threshold;
    const scale = t < 1 ? 1 / (1 - t) : 1;
    for (let i = 0; i < mask.length; i++) {
      const m = mask[i];
      const alpha = m < t ? 0 : Math.min(1, (m - t) * scale);
      d[i * 4 + 3] = Math.round(alpha * d[i * 4 + 3]);
    }
    layer.ctx.putImageData(imgData, 0, 0);
  }
};

/* ════════════════════════════════════════════════════════
   AiInpaint — AI Object Removal
   Backend: onnxruntime-web + Carve/LaMa-ONNX (raw ONNX, no Transformers.js)
   Model spec:  input "image" [1,3,512,512] float32 0→1
                input "mask"  [1,1,512,512] float32 binary
                output "output" [1,3,512,512] float32 0→1
   Requires an active selection to mark the region to remove.
   ════════════════════════════════════════════════════════ */
const AiInpaint = {
  _session:       null,   // ort.InferenceSession
  _modelBuf:      null,   // ArrayBuffer — 切換執行後端時可重用，免得重讀 208 MB
  _loadedUrl:     null,   // _modelBuf 對應的權重 URL
  _loading:       false,
  _loadedModelId: null,

  _getModelId() {
    return (document.getElementById('inp-model-id').value || LAMA_DEFAULT).trim();
  },

  _resetSession() {
    this._session = null; this._loadedModelId = null;
    this._modelBuf = null; this._loadedUrl = null;
  },

  init() {
    _makeDlgDraggable(document.getElementById('dlg-ai-inpaint'));
    document.getElementById('inp-run-btn').addEventListener('click', () => this._onRun());
    document.getElementById('inp-close-btn').addEventListener('click', () => {
      document.getElementById('dlg-ai-inpaint').classList.add('hidden');
    });

    document.getElementById('inp-model-id').addEventListener('change', () => {
      this._resetSession();
      this._setStatus(`模型已切換至 ${this._getModelId()}，執行時將自動載入`);
    });

    document.getElementById('inp-adv-file').addEventListener('change', () => {
      this._resetSession();
      this._setStatus('ONNX 檔名已變更，執行時將重新載入模型');
    });

    [
      ['inp-dilate', 'inp-dilate-num'],
      ['inp-blend',  'inp-blend-num'],
    ].forEach(([rid, nid]) => {
      const r = document.getElementById(rid), n = document.getElementById(nid);
      r.addEventListener('input',  () => n.value = r.value);
      n.addEventListener('change', () => { r.value = n.value; });
    });

    this._setStatus(`預設模型：${LAMA_DEFAULT}（約 208 MB，首次需下載）`);
  },

  open() { document.getElementById('dlg-ai-inpaint').classList.remove('hidden'); },

  _setStatus(msg, isError = false) {
    const el = document.getElementById('inp-status');
    el.textContent = msg;
    el.style.color = isError ? 'var(--c-danger)' : 'var(--c-text-dim)';
  },

  _setProgress(pct) {
    const bar  = document.getElementById('inp-progress-bar');
    const fill = document.getElementById('inp-progress-fill');
    if (pct < 0) {
      bar.style.display = 'block';
      bar.classList.add('ai-indeterminate');
      fill.style.width = '100%';
    } else {
      bar.classList.remove('ai-indeterminate');
      bar.style.display = (pct > 0 && pct < 100) ? 'block' : 'none';
      fill.style.width  = pct + '%';
    }
  },

  // Resolve a HuggingFace model ID to the raw ONNX file URL.
  // onnxFile: override filename (null = use default)
  _modelUrl(modelId, onnxFile) {
    if (modelId === LAMA_DEFAULT) {
      return `https://huggingface.co/Carve/LaMa-ONNX/resolve/main/${onnxFile || LAMA_FILE}`;
    }
    return `https://huggingface.co/${modelId}/resolve/main/${onnxFile || 'model.onnx'}`;
  },

  async _ensureSession() {
    const modelId = this._getModelId();
    const adv = this._getAdvanced();
    const sessionKey = modelId + '|' + (adv.onnxFile || '') + '|' + (adv.forceWasm ? 'wasm' : 'gpu');
    if (this._session && this._loadedModelId === sessionKey) return true;
    if (this._loading) return false;
    this._loading = true;
    document.getElementById('inp-run-btn').disabled = true;

    try {
      this._setStatus('載入 ONNX Runtime…');
      const ort = await _loadOrt();

      const url = this._modelUrl(modelId, adv.onnxFile);

      // 只切換執行後端時 URL 不變，直接沿用記憶體中的權重
      if (!this._modelBuf || this._loadedUrl !== url) {
        this._setStatus(`下載模型 ${modelId}（首次需等待）…`);
        this._setProgress(3);
        this._modelBuf = await _aiFetchModelBuf(url, (ratio, fromCache) => {
          if (fromCache) {
            this._setProgress(85);
            this._setStatus('已從本機快取讀取模型');
          } else {
            this._setProgress(3 + ratio * 82);
            this._setStatus(`下載模型… ${Math.round(ratio * 100)}%`);
          }
        });
        this._loadedUrl = url;
      }

      this._setStatus('初始化 Session…');
      this._setProgress(88);
      await _aiTick();

      const { session, ep } = await _aiCreateOrtSession(
        ort, this._modelBuf, 'AiInpaint', adv.forceWasm
      );
      this._session = session;

      this._loadedModelId = sessionKey;
      this._setProgress(0);
      this._setStatus(`✓ ${modelId} 載入完成（${ep === 'webgpu' ? 'WebGPU' : 'CPU'}）`);
      return true;

    } catch (err) {
      this._setProgress(0);
      this._setStatus('載入失敗：' + err.message, true);
      console.error('[AiInpaint] load error:', err);
      return false;
    } finally {
      this._loading = false;
      document.getElementById('inp-run-btn').disabled = false;
    }
  },

  _getParams() {
    return {
      dilate: +document.getElementById('inp-dilate').value,
      blend:  +document.getElementById('inp-blend').value,
    };
  },

  _getAdvanced() {
    return {
      onnxFile:  document.getElementById('inp-adv-file').value.trim() || null,
      resolution: Math.min(2048, Math.max(64, +document.getElementById('inp-adv-res').value || 512)),
      imageName:  document.getElementById('inp-adv-img-name').value.trim() || 'image',
      maskName:   document.getElementById('inp-adv-mask-name').value.trim() || 'mask',
      forceWasm:  document.getElementById('inp-adv-force-wasm').checked,
    };
  },

  async _onRun() {
    if (Selection.empty()) {
      this._setStatus('請先建立選取區域，標記要移除的物體', true); return;
    }
    const layer = LayerMgr.active();
    if (!layer || layer.type === 'text') {
      this._setStatus('請先選取一個圖像圖層', true); return;
    }

    const ready = await this._ensureSession();
    if (!ready) return;

    document.getElementById('inp-run-btn').disabled = true;
    Hist.snapshot('AI 移除物體（前）');

    try {
      const ort = await _loadOrt();
      const { dilate, blend } = this._getParams();
      const adv = this._getAdvanced();
      const S = adv.resolution;

      const docW = App.docWidth;
      const docH = App.docHeight;

      // ── 1. Read selection mask (doc coords) & compute bounding box ──
      this._setStatus('準備遮罩…'); this._setProgress(10); await _aiTick();
      const selPx = Selection.getMaskCanvas()
        .getContext('2d').getImageData(0, 0, docW, docH).data;

      let bx1 = docW, by1 = docH, bx2 = -1, by2 = -1;
      for (let y = 0; y < docH; y++) {
        for (let x = 0; x < docW; x++) {
          if (selPx[(y * docW + x) * 4 + 3] > 0) {
            if (x < bx1) bx1 = x;
            if (x > bx2) bx2 = x;
            if (y < by1) by1 = y;
            if (y > by2) by2 = y;
          }
        }
      }

      // Expand bbox by PAD pixels to give LaMa surrounding context.
      // Without padding, a rectangular selection sends a 100%-masked tensor
      // with no reference pixels, causing LaMa to output uniform gray.
      const PAD = 64;
      const cx1 = Math.max(0, bx1 - PAD);
      const cy1 = Math.max(0, by1 - PAD);
      const cx2 = Math.min(docW, bx2 + 1 + PAD);
      const cy2 = Math.min(docH, by2 + 1 + PAD);
      const cw  = cx2 - cx1;
      const ch  = cy2 - cy1;

      // ── 2. Crop composite (all layers) to padded region ──
      Engine.composite();
      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = cw; cropCanvas.height = ch;
      cropCanvas.getContext('2d').drawImage(Engine.compCanvas, -cx1, -cy1);

      // ── 3. Build float mask for padded region (0 = context, 1 = inpaint) ──
      let floatMask = new Float32Array(cw * ch);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          floatMask[y * cw + x] = selPx[((cy1 + y) * docW + (cx1 + x)) * 4 + 3] / 255;
        }
      }
      if (dilate > 0) floatMask = _aiMorphMask(floatMask, cw, ch, dilate);

      // ── 4. Resize crop + mask to S×S ──
      this._setStatus('前處理…'); this._setProgress(25); await _aiTick();

      const imgS = document.createElement('canvas');
      imgS.width = imgS.height = S;
      imgS.getContext('2d').drawImage(cropCanvas, 0, 0, S, S);
      const imgPx = imgS.getContext('2d').getImageData(0, 0, S, S).data;

      const maskOrig = document.createElement('canvas');
      maskOrig.width = cw; maskOrig.height = ch;
      const moCtx = maskOrig.getContext('2d');
      const moData = moCtx.createImageData(cw, ch);
      for (let i = 0; i < floatMask.length; i++) {
        const v = Math.round(floatMask[i] * 255);
        moData.data[i * 4] = moData.data[i * 4 + 1] = moData.data[i * 4 + 2] = v;
        moData.data[i * 4 + 3] = 255;
      }
      moCtx.putImageData(moData, 0, 0);
      const maskS = document.createElement('canvas');
      maskS.width = maskS.height = S;
      maskS.getContext('2d').drawImage(maskOrig, 0, 0, S, S);
      const maskPx = maskS.getContext('2d').getImageData(0, 0, S, S).data;

      // ── 5. Build NCHW float32 tensors ──
      const imgFloat  = new Float32Array(3 * S * S);
      const maskFloat = new Float32Array(1 * S * S);
      for (let i = 0; i < S * S; i++) {
        imgFloat[0 * S * S + i] = imgPx[i * 4]     / 255;
        imgFloat[1 * S * S + i] = imgPx[i * 4 + 1] / 255;
        imgFloat[2 * S * S + i] = imgPx[i * 4 + 2] / 255;
        maskFloat[i]             = maskPx[i * 4] > 127 ? 1 : 0;
      }
      const imageTensor = new ort.Tensor('float32', imgFloat,  [1, 3, S, S]);
      const maskTensor  = new ort.Tensor('float32', maskFloat, [1, 1, S, S]);

      // ── 6. Run inference ──
      this._setStatus('AI 推論中…'); this._setProgress(-1); await _aiTickRender();
      const results = await this._session.run({ [adv.imageName]: imageTensor, [adv.maskName]: maskTensor });
      const outTensor = results.output ?? Object.values(results)[0];
      const outData   = outTensor.data; // Float32Array, NCHW [1,3,S,S]

      // ── 7. Convert tensor → canvas at S×S ──
      this._setStatus('套用結果…'); this._setProgress(85); await _aiTick();

      // Auto-detect output range: Carve/LaMa-ONNX outputs [0,255] float32.
      // Generic models may output [0,1]. Sample the max to decide.
      let maxVal = 0;
      for (let i = 0; i < outData.length; i++) if (outData[i] > maxVal) maxVal = outData[i];
      const outScale = maxVal > 2.0 ? 1 : 255;
      console.log('[AiInpaint] output max:', maxVal.toFixed(3), '  scale:', outScale);

      const outS = document.createElement('canvas');
      outS.width = outS.height = S;
      const outCtx  = outS.getContext('2d');
      const outImgD = outCtx.createImageData(S, S);
      for (let i = 0; i < S * S; i++) {
        outImgD.data[i * 4]     = Math.min(255, Math.max(0, Math.round(outData[0 * S * S + i] * outScale)));
        outImgD.data[i * 4 + 1] = Math.min(255, Math.max(0, Math.round(outData[1 * S * S + i] * outScale)));
        outImgD.data[i * 4 + 2] = Math.min(255, Math.max(0, Math.round(outData[2 * S * S + i] * outScale)));
        outImgD.data[i * 4 + 3] = 255;
      }
      outCtx.putImageData(outImgD, 0, 0);

      // Scale output from S×S back to padded crop size (cw×ch)
      const outBbox = document.createElement('canvas');
      outBbox.width = cw; outBbox.height = ch;
      outBbox.getContext('2d').drawImage(outS, 0, 0, cw, ch);
      const finalPx = outBbox.getContext('2d').getImageData(0, 0, cw, ch).data;

      // ── 8. Blend with feathering and apply only selected pixels to layer ──
      // blendMask = 0 for context (padding) area → _applyResult skips those pixels
      const blendMask = blend > 0 ? _aiBoxBlur(floatMask, cw, ch, blend) : floatMask;
      const cropX = cx1 - layer.x;
      const cropY = cy1 - layer.y;
      this._applyResult(layer, finalPx, blendMask, cw, ch, cropX, cropY);

      Hist.snapshot('AI 移除物體');
      Engine.composite();
      UI.refreshLayerPanel();

      this._setProgress(0); this._setStatus('✓ 完成');

    } catch (err) {
      this._setProgress(0);
      this._setStatus('處理失敗：' + err.message, true);
      console.error('[AiInpaint] run error:', err);
    } finally {
      document.getElementById('inp-run-btn').disabled = false;
    }
  },

  // Blend inpainted pixel data (bw×bh) into the layer.
  // cropX, cropY: offset of bbox top-left in layer-local coordinates.
  _applyResult(layer, inpaintedPx, blendMask, bw, bh, cropX, cropY) {
    const lw = layer.canvas.width, lh = layer.canvas.height;
    const imgData = layer.ctx.getImageData(0, 0, lw, lh);
    const d = imgData.data;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const lx = cropX + x;
        const ly = cropY + y;
        if (lx < 0 || lx >= lw || ly < 0 || ly >= lh) continue;
        const m = blendMask[y * bw + x];
        if (m === 0) continue;
        const p = (ly * lw + lx) * 4;
        const q = (y  * bw + x)  * 4;
        d[p]     = Math.round(d[p]     * (1 - m) + inpaintedPx[q]     * m);
        d[p + 1] = Math.round(d[p + 1] * (1 - m) + inpaintedPx[q + 1] * m);
        d[p + 2] = Math.round(d[p + 2] * (1 - m) + inpaintedPx[q + 2] * m);
      }
    }
    layer.ctx.putImageData(imgData, 0, 0);
  }
};

/* ════════════════════════════════════════════════════════
   AiUpsample — AI Super Resolution (Upsampling)
   Uses Transformers.js image-to-image pipeline
   Applies to the entire active layer — no selection needed
   Resizes all layers and the document canvas proportionally
   ════════════════════════════════════════════════════════ */
const AiUpsample = {
  _pipe:      null,
  _loading:   false,
  _loadedKey: null,   // modelId + '|' + dtype

  _getPresetId() { return document.getElementById('up-model-preset').value; },

  _getModelId() {
    const p = this._getPresetId();
    return p === 'custom' ? document.getElementById('up-model-id').value.trim() : p;
  },

  _getDtype() { return document.getElementById('up-dtype').value || 'fp32'; },

  _resetPipe() { this._pipe = null; this._loadedKey = null; },

  init() {
    _makeDlgDraggable(document.getElementById('dlg-ai-upsample'));
    document.getElementById('up-run-btn').addEventListener('click', () => this._onRun());
    document.getElementById('up-close-btn').addEventListener('click', () => {
      document.getElementById('dlg-ai-upsample').classList.add('hidden');
    });

    document.getElementById('up-model-preset').addEventListener('change', () => {
      const v = this._getPresetId();
      const isCustom = v === 'custom';
      document.getElementById('up-model-id').style.display = isCustom ? '' : 'none';
      this._resetPipe();
      if (isCustom) { this._infoToken = null; this._setStatus('請輸入自訂模型 ID'); return; }
      if (v.includes('swin2SR'))
        this._setStatus('Swin2SR 在 CPU 上較慢，建議搭配 fp16 精度或確保 WebGPU 可用');
      this._refreshModelInfo();
    });

    ['up-model-id', 'up-dtype'].forEach(id => {
      document.getElementById(id).addEventListener('change', () => {
        this._resetPipe();
        this._refreshModelInfo();
      });
    });

    document.getElementById('up-tile-size').addEventListener('change', e => {
      let v = parseInt(e.target.value) || 128;
      e.target.value = Math.min(512, Math.max(64, Math.round(v / 8) * 8));
    });

    this._refreshModelInfo();
  },

  // 顯示目前模型 + 精度組合的下載大小與快取狀態
  _refreshModelInfo() {
    const id = this._getModelId();
    if (!id) { this._infoToken = null; this._setStatus('請輸入自訂模型 ID'); return; }
    const dtype = this._getDtype();
    this._infoToken = id + '|' + dtype;
    _aiShowModelInfo(this, id, dtype, `模型：${id}（查詢大小中…）`);
  },

  open() {
    document.getElementById('dlg-ai-upsample').classList.remove('hidden');
    if (!this._pipe) this._refreshModelInfo();
  },

  _setStatus(msg, isError = false) {
    const el = document.getElementById('up-status');
    el.textContent = msg;
    el.style.color = isError ? 'var(--c-danger)' : 'var(--c-text-dim)';
  },

  _setProgress(pct) {
    const bar  = document.getElementById('up-progress-bar');
    const fill = document.getElementById('up-progress-fill');
    if (pct < 0) {
      bar.style.display = 'block';
      bar.classList.add('ai-indeterminate');
      fill.style.width = '100%';
    } else {
      bar.classList.remove('ai-indeterminate');
      bar.style.display = (pct > 0 && pct < 100) ? 'block' : 'none';
      fill.style.width  = pct + '%';
    }
  },

  // Convert Transformers.js RawImage → canvas (RGB only, alpha=255)
  _rawImageToCanvas(rawImg) {
    const W = rawImg.width, H = rawImg.height, ch = rawImg.channels;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const id  = ctx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      id.data[i*4]   = rawImg.data[i*ch];
      id.data[i*4+1] = rawImg.data[i*ch+1];
      id.data[i*4+2] = rawImg.data[i*ch+2];
      id.data[i*4+3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    return c;
  },

  // Tile-based SR inference：將圖切成 tileSize×tileSize 塊分別推論再拼回
  // overlap=25% 提供邊緣上下文，輸出時裁掉 halo 避免接縫
  async _runTiled(src, tileSize) {
    const { RawImage } = await _aiLoadTf();
    const W = src.width, H = src.height;
    const OVL = Math.round(tileSize / 4);  // halo overlap

    // 建立 tile 起始座標清單
    const xs = [], ys = [];
    for (let x = 0; x < W; x += tileSize) xs.push(x);
    for (let y = 0; y < H; y += tileSize) ys.push(y);
    const total = xs.length * ys.length;
    let done = 0;
    let outCanvas = null, outCtx = null, scale = null;

    for (const ty of ys) {
      for (const tx of xs) {
        // 含 halo 的輸入範圍（邊界 clamp）
        const x1 = Math.max(0, tx - OVL), y1 = Math.max(0, ty - OVL);
        const x2 = Math.min(W, tx + tileSize + OVL);
        const y2 = Math.min(H, ty + tileSize + OVL);
        const tc = document.createElement('canvas');
        tc.width = x2 - x1; tc.height = y2 - y1;
        tc.getContext('2d').drawImage(src, x1, y1, tc.width, tc.height, 0, 0, tc.width, tc.height);

        const tileOut = this._rawImageToCanvas(await this._pipe(await RawImage.fromCanvas(tc)));

        // 第一塊：根據輸入/輸出比例得知 scale，建立輸出畫布
        if (!scale) {
          scale = tileOut.width / tc.width;
          outCanvas = document.createElement('canvas');
          outCanvas.width  = Math.round(W * scale);
          outCanvas.height = Math.round(H * scale);
          outCtx = outCanvas.getContext('2d');
        }

        // 裁掉 halo，只取中心有效區域貼到輸出
        const sx = Math.round((tx - x1) * scale);
        const sy = Math.round((ty - y1) * scale);
        const sw = Math.round(Math.min(tileSize, W - tx) * scale);
        const sh = Math.round(Math.min(tileSize, H - ty) * scale);
        outCtx.drawImage(tileOut, sx, sy, sw, sh,
                         Math.round(tx * scale), Math.round(ty * scale), sw, sh);

        done++;
        this._setProgress(10 + (done / total) * 75);
        this._setStatus(`AI 推論中… ${done} / ${total} 塊`);
        await _aiTick();
      }
    }
    return outCanvas;
  },

  async _ensurePipe() {
    const modelId = this._getModelId();
    if (!modelId) { this._setStatus('請輸入模型 ID', true); return false; }
    const dtype = this._getDtype();
    const key   = modelId + '|' + dtype;
    if (this._pipe && this._loadedKey === key) return true;
    if (this._loading) return false;
    this._loading = true;
    document.getElementById('up-run-btn').disabled = true;

    try {
      this._setStatus('載入 Transformers.js…');
      const { pipeline } = await _aiLoadTf();

      this._setStatus(`下載模型 ${modelId}（首次需等待）…`);
      this._setProgress(5);

      const { obj: pipe, device } = await _aiLoadWithFallback(
        dev => {
          this._setStatus(`下載模型 ${modelId}（首次需等待，使用 ${dev}）…`);
          return pipeline('image-to-image', modelId, {
            dtype,
            device: dev,
            progress_callback: info => {
              if (info.status === 'progress') {
                this._setProgress(5 + info.progress * 0.88);
                this._setStatus(`下載模型… ${Math.round(info.progress)}%`);
              }
            },
          });
        },
        () => this._setStatus('WebGPU 不可用，改用 CPU 重新載入…')
      );
      this._pipe = pipe;

      this._loadedKey = key;
      this._setProgress(0);
      this._setStatus(`✓ ${modelId} 載入完成（${device === 'webgpu' ? 'WebGPU' : 'CPU'}）`);
      return true;

    } catch (err) {
      this._setProgress(0);
      this._setStatus('載入失敗：' + err.message, true);
      console.error('[AiUpsample] load error:', err);
      return false;
    } finally {
      this._loading = false;
      document.getElementById('up-run-btn').disabled = false;
    }
  },

  async _onRun() {
    const layer = LayerMgr.active();
    if (!layer || layer.type === 'text') {
      this._setStatus('請先選取一個圖像圖層', true); return;
    }

    const ready = await this._ensurePipe();
    if (!ready) return;

    document.getElementById('up-run-btn').disabled = true;
    Hist.snapshot('AI 放大（前）');

    try {
        const src   = layer.canvas;
      const origW = src.width, origH = src.height;

      // ── 1+2. Tile-based SR inference ──
      const tileSize = Math.min(512, Math.max(64, Math.round(
        (parseInt(document.getElementById('up-tile-size').value) || 128) / 8) * 8));
      this._setProgress(10); await _aiTickRender();
      const outCanvas = await this._runTiled(src, tileSize);
      const outW = outCanvas.width, outH = outCanvas.height;
      const outCtx = outCanvas.getContext('2d');

      // ── 3. Preserve original alpha channel (bilinear scale) ──
      const alphaCanvas = document.createElement('canvas');
      alphaCanvas.width = outW; alphaCanvas.height = outH;
      alphaCanvas.getContext('2d').drawImage(src, 0, 0, origW, origH, 0, 0, outW, outH);
      const alphaPx = alphaCanvas.getContext('2d').getImageData(0, 0, outW, outH).data;
      let hasAlpha = false;
      for (let i = 3; i < alphaPx.length; i += 4) { if (alphaPx[i] < 255) { hasAlpha = true; break; } }
      if (hasAlpha) {
        const finalD = outCtx.getImageData(0, 0, outW, outH);
        for (let i = 3; i < finalD.data.length; i += 4) finalD.data[i] = alphaPx[i];
        outCtx.putImageData(finalD, 0, 0);
      }

      // ── 4. Resize all other layers, replace active layer ──
      this._setStatus('套用結果…'); this._setProgress(95); await _aiTick();

      const scaleX  = outW / origW;
      const scaleY  = outH / origH;
      const newDocW = Math.round(App.docWidth  * scaleX);
      const newDocH = Math.round(App.docHeight * scaleY);

      App.layers.forEach(l => {
        if (l === layer) return;
        l.resize(Math.round(l.canvas.width * scaleX), Math.round(l.canvas.height * scaleY), 'bilinear');
        l.x = Math.round(l.x * scaleX);
        l.y = Math.round(l.y * scaleY);
      });

      const prevX = layer.x, prevY = layer.y;
      layer.canvas.width  = outW;
      layer.canvas.height = outH;
      layer.ctx = layer.canvas.getContext('2d');
      layer.ctx.drawImage(outCanvas, 0, 0);
      layer.x = Math.round(prevX * scaleX);
      layer.y = Math.round(prevY * scaleY);

      App.docWidth  = newDocW;
      App.docHeight = newDocH;
      Selection.init();
      Engine.resize(newDocW, newDocH);
      document.getElementById('st-size').textContent = `${newDocW}×${newDocH}`;

      Hist.snapshot('AI 放大');
      Engine.composite();
      UI.refreshLayerPanel();

      this._setProgress(0);
      this._setStatus(`✓ 完成（${origW}×${origH} → ${outW}×${outH}）`);

    } catch (err) {
      this._setProgress(0);
      this._setStatus('處理失敗：' + err.message, true);
      console.error('[AiUpsample] run error:', err);
    } finally {
      document.getElementById('up-run-btn').disabled = false;
    }
  },
};

/* ═══════════════════════════════════════════
   AiSam — Segment Anything（智慧選取）
   模型：Xenova/slimsam-77-uniform（預設）
   ═══════════════════════════════════════════ */
const SAM_DEFAULT = 'Xenova/slimsam-77-uniform';
const SAM_DTYPE   = 'fp32';

const AiSam = {
  _model:     null,
  _processor: null,
  _loaded:    false,
  _loading:   false,
  _points:    [],   // [{x, y, label}]  label: 1=正點, 0=負點

  init() {
    _makeDlgDraggable(document.getElementById('dlg-ai-sam'));
    document.getElementById('sam-close-btn').addEventListener('click', () => this._close());
    document.getElementById('sam-clear-btn').addEventListener('click', () => this._clearPoints());
    const fRange = document.getElementById('sam-feather');
    const fNum   = document.getElementById('sam-feather-num');
    fRange.addEventListener('input',  () => fNum.value   = fRange.value);
    fNum.addEventListener('change',   () => fRange.value = Math.max(0, Math.min(20, +fNum.value || 0)));

    document.getElementById('sam-model-id').addEventListener('change', () => {
      // 換模型後需重新載入，順便更新大小 / 快取顯示
      this._model = null; this._processor = null; this._loaded = false;
      this._refreshModelInfo();
    });

    this._refreshModelInfo();
  },

  _getModelId() {
    return document.getElementById('sam-model-id').value.trim() || SAM_DEFAULT;
  },

  _refreshModelInfo() {
    const id = this._getModelId();
    this._infoToken = id + '|' + SAM_DTYPE;
    _aiShowModelInfo(this, id, SAM_DTYPE, `模型：${id}（查詢大小中…）`);
  },

  open() {
    document.getElementById('dlg-ai-sam').classList.remove('hidden');
    if (!this._loaded && !this._loading) this._ensureModel();
  },

  _close() {
    document.getElementById('dlg-ai-sam').classList.add('hidden');
    this._clearPoints();
  },

  _clearPoints() {
    this._points = [];
    document.getElementById('sam-point-info').textContent = '';
    if (!this._loading) this._setStatus('點擊畫布以選取物件');
    Engine.drawOverlay();
  },

  _setStatus(msg, isError = false) {
    const el = document.getElementById('sam-status');
    el.textContent = msg;
    el.style.color = isError ? 'var(--c-danger)' : 'var(--c-text-dim)';
  },

  _setProgress(pct) {
    const bar  = document.getElementById('sam-progress-bar');
    const fill = document.getElementById('sam-progress-fill');
    if (pct < 0) {
      bar.style.display = 'block';
      fill.style.width  = '100%';
      bar.classList.add('ai-indeterminate');
    } else if (pct >= 100) {
      bar.style.display = 'none';
      bar.classList.remove('ai-indeterminate');
    } else {
      bar.style.display = 'block';
      bar.classList.remove('ai-indeterminate');
      fill.style.width = pct + '%';
    }
  },

  async _ensureModel() {
    if (this._loaded)  return true;
    if (this._loading) return false;
    this._loading = true;

    const modelId = this._getModelId();

    try {
      this._setStatus('載入 Transformers.js…');
      const { SamModel, AutoProcessor } = await _aiLoadTf();

      this._setStatus(`下載模型 ${modelId}（首次需等待）…`);
      this._setProgress(5);

      this._processor = await AutoProcessor.from_pretrained(modelId);

      this._setProgress(15);
      const { obj: model, device } = await _aiLoadWithFallback(
        dev => SamModel.from_pretrained(modelId, {
          dtype: SAM_DTYPE,
          device: dev,
          progress_callback: info => {
            if (info.status === 'progress') {
              this._setProgress(15 + info.progress * 0.83);
              this._setStatus(`下載模型… ${Math.round(info.progress)}%`);
            }
          },
        }),
        () => this._setStatus('WebGPU 不可用，改用 CPU 重新載入…')
      );
      this._model = model;

      this._loaded  = true;
      this._loading = false;
      this._setProgress(0);
      this._setStatus(`✓ 已就緒（${device === 'webgpu' ? 'WebGPU' : 'CPU'}）。點擊畫布選取物件`);
      return true;
    } catch (err) {
      this._loaded  = false;
      this._loading = false;
      this._setProgress(0);
      this._setStatus('模型載入失敗：' + err.message, true);
      console.error('[AiSam] load error:', err);
      return false;
    }
  },

  // addMode=false → 清除舊點（新選取）；addMode=true → 保留舊點（Shift/Alt 修飾）
  async runPoint(docX, docY, label, addMode = false) {
    if (!App.docWidth) return;

    if (!addMode) this._points = [];
    this._points.push({ x: docX, y: docY, label });
    Engine.drawOverlay();  // 立即顯示點標記

    if (!this._loaded) {
      const ok = await this._ensureModel();
      if (!ok) return;
    }

    const hasPosPoint = this._points.some(p => p.label === 1);
    if (!hasPosPoint) {
      this._setStatus('請先左鍵點擊要選取的物件');
      return;
    }

    this._setStatus('推理中...');
    this._setProgress(-1);
    await _aiTick();

    try {
      const { RawImage } = await _aiLoadTf();

      const rawImage     = await RawImage.fromCanvas(Engine.compCanvas);
      // input_points: [batch][queries][points][coords]  → 3 array nesting levels
      const input_points = [[ this._points.map(p => [p.x, p.y]) ]];
      // input_labels: [batch][queries][points]           → 3 array nesting levels
      const input_labels = [[ this._points.map(p => p.label) ]];

      const inputs  = await this._processor(rawImage, { input_points, input_labels });
      const outputs = await this._model(inputs);

      const masks = await this._processor.post_process_masks(
        outputs.pred_masks,
        inputs.original_sizes,
        inputs.reshaped_input_sizes,
      );

      // masks[0] 是單一 Tensor，dims 為 [1, 候選數, H, W]，不是候選陣列。
      // 先前誤用 masks[0].length（Tensor 沒有 length，恆為 undefined），
      // 導致 IoU 挑選整段被跳過而永遠取第 0 個候選 —— 而第 0 個候選通常是
      // 覆蓋幾乎整張圖的退化遮罩，選取結果因此幾乎等於全選。
      const maskTensor = masks[0];
      const numMasks   = maskTensor.dims[1];
      const scores     = outputs.iou_scores?.data;
      let bestIdx = 0;
      if (scores && numMasks > 1) {
        let best = -Infinity;
        for (let i = 0; i < Math.min(scores.length, numMasks); i++) {
          if (scores[i] > best) { best = scores[i]; bestIdx = i; }
        }
      }

      const W = App.docWidth, H = App.docHeight;
      // 所有候選連續存放，取出 bestIdx 那一段
      const allMaskData = maskTensor.data;   // Uint8Array, 值為 0 或 1
      const maskOffset  = bestIdx * W * H;
      const maskData    = allMaskData.subarray(maskOffset, maskOffset + W * H);
      const tmp = new Uint8Array(W * H);

      const feather = parseInt(document.getElementById('sam-feather').value) || 0;
      if (feather > 0) {
        // 將二值遮罩轉為 float，套用 box blur 羽化邊緣，再轉回 Uint8Array
        let floatMask = new Float32Array(W * H);
        for (let i = 0; i < floatMask.length; i++) floatMask[i] = maskData[i] ? 1 : 0;
        floatMask = _aiBoxBlur(floatMask, W, H, feather);
        for (let i = 0; i < tmp.length; i++) tmp[i] = Math.round(floatMask[i] * 255);
      } else {
        for (let i = 0; i < tmp.length; i++) tmp[i] = maskData[i] ? 255 : 0;
      }

      Selection._apply(tmp, 'new');
      Hist.snapshot('AI 智慧選取');

      let pixelCount = 0;
      for (let i = 0; i < tmp.length; i++) if (tmp[i]) pixelCount++;
      const posCount = this._points.filter(p => p.label === 1).length;
      const negCount = this._points.filter(p => p.label === 0).length;
      this._setStatus(`已選取 ${pixelCount.toLocaleString()} 像素`);
      document.getElementById('sam-point-info').textContent =
        `正點 ${posCount} 個　負點 ${negCount} 個`;
      this._setProgress(0);

    } catch (err) {
      this._setStatus('推理失敗：' + err.message, true);
      this._setProgress(0);
      console.error('[AiSam] inference error:', err);
    }
  },

  getPoints() { return this._points; },
};

/* ════════════════════════════════════════════════════════
   AiOutpaint — AI 擴展畫面 (Outpainting)
   Uses LaMa (Carve/LaMa-ONNX) to fill expanded canvas areas
   ════════════════════════════════════════════════════════ */
const OUTP_DEFAULT  = 'Carve/LaMa-ONNX';
const OUTP_FILE     = 'lama_fp32.onnx';

const AiOutpaint = {
  _session:       null,
  _loadedModelId: null,
  _modelBuf:      null,
  _loadedUrl:     null,   // _modelBuf 對應的權重 URL
  _loading:       false,
  _running:       false,

  init() {
    document.getElementById('outp-run-btn').addEventListener('click', () => this._onRun());
    document.getElementById('outp-close-btn').addEventListener('click', () => this._close());
    _makeDlgDraggable(document.getElementById('dlg-ai-outpaint'));
    this._setStatus(`預設模型：${OUTP_DEFAULT}（約 208 MB，首次需下載）`);

    // Clamp inputs to non-negative on user edit
    for (const id of ['outp-top', 'outp-bottom', 'outp-left', 'outp-right']) {
      document.getElementById(id).addEventListener('input', e => {
        if (parseInt(e.target.value) < 0) e.target.value = 0;
      });
    }
  },

  open() { document.getElementById('dlg-ai-outpaint').classList.remove('hidden'); },

  _close() { document.getElementById('dlg-ai-outpaint').classList.add('hidden'); },

  _setStatus(msg, isError = false) {
    const el = document.getElementById('outp-status');
    el.textContent = msg;
    el.style.color = isError ? 'var(--c-danger)' : 'var(--c-text-dim)';
  },

  _setProgress(pct) {
    const bar  = document.getElementById('outp-progress-bar');
    const fill = document.getElementById('outp-progress-fill');
    if (pct < 0) {
      bar.style.display = 'block';
      bar.classList.add('ai-indeterminate');
      fill.style.width = '100%';
    } else {
      bar.classList.remove('ai-indeterminate');
      bar.style.display = (pct > 0 && pct < 100) ? 'block' : 'none';
      fill.style.width  = pct + '%';
    }
  },

  _getModelId() {
    return document.getElementById('outp-model-id').value.trim() || OUTP_DEFAULT;
  },

  _modelUrl(modelId, onnxFile) {
    if (modelId === OUTP_DEFAULT) {
      return `https://huggingface.co/Carve/LaMa-ONNX/resolve/main/${onnxFile || OUTP_FILE}`;
    }
    return `https://huggingface.co/${modelId}/resolve/main/${onnxFile || 'model.onnx'}`;
  },

  async _ensureSession() {
    const modelId  = this._getModelId();
    const onnxFile  = document.getElementById('outp-adv-file').value.trim() || null;
    const forceWasm = document.getElementById('outp-adv-force-wasm').checked;
    const sessionKey = modelId + '|' + (onnxFile || '') + '|' + (forceWasm ? 'wasm' : 'gpu');
    if (this._session && this._loadedModelId === sessionKey) return true;
    if (this._loading) return false;
    this._loading = true;
    document.getElementById('outp-run-btn').disabled = true;

    try {
      this._setStatus('載入 ONNX Runtime…');
      const ort = await _loadOrt();

      const url = this._modelUrl(modelId, onnxFile);

      // 只切換執行後端時 URL 不變，直接沿用記憶體中的權重
      if (!this._modelBuf || this._loadedUrl !== url) {
        this._setStatus(`下載模型 ${modelId}（首次需等待）…`);
        this._setProgress(3);
        this._modelBuf = await _aiFetchModelBuf(url, (ratio, fromCache) => {
          if (fromCache) {
            this._setProgress(85);
            this._setStatus('已從本機快取讀取模型');
          } else {
            this._setProgress(3 + ratio * 82);
            this._setStatus(`下載模型… ${Math.round(ratio * 100)}%`);
          }
        });
        this._loadedUrl = url;
      }

      this._setStatus('初始化 Session…');
      this._setProgress(88);
      await _aiTick();

      const { session, ep } = await _aiCreateOrtSession(
        ort, this._modelBuf, 'AiOutpaint', forceWasm
      );
      this._session = session;

      this._loadedModelId = sessionKey;
      this._setProgress(0);
      this._setStatus(`✓ ${modelId} 載入完成（${ep === 'webgpu' ? 'WebGPU' : 'CPU'}）`);
      return true;

    } catch (err) {
      this._setProgress(0);
      this._setStatus('載入失敗：' + err.message, true);
      console.error('[AiOutpaint] load error:', err);
      return false;
    } finally {
      this._loading = false;
      document.getElementById('outp-run-btn').disabled = false;
    }
  },

  async _onRun() {
    if (this._running) return;

    const top    = Math.max(0, parseInt(document.getElementById('outp-top').value)    || 0);
    const bottom = Math.max(0, parseInt(document.getElementById('outp-bottom').value) || 0);
    const left   = Math.max(0, parseInt(document.getElementById('outp-left').value)   || 0);
    const right  = Math.max(0, parseInt(document.getElementById('outp-right').value)  || 0);

    if (top + bottom + left + right === 0) {
      this._setStatus('請至少在一個方向輸入擴展像素數', true); return;
    }

    this._setProgress(0); // reset bar state before starting
    const ready = await this._ensureSession();
    if (!ready) return;

    this._running = true;
    document.getElementById('outp-run-btn').disabled = true;
    Hist.snapshot('AI 擴展畫面（前）');

    try {
      const ort  = await _loadOrt();
      const S    = Math.min(2048, Math.max(64, parseInt(document.getElementById('outp-adv-res').value) || 512));
      const docW = App.docWidth;
      const docH = App.docHeight;
      const newW = docW + left + right;
      const newH = docH + top  + bottom;

      // ── 1. Build expanded composite canvas ──
      this._setStatus('合成畫面…'); this._setProgress(10); await _aiTick();

      // First composite all layers into compCanvas
      Engine.composite();
      const compCanvas = Engine.compCanvas;

      const expandedCanvas = document.createElement('canvas');
      expandedCanvas.width  = newW;
      expandedCanvas.height = newH;
      const expandedCtx = expandedCanvas.getContext('2d');
      // Draw original composite at (left, top) offset — new border areas remain empty (black)
      expandedCtx.drawImage(compCanvas, left, top);

      // ── 2. Build binary mask canvas (white = fill, black = keep) ──
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width  = newW;
      maskCanvas.height = newH;
      const maskCtx = maskCanvas.getContext('2d');
      maskCtx.fillStyle = 'white';
      maskCtx.fillRect(0, 0, newW, newH);             // all = fill
      maskCtx.clearRect(left, top, docW, docH);        // original area = keep (transparent = 0)

      // ── 3. Resize both to S×S and build float tensors ──
      this._setStatus('前處理…'); this._setProgress(25); await _aiTick();

      const imgS = document.createElement('canvas');
      imgS.width = imgS.height = S;
      imgS.getContext('2d').drawImage(expandedCanvas, 0, 0, S, S);
      const imgPx = imgS.getContext('2d').getImageData(0, 0, S, S).data;

      // Build mask image from maskCanvas (white = 255, black/transparent = 0)
      const maskS = document.createElement('canvas');
      maskS.width = maskS.height = S;
      const maskSCtx = maskS.getContext('2d');
      // Fill with black first, then draw white mask areas
      maskSCtx.fillStyle = 'black';
      maskSCtx.fillRect(0, 0, S, S);
      maskSCtx.drawImage(maskCanvas, 0, 0, S, S);
      const maskPx = maskSCtx.getImageData(0, 0, S, S).data;

      const imgFloat  = new Float32Array(3 * S * S);
      const maskFloat = new Float32Array(1 * S * S);
      for (let i = 0; i < S * S; i++) {
        imgFloat[0 * S * S + i] = imgPx[i * 4]     / 255;
        imgFloat[1 * S * S + i] = imgPx[i * 4 + 1] / 255;
        imgFloat[2 * S * S + i] = imgPx[i * 4 + 2] / 255;
        maskFloat[i]             = maskPx[i * 4] > 127 ? 1 : 0;
      }
      const imageTensor = new ort.Tensor('float32', imgFloat,  [1, 3, S, S]);
      const maskTensor  = new ort.Tensor('float32', maskFloat, [1, 1, S, S]);

      // ── 4. Run inference ──
      this._setStatus('AI 推論中…'); this._setProgress(-1); await _aiTickRender();
      const results = await this._session.run({ image: imageTensor, mask: maskTensor });
      const outTensor = results.output ?? Object.values(results)[0];
      const outData   = outTensor.data; // Float32Array, NCHW [1,3,S,S]

      // ── 5. Convert tensor → canvas S×S → scale to newW×newH ──
      this._setStatus('套用結果…'); this._setProgress(85); await _aiTick();

      let maxVal = 0;
      for (let i = 0; i < outData.length; i++) if (outData[i] > maxVal) maxVal = outData[i];
      const outScale = maxVal > 2.0 ? 1 : 255;
      console.log('[AiOutpaint] output max:', maxVal.toFixed(3), '  scale:', outScale);

      const outS = document.createElement('canvas');
      outS.width = outS.height = S;
      const outCtx  = outS.getContext('2d');
      const outImgD = outCtx.createImageData(S, S);
      for (let i = 0; i < S * S; i++) {
        outImgD.data[i * 4]     = Math.min(255, Math.max(0, Math.round(outData[0 * S * S + i] * outScale)));
        outImgD.data[i * 4 + 1] = Math.min(255, Math.max(0, Math.round(outData[1 * S * S + i] * outScale)));
        outImgD.data[i * 4 + 2] = Math.min(255, Math.max(0, Math.round(outData[2 * S * S + i] * outScale)));
        outImgD.data[i * 4 + 3] = 255;
      }
      outCtx.putImageData(outImgD, 0, 0);

      // Scale to full newW×newH
      const aiResult = document.createElement('canvas');
      aiResult.width  = newW;
      aiResult.height = newH;
      aiResult.getContext('2d').drawImage(outS, 0, 0, newW, newH);

      // ── 6. Apply to document ──
      this._setStatus('更新文件…'); this._setProgress(95); await _aiTick();

      // Offset all existing layers by (left, top)
      for (const l of App.layers) {
        l.x += left;
        l.y += top;
      }

      // Update doc dimensions
      App.docWidth  = newW;
      App.docHeight = newH;
      Selection.init();
      Engine.resize(newW, newH);

      // Create new bottom layer with AI-filled content
      // In App.layers[], index 0 = topmost, length-1 = bottom, so push() = new bottom
      const newLayer = new Layer('AI 擴展', newW, newH);
      newLayer.x = 0;
      newLayer.y = 0;
      const nlCtx = newLayer.ctx;

      // Draw the full AI result
      nlCtx.drawImage(aiResult, 0, 0);

      // Cut out the original image area so existing layers show through (no double compositing)
      nlCtx.globalCompositeOperation = 'destination-out';
      nlCtx.fillStyle = 'white';
      nlCtx.fillRect(left, top, docW, docH);
      nlCtx.globalCompositeOperation = 'source-over';

      App.layers.push(newLayer);
      // activeLayerIndex stays as-is (existing layers shifted up in visual stack,
      // index still points to same object)

      Engine.composite();
      UI.refreshLayerPanel();

      // Update status bar size display
      const stSize = document.getElementById('st-size');
      if (stSize) stSize.textContent = `${newW} × ${newH}`;

      Hist.snapshot('AI 擴展畫面');
      this._setProgress(0);
      this._setStatus('✓ 完成');

    } catch (err) {
      this._setProgress(0);
      this._setStatus('處理失敗：' + err.message, true);
      console.error('[AiOutpaint] run error:', err);
    } finally {
      this._running = false;
      document.getElementById('outp-run-btn').disabled = false;
    }
  },
};

/* ═══════════════════════════════════════════
   AiDepth — AI 景深（深度估計）
   模型：onnx-community/depth-anything-v2-small（fp16 約 47 MB）
   兩種用途共用同一次深度推論：
     1. 景深模糊：依深度逐像素改變模糊半徑，模擬大光圈
     2. 依深度選取：把指定深度區間轉成選取範圍
   深度圖跑在 Engine.compCanvas（文件尺寸），與 Selection 對齊；
   套用模糊時再依圖層的 x/y 偏移取值。
   ═══════════════════════════════════════════ */
const DEPTH_DEFAULT = 'onnx-community/depth-anything-v2-small';
const DEPTH_DTYPE   = 'fp16';
const DEPTH_LEVELS  = 5;   // 模糊層級數（含原圖），越多越平滑但越耗時

const AiDepth = {
  _pipe:      null,
  _loading:   false,
  _loadedKey: null,
  _depth:     null,   // Uint8Array，長度 docW*docH，0=最遠 255=最近
  _depthW:    0,
  _depthH:    0,

  _getModelId() {
    return (document.getElementById('dep-model-id').value || DEPTH_DEFAULT).trim();
  },

  _resetPipe() { this._pipe = null; this._loadedKey = null; },

  _resetDepth() {
    this._depth = null; this._depthW = 0; this._depthH = 0;
    this._setActionsEnabled(false);
  },

  init() {
    _makeDlgDraggable(document.getElementById('dlg-ai-depth'));
    document.getElementById('dep-analyze-btn').addEventListener('click', () => this._onAnalyze());
    document.getElementById('dep-blur-btn').addEventListener('click',    () => this._onBlur());
    document.getElementById('dep-select-btn').addEventListener('click',  () => this._onSelect());
    document.getElementById('dep-close-btn').addEventListener('click', () => {
      document.getElementById('dlg-ai-depth').classList.add('hidden');
    });

    document.getElementById('dep-model-id').addEventListener('change', () => {
      this._resetPipe(); this._resetDepth(); this._refreshModelInfo();
    });

    [
      ['dep-focus',   'dep-focus-num'],
      ['dep-blur',    'dep-blur-num'],
      ['dep-range',   'dep-range-num'],
      ['dep-min',     'dep-min-num'],
      ['dep-max',     'dep-max-num'],
      ['dep-feather', 'dep-feather-num'],
    ].forEach(([rid, nid]) => {
      const r = document.getElementById(rid), n = document.getElementById(nid);
      r.addEventListener('input',  () => n.value = r.value);
      n.addEventListener('change', () => { r.value = n.value; });
    });

    this._setActionsEnabled(false);
    this._refreshModelInfo();
  },

  _refreshModelInfo() {
    const id = this._getModelId();
    this._infoToken = id + '|' + DEPTH_DTYPE;
    _aiShowModelInfo(this, id, DEPTH_DTYPE, `模型：${id}（查詢大小中…）`);
  },

  // 同步更新滑桿與旁邊的數字輸入框
  _setSlider(id, val) {
    document.getElementById(id).value = val;
    const num = document.getElementById(id + '-num');
    if (num) num.value = val;
  },

  open() {
    document.getElementById('dlg-ai-depth').classList.remove('hidden');
    if (!this._pipe) this._refreshModelInfo();
  },

  // 深度圖尚未產生前，兩個套用按鈕都不可按
  _setActionsEnabled(on) {
    document.getElementById('dep-blur-btn').disabled   = !on;
    document.getElementById('dep-select-btn').disabled = !on;
    document.getElementById('dep-actions').classList.toggle('ai-disabled', !on);
  },

  _setStatus(msg, isError = false) {
    const el = document.getElementById('dep-status');
    el.textContent = msg;
    el.style.color = isError ? 'var(--c-danger)' : 'var(--c-text-dim)';
  },

  _setProgress(pct) {
    const bar  = document.getElementById('dep-progress-bar');
    const fill = document.getElementById('dep-progress-fill');
    if (pct < 0) {
      bar.style.display = 'block';
      bar.classList.add('ai-indeterminate');
      fill.style.width = '100%';
    } else {
      bar.classList.remove('ai-indeterminate');
      bar.style.display = (pct > 0 && pct < 100) ? 'block' : 'none';
      fill.style.width  = pct + '%';
    }
  },

  async _ensurePipe() {
    const modelId = this._getModelId();
    const key = modelId + '|' + DEPTH_DTYPE;
    if (this._pipe && this._loadedKey === key) return true;
    if (this._loading) return false;
    this._loading = true;
    document.getElementById('dep-analyze-btn').disabled = true;

    try {
      const { pipeline } = await _aiLoadTf();
      this._setStatus(`下載模型 ${modelId}（首次需等待）…`);
      this._setProgress(5);

      const { obj: pipe, device } = await _aiLoadWithFallback(
        dev => pipeline('depth-estimation', modelId, {
          dtype: DEPTH_DTYPE,
          device: dev,
          progress_callback: info => {
            if (info.status === 'progress') {
              this._setProgress(5 + info.progress * 0.88);
              this._setStatus(`下載模型… ${Math.round(info.progress)}%`);
            }
          },
        }),
        () => this._setStatus('WebGPU 不可用，改用 CPU 重新載入…')
      );
      this._pipe = pipe;
      this._loadedKey = key;
      this._setProgress(0);
      this._setStatus(`✓ ${modelId} 載入完成（${device === 'webgpu' ? 'WebGPU' : 'CPU'}）`);
      return true;

    } catch (err) {
      this._setProgress(0);
      this._setStatus('載入失敗：' + err.message, true);
      console.error('[AiDepth] load error:', err);
      return false;
    } finally {
      this._loading = false;
      document.getElementById('dep-analyze-btn').disabled = false;
    }
  },

  /* 對目前合成畫面做一次深度推論並快取，兩種套用共用這份結果。 */
  async _onAnalyze() {
    if (!App.docWidth) { this._setStatus('請先開啟或建立影像', true); return; }
    const ready = await this._ensurePipe();
    if (!ready) return;

    document.getElementById('dep-analyze-btn').disabled = true;
    try {
      const { RawImage } = await _aiLoadTf();
      const W = App.docWidth, H = App.docHeight;

      this._setStatus('分析深度中…');
      this._setProgress(-1);
      await _aiTickRender();

      const out = await this._pipe(await RawImage.fromCanvas(Engine.compCanvas));
      let depthImg = out.depth;

      // 保險：模型內部會縮放，若回傳尺寸與文件不符則縮回來
      if (depthImg.width !== W || depthImg.height !== H) {
        depthImg = await depthImg.resize(W, H);
      }

      const ch = depthImg.channels, src = depthImg.data;
      const d  = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) d[i] = src[i * ch];
      this._depth = d; this._depthW = W; this._depthH = H;

      // 回報深度分布，讓使用者知道對焦滑桿該往哪調
      let min = 255, max = 0, sum = 0;
      for (let i = 0; i < d.length; i++) {
        const v = d[i];
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }

      // 每張圖的深度尺度都不同，固定預設值幾乎一定是錯的。
      // 取畫面中央一小塊的中位數當對焦深度（相機的中央對焦邏輯），
      // 並把選取區間預設為「比中央更近」的範圍。
      const cx0 = Math.max(0, (W >> 1) - 8), cy0 = Math.max(0, (H >> 1) - 8);
      const samples = [];
      for (let y = cy0; y < Math.min(H, cy0 + 16); y++)
        for (let x = cx0; x < Math.min(W, cx0 + 16); x++) samples.push(d[y * W + x]);
      samples.sort((a, b) => a - b);
      const centerDepth = samples[samples.length >> 1];
      this._setSlider('dep-focus', centerDepth);
      this._setSlider('dep-min',   Math.max(0, centerDepth - 40));
      this._setSlider('dep-max',   255);

      this._setProgress(0);
      this._setActionsEnabled(true);
      this._setStatus(`✓ 深度分析完成（範圍 ${min}–${max}，平均 ${Math.round(sum / d.length)}；`
                    + `已將對焦深度設為畫面中央的 ${centerDepth}。數值越大越近）`);

    } catch (err) {
      this._setProgress(0);
      this._setStatus('分析失敗：' + err.message, true);
      console.error('[AiDepth] analyze error:', err);
    } finally {
      document.getElementById('dep-analyze-btn').disabled = false;
    }
  },

  /* 把來源畫到一張四周留白的畫布上，並將最外圈像素往外拉伸填滿留白。
     canvas filter 的模糊會把畫布外的透明像素一起算進來，若不先做邊緣延伸，
     模糊後四邊會出現淡出的暗角。 */
  _padWithEdgeClamp(src, W, H, pad) {
    const c = document.createElement('canvas');
    c.width = W + pad * 2; c.height = H + pad * 2;
    const cx = c.getContext('2d');
    // 四角
    cx.drawImage(src, 0,   0,   1, 1, 0,       0,       pad, pad);
    cx.drawImage(src, W-1, 0,   1, 1, pad + W, 0,       pad, pad);
    cx.drawImage(src, 0,   H-1, 1, 1, 0,       pad + H, pad, pad);
    cx.drawImage(src, W-1, H-1, 1, 1, pad + W, pad + H, pad, pad);
    // 四邊
    cx.drawImage(src, 0,   0,   W, 1, pad,     0,       W,   pad);
    cx.drawImage(src, 0,   H-1, W, 1, pad,     pad + H, W,   pad);
    cx.drawImage(src, 0,   0,   1, H, 0,       pad,     pad, H);
    cx.drawImage(src, W-1, 0,   1, H, pad + W, pad,     pad, H);
    // 中央
    cx.drawImage(src, pad, pad);
    return c;
  },

  /* 產生多階模糊版本。用 canvas filter 交給瀏覽器做高斯模糊，
     比在 JS 裡跑 convolution 快非常多（大圖差距可到數十倍）。 */
  _buildBlurLevels(srcCanvas, W, H, maxRadius) {
    const pad    = Math.ceil(maxRadius * 2) + 2;
    const padded = this._padWithEdgeClamp(srcCanvas, W, H, pad);
    const levels = [];
    for (let k = 0; k < DEPTH_LEVELS; k++) {
      const r = maxRadius * k / (DEPTH_LEVELS - 1);
      const c = document.createElement('canvas');
      c.width = W + pad * 2; c.height = H + pad * 2;
      const cx = c.getContext('2d');
      if (r >= 0.3) cx.filter = `blur(${r}px)`;
      cx.drawImage(padded, 0, 0);
      levels.push(cx.getImageData(pad, pad, W, H).data);   // 裁掉留白
    }
    return levels;
  },

  async _onBlur() {
    if (!this._depth) { this._setStatus('請先執行深度分析', true); return; }
    const layer = LayerMgr.active();
    if (!layer || layer.type === 'text') { this._setStatus('請先選取一個圖像圖層', true); return; }

    const focus     = +document.getElementById('dep-focus').value;   // 0–255 對焦深度
    const maxRadius = +document.getElementById('dep-blur').value;    // px
    const range     = +document.getElementById('dep-range').value;   // 景深範圍 1–100
    if (maxRadius <= 0) { this._setStatus('模糊強度需大於 0', true); return; }

    document.getElementById('dep-blur-btn').disabled = true;
    try {
      this._setStatus('建立模糊層級…');
      this._setProgress(-1);
      await _aiTickRender();

      const W = layer.canvas.width, H = layer.canvas.height;
      const levels = this._buildBlurLevels(layer.canvas, W, H, maxRadius);

      this._setStatus('依深度合成…');
      await _aiTick();

      const outImg = layer.ctx.createImageData(W, H);
      const o = outImg.data;
      const dep = this._depth, dW = this._depthW, dH = this._depthH;
      // 圖層可能有偏移，換算到文件座標才取得到對應的深度值
      const offX = layer.x | 0, offY = layer.y | 0;
      // range 越小，離對焦面一點點就糊掉（淺景深）
      const falloff = 255 / Math.max(1, range);

      for (let y = 0; y < H; y++) {
        const dy = Math.min(dH - 1, Math.max(0, y + offY));
        for (let x = 0; x < W; x++) {
          const dx = Math.min(dW - 1, Math.max(0, x + offX));
          const t  = Math.min(1, Math.abs(dep[dy * dW + dx] - focus) * falloff / 255);
          const pos = t * (DEPTH_LEVELS - 1);
          const k0  = Math.floor(pos);
          const k1  = Math.min(DEPTH_LEVELS - 1, k0 + 1);
          const f   = pos - k0;
          const a = levels[k0], b = levels[k1];
          const i = (y * W + x) * 4;
          o[i]     = a[i]     + (b[i]     - a[i])     * f;
          o[i + 1] = a[i + 1] + (b[i + 1] - a[i + 1]) * f;
          o[i + 2] = a[i + 2] + (b[i + 2] - a[i + 2]) * f;
          o[i + 3] = a[i + 3] + (b[i + 3] - a[i + 3]) * f;
        }
        if ((y & 63) === 0) { this._setProgress(10 + (y / H) * 85); await _aiTick(); }
      }

      layer.ctx.putImageData(outImg, 0, 0);
      Hist.snapshot('AI 景深模糊');
      Engine.composite();
      this._setProgress(0);
      this._setStatus(`✓ 景深模糊完成（對焦 ${focus}，最大 ${maxRadius}px）`);

    } catch (err) {
      this._setProgress(0);
      this._setStatus('模糊失敗：' + err.message, true);
      console.error('[AiDepth] blur error:', err);
    } finally {
      document.getElementById('dep-blur-btn').disabled = false;
    }
  },

  async _onSelect() {
    if (!this._depth) { this._setStatus('請先執行深度分析', true); return; }

    let lo = +document.getElementById('dep-min').value;
    let hi = +document.getElementById('dep-max').value;
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    const feather = +document.getElementById('dep-feather').value;

    try {
      const W = App.docWidth, H = App.docHeight;
      const dep = this._depth;
      const tmp = new Uint8Array(W * H);

      if (feather > 0) {
        const f = new Float32Array(W * H);
        for (let i = 0; i < f.length; i++) f[i] = (dep[i] >= lo && dep[i] <= hi) ? 1 : 0;
        const blurred = _aiBoxBlur(f, W, H, feather);
        for (let i = 0; i < tmp.length; i++) tmp[i] = Math.round(blurred[i] * 255);
      } else {
        for (let i = 0; i < tmp.length; i++) tmp[i] = (dep[i] >= lo && dep[i] <= hi) ? 255 : 0;
      }

      let count = 0;
      for (let i = 0; i < tmp.length; i++) if (tmp[i] > 127) count++;
      if (count === 0) {
        this._setStatus('此深度區間沒有任何像素，請調整範圍', true);
        return;
      }

      Selection._apply(tmp, 'new');
      Hist.snapshot('AI 深度選取');
      this._setStatus(`✓ 已選取 ${count.toLocaleString()} 像素（深度 ${lo}–${hi}）`);

    } catch (err) {
      this._setStatus('選取失敗：' + err.message, true);
      console.error('[AiDepth] select error:', err);
    }
  },
};
