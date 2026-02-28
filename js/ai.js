'use strict';
/* ═══════════════════════════════════════════════════════
   ai.js — AI Tools
   AiRmbg    : Transformers.js + briaai/RMBG-1.4
   AiInpaint : onnxruntime-web + Carve/LaMa-ONNX (direct ONNX)
   AiUpsample: Transformers.js image-to-image pipeline
   ═══════════════════════════════════════════════════════ */

const AI_CDN       = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';
const ORT_CDN      = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1/dist/ort.min.mjs';
const RMBG_DEFAULT = 'briaai/RMBG-1.4';
const LAMA_DEFAULT = 'Carve/LaMa-ONNX';
const LAMA_FILE    = 'lama_fp32.onnx'; // 208 MB, fixed 512×512 input


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
// Prefer WebGPU > WebGL; fall back to 'cpu' (WASM) if neither available
const _aiDevice = () => (typeof navigator !== 'undefined' && navigator.gpu) ? 'webgpu' : 'cpu';


async function _aiLoadTf() {
  if (!_aiTf) _aiTf = await import(AI_CDN);
  return _aiTf;
}

async function _loadOrt() {
  if (_inpOrt) return _inpOrt;
  _inpOrt = await import(ORT_CDN);
  // Point WASM files to the same CDN directory
  _inpOrt.env.wasm.wasmPaths = ORT_CDN.replace(/ort\.min\.mjs$/, '');
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
        this._setStatus(`模型已切換至 ${id}，執行時將自動載入`);
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

    this._setStatus(`預設模型：${RMBG_DEFAULT}，執行時自動下載`);
  },

  open() { document.getElementById('dlg-ai-rmbg').classList.remove('hidden'); },

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
      const { AutoModel, AutoProcessor, env } = await _aiLoadTf();
      env.allowLocalModels = false;

      this._setStatus(`下載模型 ${modelId}（首次需等待）…`);
      this._setProgress(5);

      const device = _aiDevice();
      this._model = await AutoModel.from_pretrained(modelId, {
        config: { model_type: 'custom' },
        device,
        progress_callback: info => {
          if (info.status === 'progress') {
            this._setProgress(5 + info.progress * 0.85);
            this._setStatus(`下載模型… ${Math.round(info.progress)}%`);
          }
        }
      });

      this._setProgress(93);
      this._setStatus('載入處理器…');
      const procConfig = this._getProcessorConfig();
      this._processor = await AutoProcessor.from_pretrained(modelId, {
        config: Object.keys(procConfig).length > 0 ? procConfig : undefined,
      });

      this._loaded = true; this._loadedModelId = modelId;
      this._setProgress(0); this._setStatus(`✓ ${modelId} 載入完成`);
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

    this._pendingTargetId    = targetLayer.id;
    this._pendingMaskLayerId = maskLayer.id;

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

    Hist.snapshot('AI 去背（前）');

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

    this._pendingTargetId    = null;
    this._pendingMaskLayerId = null;

    Hist.snapshot('AI 去背');
    Engine.composite();
    UI.refreshLayerPanel();
    UI.updateLayerControls();

    this._setEditMode(false);
    this._setStatus('✓ 去背完成');
  },

  // Discard the mask layer and leave the original image unchanged
  _cancelMask() {
    const maskLayer = App.layers.find(l => l.id === this._pendingMaskLayerId);
    if (maskLayer) {
      const maskIdx = App.layers.indexOf(maskLayer);
      if (maskIdx >= 0) App.layers.splice(maskIdx, 1);
      App.activeLayerIndex = Math.max(0, Math.min(App.activeLayerIndex, App.layers.length - 1));
    }
    this._pendingTargetId    = null;
    this._pendingMaskLayerId = null;

    Engine.composite();
    UI.refreshLayerPanel();
    UI.updateLayerControls();

    this._setEditMode(false);
    this._setStatus('已取消');
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
  _modelBuf:      null,   // ArrayBuffer — kept for GPU→CPU fallback
  _loading:       false,
  _loadedModelId: null,

  _getModelId() {
    return (document.getElementById('inp-model-id').value || LAMA_DEFAULT).trim();
  },

  _resetSession() {
    this._session = null; this._loadedModelId = null; this._modelBuf = null;
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
    const sessionKey = modelId + '|' + (adv.onnxFile || '');
    if (this._session && this._loadedModelId === sessionKey) return true;
    if (this._loading) return false;
    this._loading = true;
    document.getElementById('inp-run-btn').disabled = true;

    try {
      this._setStatus('載入 ONNX Runtime…');
      const ort = await _loadOrt();

      const url = this._modelUrl(modelId, adv.onnxFile);
      this._setStatus(`下載模型 ${modelId}（首次需等待）…`);
      this._setProgress(3);

      // Fetch with download-progress tracking
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
        if (total) {
          this._setProgress(3 + (received / total) * 82);
          this._setStatus(`下載模型… ${Math.round(received / total * 100)}%`);
        }
      }

      this._setStatus('初始化 Session…');
      this._setProgress(88);
      await _aiTick();

      this._modelBuf = await new Blob(chunks).arrayBuffer();
      this._session = await ort.InferenceSession.create(this._modelBuf, {
        executionProviders: ['wasm'],
      });

      this._loadedModelId = sessionKey;
      this._setProgress(0);
      this._setStatus(`✓ ${modelId} 載入完成`);
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
      resolution: +document.getElementById('inp-adv-res').value || 512,
      imageName:  document.getElementById('inp-adv-img-name').value.trim() || 'image',
      maskName:   document.getElementById('inp-adv-mask-name').value.trim() || 'mask',
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
      const bw = bx2 - bx1 + 1;
      const bh = by2 - by1 + 1;

      // Offset of bbox top-left in layer-local coordinates
      const cropX = bx1 - layer.x;
      const cropY = by1 - layer.y;

      // ── 2. Crop layer canvas to bounding box region ──
      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = bw; cropCanvas.height = bh;
      cropCanvas.getContext('2d').drawImage(layer.canvas, -cropX, -cropY);

      // ── 3. Build float mask for the bounding box region ──
      let floatMask = new Float32Array(bw * bh);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          floatMask[y * bw + x] = selPx[((by1 + y) * docW + (bx1 + x)) * 4 + 3] / 255;
        }
      }
      if (dilate > 0) floatMask = _aiMorphMask(floatMask, bw, bh, dilate);

      // ── 4. Resize crop + mask to S×S ──
      this._setStatus('前處理…'); this._setProgress(25); await _aiTick();

      const imgS = document.createElement('canvas');
      imgS.width = imgS.height = S;
      imgS.getContext('2d').drawImage(cropCanvas, 0, 0, S, S);
      const imgPx = imgS.getContext('2d').getImageData(0, 0, S, S).data;

      const maskOrig = document.createElement('canvas');
      maskOrig.width = bw; maskOrig.height = bh;
      const moCtx = maskOrig.getContext('2d');
      const moData = moCtx.createImageData(bw, bh);
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

      // Scale output from S×S back to bounding box size (bw×bh)
      const outBbox = document.createElement('canvas');
      outBbox.width = bw; outBbox.height = bh;
      outBbox.getContext('2d').drawImage(outS, 0, 0, bw, bh);
      const finalPx = outBbox.getContext('2d').getImageData(0, 0, bw, bh).data;

      // ── 8. Blend with feathering and apply to layer ──
      const blendMask = blend > 0 ? _aiBoxBlur(floatMask, bw, bh, blend) : floatMask;
      this._applyResult(layer, finalPx, blendMask, bw, bh, cropX, cropY);

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
      if (v === 'Xenova/swin2SR-classical-sr-x2-64')
        this._setStatus('Swin2SR 在 CPU 上較慢，建議搭配 int8 精度或確保 WebGPU 可用');
      else if (!isCustom) this._setStatus(`模型：${v}`);
      else this._setStatus('請輸入自訂模型 ID');
    });

    ['up-model-id', 'up-dtype'].forEach(id => {
      document.getElementById(id).addEventListener('change', () => this._resetPipe());
    });

    this._setStatus('預設模型：Xenova/4x_APISR_GRL_GAN_generator-onnx，執行時自動下載');
  },

  open() { document.getElementById('dlg-ai-upsample').classList.remove('hidden'); },

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
      const { pipeline, env } = await _aiLoadTf();
      env.allowLocalModels = false;

      this._setStatus(`下載模型 ${modelId}（首次需等待）…`);
      this._setProgress(5);

      const device = _aiDevice();
      this._setStatus(`下載模型 ${modelId}（首次需等待，使用 ${device}）…`);
      this._pipe = await pipeline('image-to-image', modelId, {
        dtype,
        device,
        progress_callback: info => {
          if (info.status === 'progress') {
            this._setProgress(5 + info.progress * 0.88);
            this._setStatus(`下載模型… ${Math.round(info.progress)}%`);
          }
        },
      });

      this._loadedKey = key;
      this._setProgress(0);
      this._setStatus(`✓ ${modelId} 載入完成`);
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
      const { RawImage } = await _aiLoadTf();
      const src   = layer.canvas;
      const origW = src.width, origH = src.height;

      // ── 1. Convert canvas → RawImage and run pipeline ──
      this._setStatus('前處理…'); this._setProgress(10); await _aiTick();
      const image = await RawImage.fromCanvas(src);

      this._setStatus('AI 推論中…'); this._setProgress(-1); await _aiTickRender();
      const output = await this._pipe(image);   // returns RawImage
      const outW = output.width, outH = output.height;
      const ch   = output.channels;            // 3 = RGB

      // ── 2. Convert RawImage output → canvas ──
      this._setStatus('後處理…'); this._setProgress(85); await _aiTick();
      const outCanvas = document.createElement('canvas');
      outCanvas.width = outW; outCanvas.height = outH;
      const outCtx  = outCanvas.getContext('2d');
      const outImgD = outCtx.createImageData(outW, outH);
      for (let i = 0; i < outW * outH; i++) {
        outImgD.data[i * 4]     = output.data[i * ch];
        outImgD.data[i * 4 + 1] = output.data[i * ch + 1];
        outImgD.data[i * 4 + 2] = output.data[i * ch + 2];
        outImgD.data[i * 4 + 3] = 255;
      }
      outCtx.putImageData(outImgD, 0, 0);

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

    const modelId = document.getElementById('sam-model-id').value.trim()
                    || 'Xenova/slimsam-77-uniform';

    try {
      this._setStatus('載入 Transformers.js…');
      const { SamModel, AutoProcessor, env } = await _aiLoadTf();
      env.allowLocalModels = false;

      this._setStatus(`下載模型 ${modelId}（首次需等待）…`);
      this._setProgress(5);

      this._processor = await AutoProcessor.from_pretrained(modelId);

      this._setProgress(15);
      this._model = await SamModel.from_pretrained(modelId, {
        dtype: 'fp32',
        progress_callback: info => {
          if (info.status === 'progress') {
            this._setProgress(15 + info.progress * 0.83);
            this._setStatus(`下載模型… ${Math.round(info.progress)}%`);
          }
        },
      });

      this._loaded  = true;
      this._loading = false;
      this._setProgress(0);
      this._setStatus('✓ 已就緒。點擊畫布選取物件');
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

      // 選出 IoU 分數最高的候選遮罩（clamp 防止超出 masks[0] 範圍）
      let bestIdx = 0;
      const numMasks = masks[0].length;
      const scores = outputs.iou_scores?.data;
      if (scores && numMasks > 1) {
        let best = -Infinity;
        for (let i = 0; i < Math.min(scores.length, numMasks); i++) {
          if (scores[i] > best) { best = scores[i]; bestIdx = i; }
        }
      }

      const maskData = masks[0][bestIdx].data;  // Uint8Array, 值為 0 或 1
      const W = App.docWidth, H = App.docHeight;
      const tmp = new Uint8Array(W * H);
      for (let i = 0; i < tmp.length; i++) tmp[i] = maskData[i] ? 255 : 0;

      Selection._apply(tmp, 'new');

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
    const onnxFile = document.getElementById('outp-adv-file').value.trim() || null;
    const sessionKey = modelId + '|' + (onnxFile || '');
    if (this._session && this._loadedModelId === sessionKey) return true;
    if (this._loading) return false;
    this._loading = true;
    document.getElementById('outp-run-btn').disabled = true;

    try {
      this._setStatus('載入 ONNX Runtime…');
      const ort = await _loadOrt();

      const url = this._modelUrl(modelId, onnxFile);
      this._setStatus(`下載模型 ${modelId}（首次需等待）…`);
      this._setProgress(3);

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
        if (total) {
          this._setProgress(3 + (received / total) * 82);
          this._setStatus(`下載模型… ${Math.round(received / total * 100)}%`);
        }
      }

      this._setStatus('初始化 Session…');
      this._setProgress(88);
      await _aiTick();

      this._modelBuf = await new Blob(chunks).arrayBuffer();
      this._session  = await ort.InferenceSession.create(this._modelBuf, {
        executionProviders: ['wasm'],
      });

      this._loadedModelId = sessionKey;
      this._setProgress(0);
      this._setStatus(`✓ ${modelId} 載入完成`);
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
      const S    = parseInt(document.getElementById('outp-adv-res').value) || 512;
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
