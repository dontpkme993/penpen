'use strict';
/* ═══════════════════════════════════════════════════════
   ai.js — AI Tools
   Background removal powered by Transformers.js + RMBG-1.4
   ═══════════════════════════════════════════════════════ */

const AI_CDN        = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';
const RMBG_DEFAULT  = 'briaai/RMBG-1.4';

const AiRmbg = {
  _model:        null,
  _processor:    null,
  _loaded:       false,
  _loading:      false,
  _tf:           null,   // cached transformers module
  _loadedModelId: null,  // tracks which model is currently loaded

  _getModelId() {
    return (document.getElementById('ai-model-id').value || RMBG_DEFAULT).trim();
  },

  _isCustomConfig() {
    return document.getElementById('ai-custom-config').checked;
  },

  // Build processor config from key-value rows (values parsed as JSON)
  _readConfigRows() {
    const config = {};
    document.querySelectorAll('#ai-config-rows .ai-config-row').forEach(row => {
      const key = row.querySelector('.ai-config-key').value.trim();
      const raw = row.querySelector('.ai-config-val').value.trim();
      if (!key) return;
      try { config[key] = JSON.parse(raw); }
      catch { config[key] = raw; } // fallback: keep as string
    });
    return config;
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
    return this._readConfigRows();
  },

  // Add one key-value row to the config editor
  _addConfigRow(key = '', val = '') {
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
    del.addEventListener('click', () => { row.remove(); this._resetModel(); });

    row.append(keyIn, valIn, del);
    document.getElementById('ai-config-rows').appendChild(row);
  },

  // Pre-fill config editor with RMBG-1.4 defaults as a starting point
  _populateDefaultConfig() {
    const defaults = {
      do_normalize:    true,
      do_pad:          false,
      do_rescale:      true,
      do_resize:       true,
      image_mean:      [0.5, 0.5, 0.5],
      image_std:       [0.5, 0.5, 0.5],
      resample:        2,
      rescale_factor:  0.00392156862745098,
      size:            { width: 1024, height: 1024 },
    };
    Object.entries(defaults).forEach(([k, v]) => this._addConfigRow(k, JSON.stringify(v)));
  },

  _resetModel() {
    this._model         = null;
    this._processor     = null;
    this._loaded        = false;
    this._loadedModelId = null;
  },

  init() {
    document.getElementById('ai-run-btn').addEventListener('click', () => this._onRun());
    document.getElementById('ai-close-btn').addEventListener('click', () => {
      document.getElementById('dlg-ai-rmbg').classList.add('hidden');
    });

    // Reset when model ID changes
    document.getElementById('ai-model-id').addEventListener('change', () => {
      const id = this._getModelId();
      if (id !== this._loadedModelId) {
        this._resetModel();
        this._setStatus(`模型已切換至 ${id}，執行時將自動載入`);
      }
    });

    // Toggle between default-slider mode and custom-config mode
    document.getElementById('ai-custom-config').addEventListener('change', e => {
      const custom = e.target.checked;
      document.getElementById('ai-mask-section').classList.toggle('hidden', custom);
      document.getElementById('ai-config-section').classList.toggle('hidden', !custom);
      // Pre-populate rows on first switch to custom mode
      if (custom && document.getElementById('ai-config-rows').children.length === 0) {
        this._populateDefaultConfig();
      }
      this._resetModel();
      this._setStatus(custom
        ? '自訂 Config 模式：調整後執行去背將重新載入 Processor'
        : `預設模式：${RMBG_DEFAULT}`);
    });

    // Reset processor when any config row value changes (user may have tuned values)
    document.getElementById('ai-config-rows').addEventListener('change', () => {
      this._resetModel();
    });

    // Add row button
    document.getElementById('ai-config-add').addEventListener('click', () => {
      this._addConfigRow();
    });

    // Sync sliders ↔ number inputs
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

  open() {
    document.getElementById('dlg-ai-rmbg').classList.remove('hidden');
  },

  // ── Status / Progress ──────────────────────────────────
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

  // ── Model Loading ──────────────────────────────────────
  async _loadTf() {
    if (this._tf) return this._tf;
    this._tf = await import(AI_CDN);
    return this._tf;
  },

  async _ensureModel() {
    if (this._loaded)  return true;
    if (this._loading) return false;
    this._loading = true;
    document.getElementById('ai-run-btn').disabled = true;

    const modelId = this._getModelId();

    try {
      this._setStatus('載入 Transformers.js…');
      const { AutoModel, AutoProcessor, env } = await this._loadTf();
      env.allowLocalModels = false;

      this._setStatus(`下載模型 ${modelId}（首次需等待）…`);
      this._setProgress(5);

      this._model = await AutoModel.from_pretrained(modelId, {
        config: { model_type: 'custom' },
        progress_callback: info => {
          if (info.status === 'progress') {
            const pct = 5 + info.progress * 0.85;
            this._setProgress(pct);
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

      this._loaded        = true;
      this._loadedModelId = modelId;
      this._setProgress(0);
      this._setStatus(`✓ ${modelId} 載入完成`);
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

  // ── Run ───────────────────────────────────────────────
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
      this._setStatus('請先選取一個圖像圖層', true);
      return;
    }

    const ready = await this._ensureModel();
    if (!ready) return;

    document.getElementById('ai-run-btn').disabled = true;
    Hist.snapshot('AI 去背（前）');

    // Macrotask boundary — ensures the browser repaints before each heavy step.
    // await/microtasks alone don't trigger a paint flush when the model is cached.
    const tick = () => new Promise(r => setTimeout(r, 0));

    try {
      const { RawImage } = await this._loadTf();
      const src = layer.canvas;
      const w = src.width, h = src.height;

      this._setStatus('分析影像…');    this._setProgress(10);
      await tick();
      const image = await RawImage.fromCanvas(src);

      this._setStatus('前處理…');      this._setProgress(25);
      await tick();
      const { pixel_values } = await this._processor(image);

      this._setStatus('AI 推論中…');   this._setProgress(50);
      await tick();
      const { output } = await this._model({ input: pixel_values });

      this._setStatus('套用遮罩…');    this._setProgress(80);
      await tick();
      const rawMask = await RawImage
        .fromTensor(output[0].mul(255).to('uint8'))
        .resize(w, h);

      this._applyMask(layer, rawMask, this._getParams());
      Hist.snapshot('AI 去背');
      Engine.composite();
      UI.refreshLayerPanel();

      this._setProgress(0);
      this._setStatus('✓ 完成');

    } catch (err) {
      this._setProgress(0);
      this._setStatus('處理失敗：' + err.message, true);
      console.error('[AiRmbg] run error:', err);
    } finally {
      document.getElementById('ai-run-btn').disabled = false;
    }
  },

  // ── Mask Application ──────────────────────────────────
  _applyMask(layer, rawMask, { threshold, feather, expand }) {
    const w = layer.canvas.width, h = layer.canvas.height;
    const src = rawMask.data; // Uint8Array, length = w*h (single channel)

    // Build float32 mask (0.0–1.0)
    let mask = new Float32Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = src[i] / 255;

    // ── Morphological expand (+) / shrink (-) ──
    const aexp = Math.round(Math.abs(expand));
    if (aexp > 0) {
      const tmp = new Float32Array(w * h);
      const dilate = expand > 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let best = dilate ? 0 : 1;
          for (let dy = -aexp; dy <= aexp; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= h) continue;
            for (let dx = -aexp; dx <= aexp; dx++) {
              const nx = x + dx;
              if (nx < 0 || nx >= w) continue;
              const v = mask[ny * w + nx];
              best = dilate ? Math.max(best, v) : Math.min(best, v);
            }
          }
          tmp[y * w + x] = best;
        }
      }
      mask = tmp;
    }

    // ── Box-blur feathering (separable O(w×h)) ──
    const fr = Math.round(feather);
    if (fr > 0) {
      // Horizontal pass
      const tmp = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        let sum = 0, cnt = 0;
        const limit = Math.min(fr, w - 1);
        for (let x = 0; x <= limit; x++) { sum += mask[y * w + x]; cnt++; }
        for (let x = 0; x < w; x++) {
          tmp[y * w + x] = sum / cnt;
          if (x - fr >= 0) { sum -= mask[y * w + (x - fr)]; cnt--; }
          if (x + fr + 1 < w) { sum += mask[y * w + (x + fr + 1)]; cnt++; }
        }
      }
      // Vertical pass
      const tmp2 = new Float32Array(w * h);
      for (let x = 0; x < w; x++) {
        let sum = 0, cnt = 0;
        const limit = Math.min(fr, h - 1);
        for (let y = 0; y <= limit; y++) { sum += tmp[y * w + x]; cnt++; }
        for (let y = 0; y < h; y++) {
          tmp2[y * w + x] = sum / cnt;
          if (y - fr >= 0) { sum -= tmp[(y - fr) * w + x]; cnt--; }
          if (y + fr + 1 < h) { sum += tmp[(y + fr + 1) * w + x]; cnt++; }
        }
      }
      mask = tmp2;
    }

    // ── Apply threshold, write to alpha ──
    const imgData = layer.ctx.getImageData(0, 0, w, h);
    const d = imgData.data;
    const t = threshold;
    const scale = t < 1 ? 1 / (1 - t) : 1;
    for (let i = 0; i < mask.length; i++) {
      const m = mask[i];
      // Below threshold → 0; above → scale linearly to full
      const alpha = m < t ? 0 : Math.min(1, (m - t) * scale);
      d[i * 4 + 3] = Math.round(alpha * d[i * 4 + 3]);
    }
    layer.ctx.putImageData(imgData, 0, 0);
  }
};
