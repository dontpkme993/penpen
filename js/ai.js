'use strict';
/* ═══════════════════════════════════════════════════════
   ai.js — AI Tools
   Background removal (AiRmbg) + Object removal (AiInpaint)
   AiRmbg  : Transformers.js + briaai/RMBG-1.4
   AiInpaint: onnxruntime-web + Carve/LaMa-ONNX (direct ONNX)
   ═══════════════════════════════════════════════════════ */

const AI_CDN       = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';
const ORT_CDN      = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1/dist/ort.min.mjs';
const RMBG_DEFAULT = 'briaai/RMBG-1.4';
const LAMA_DEFAULT = 'Carve/LaMa-ONNX';
const LAMA_FILE    = 'lama_fp32.onnx'; // 208 MB, fixed 512×512 input

/* ── Shared module-level helpers ── */
let _aiTf  = null;
let _inpOrt = null;  // onnxruntime-web instance for AiInpaint
const _aiTick = () => new Promise(r => setTimeout(r, 0));

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
  _model:         null,
  _processor:     null,
  _loaded:        false,
  _loading:       false,
  _loadedModelId: null,

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
    document.getElementById('ai-run-btn').addEventListener('click', () => this._onRun());
    document.getElementById('ai-close-btn').addEventListener('click', () => {
      document.getElementById('dlg-ai-rmbg').classList.add('hidden');
    });

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
    bar.style.display = (pct > 0 && pct < 100) ? 'block' : 'none';
    fill.style.width  = pct + '%';
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

      this._model = await AutoModel.from_pretrained(modelId, {
        config: { model_type: 'custom' },
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
    const layer = LayerMgr.active();
    if (!layer || layer.type === 'text') {
      this._setStatus('請先選取一個圖像圖層', true); return;
    }

    const ready = await this._ensureModel();
    if (!ready) return;

    document.getElementById('ai-run-btn').disabled = true;
    Hist.snapshot('AI 去背（前）');

    try {
      const { RawImage } = await _aiLoadTf();
      const src = layer.canvas;
      const w = src.width, h = src.height;

      this._setStatus('分析影像…');    this._setProgress(10); await _aiTick();
      const image = await RawImage.fromCanvas(src);

      this._setStatus('前處理…');      this._setProgress(25); await _aiTick();
      const { pixel_values } = await this._processor(image);

      this._setStatus('AI 推論中…');   this._setProgress(50); await _aiTick();
      const { output } = await this._model({ input: pixel_values });

      this._setStatus('套用遮罩…');    this._setProgress(80); await _aiTick();
      const rawMask = await RawImage
        .fromTensor(output[0].mul(255).to('uint8'))
        .resize(w, h);

      this._applyMask(layer, rawMask, this._getParams());
      Hist.snapshot('AI 去背');
      Engine.composite();
      UI.refreshLayerPanel();

      this._setProgress(0); this._setStatus('✓ 完成');

    } catch (err) {
      this._setProgress(0);
      this._setStatus('處理失敗：' + err.message, true);
      console.error('[AiRmbg] run error:', err);
    } finally {
      document.getElementById('ai-run-btn').disabled = false;
    }
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
  _loading:       false,
  _loadedModelId: null,

  _getModelId() {
    return (document.getElementById('inp-model-id').value || LAMA_DEFAULT).trim();
  },

  _resetSession() {
    this._session = null; this._loadedModelId = null;
  },

  init() {
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
    bar.style.display = (pct > 0 && pct < 100) ? 'block' : 'none';
    fill.style.width  = pct + '%';
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

      const buf = await new Blob(chunks).arrayBuffer();
      this._session = await ort.InferenceSession.create(buf, {
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
      const src = layer.canvas;
      const w = src.width, h = src.height;
      const { dilate, blend } = this._getParams();
      const adv = this._getAdvanced();
      const S = adv.resolution;

      // ── 1. Build float mask from selection ──
      this._setStatus('準備遮罩…'); this._setProgress(10); await _aiTick();
      const selPx = Selection.getMaskCanvas()
        .getContext('2d').getImageData(0, 0, w, h).data;
      let floatMask = new Float32Array(w * h);
      for (let i = 0; i < floatMask.length; i++) floatMask[i] = selPx[i * 4 + 3] / 255;
      if (dilate > 0) floatMask = _aiMorphMask(floatMask, w, h, dilate);

      // ── 2. Resize image + mask to 512×512 ──
      this._setStatus('前處理…'); this._setProgress(25); await _aiTick();

      // Resize layer canvas → S×S
      const imgS = document.createElement('canvas');
      imgS.width = imgS.height = S;
      imgS.getContext('2d').drawImage(src, 0, 0, S, S);
      const imgPx = imgS.getContext('2d').getImageData(0, 0, S, S).data;

      // Render float mask at original size, resize to S×S via canvas
      const maskOrig = document.createElement('canvas');
      maskOrig.width = w; maskOrig.height = h;
      const moCtx = maskOrig.getContext('2d');
      const moData = moCtx.createImageData(w, h);
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

      // ── 3. Build NCHW float32 tensors ──
      const imgFloat  = new Float32Array(3 * S * S);
      const maskFloat = new Float32Array(1 * S * S);
      for (let i = 0; i < S * S; i++) {
        imgFloat[0 * S * S + i] = imgPx[i * 4]     / 255; // R
        imgFloat[1 * S * S + i] = imgPx[i * 4 + 1] / 255; // G
        imgFloat[2 * S * S + i] = imgPx[i * 4 + 2] / 255; // B
        maskFloat[i]             = maskPx[i * 4] > 127 ? 1 : 0; // binary
      }
      const imageTensor = new ort.Tensor('float32', imgFloat,  [1, 3, S, S]);
      const maskTensor  = new ort.Tensor('float32', maskFloat, [1, 1, S, S]);

      // ── 4. Run inference ──
      this._setStatus('AI 推論中…'); this._setProgress(50); await _aiTick();
      const results  = await this._session.run({ [adv.imageName]: imageTensor, [adv.maskName]: maskTensor });
      const outTensor = results.output ?? Object.values(results)[0]; // named "output"
      const outData   = outTensor.data; // Float32Array, NCHW [1,3,S,S]

      // ── 5. Convert tensor → canvas at S×S ──
      this._setStatus('套用結果…'); this._setProgress(85); await _aiTick();

      // Auto-detect output range: Carve/LaMa-ONNX outputs [0,255] float32.
      // Generic models may output [0,1]. Sample the max to decide.
      let maxVal = 0;
      for (let i = 0; i < outData.length; i++) if (outData[i] > maxVal) maxVal = outData[i];
      const outScale = maxVal > 2.0 ? 1 : 255; // >2 → pixel range; ≤2 → unit range
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

      // Scale output from S×S back to original w×h
      const outFull = document.createElement('canvas');
      outFull.width = w; outFull.height = h;
      outFull.getContext('2d').drawImage(outS, 0, 0, w, h);
      const finalPx = outFull.getContext('2d').getImageData(0, 0, w, h).data;

      // ── 6. Blend with feathering ──
      const blendMask = blend > 0 ? _aiBoxBlur(floatMask, w, h, blend) : floatMask;
      this._applyResult(layer, finalPx, blendMask);

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

  // Blend inpainted pixel data into the layer using float blend mask
  _applyResult(layer, inpaintedPx, blendMask) {
    const w = layer.canvas.width, h = layer.canvas.height;
    const imgData = layer.ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    for (let i = 0; i < blendMask.length; i++) {
      const m = blendMask[i];
      if (m === 0) continue;
      const p = i * 4;
      d[p]     = Math.round(d[p]     * (1 - m) + inpaintedPx[p]     * m);
      d[p + 1] = Math.round(d[p + 1] * (1 - m) + inpaintedPx[p + 1] * m);
      d[p + 2] = Math.round(d[p + 2] * (1 - m) + inpaintedPx[p + 2] * m);
      // Alpha unchanged
    }
    layer.ctx.putImageData(imgData, 0, 0);
  }
};
