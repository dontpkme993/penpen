'use strict';
/* ═══════════════════════════════════════════════════════
   core.js  —  Utilities · History · Layer · LayerManager
   ═══════════════════════════════════════════════════════ */

/* ── Constants ── */
const MAX_HISTORY = 30;
const THUMB_SIZE  = 28;

/* ── Colour helpers ── */
function hexToRgb(hex) {
  hex = hex.replace('#','');
  if (hex.length === 3) hex = hex.split('').map(c=>c+c).join('');
  const n = parseInt(hex, 16);
  return { r:(n>>16)&255, g:(n>>8)&255, b:n&255 };
}
function rgbToHex(r,g,b) {
  return '#' + [r,g,b].map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
}
function hsvToRgb(h,s,v) {
  s/=100; v/=100;
  const f=(n,k=(n+h/60)%6)=>v-v*s*Math.max(Math.min(k,4-k,1),0);
  return { r:Math.round(f(5)*255), g:Math.round(f(3)*255), b:Math.round(f(1)*255) };
}
function rgbToHsv(r,g,b) {
  r/=255; g/=255; b/=255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
  let h=0, s=max===0?0:d/max, v=max;
  if(d!==0){
    if(max===r) h=((g-b)/d+6)%6;
    else if(max===g) h=(b-r)/d+2;
    else h=(r-g)/d+4;
    h*=60;
  }
  return { h:Math.round(h), s:Math.round(s*100), v:Math.round(v*100) };
}
function hexToRgba(hex, alpha=1) {
  const {r,g,b}=hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}
function clamp(v,lo=0,hi=255){ return Math.max(lo,Math.min(hi,v)); }
function lerp(a,b,t){ return a+(b-a)*t; }

/* ── ID generator ── */
let _uid=1;
function uid(){ return _uid++; }

/* ═══════════════════════════════════════════
   History  (Command-pattern style snapshot)
   ═══════════════════════════════════════════ */
class History {
  constructor() {
    this.stack   = [];   // [{label, snapshot}]
    this.index   = -1;
  }

  /** Call BEFORE the action mutates layer data */
  snapshot(label) {
    const snap = App.layers.map(l => ({
      id:        l.id,
      name:      l.name,
      visible:   l.visible,
      locked:    l.locked,
      opacity:   l.opacity,
      blendMode: l.blendMode,
      x: l.x, y: l.y,
      width:     l.canvas.width,
      height:    l.canvas.height,
      dataURL:   l.canvas.toDataURL(),
      type:      l.type || 'image',
      textData:  l.textData ? { ...l.textData } : null
    }));
    const sel = {
      mask: Selection.mask ? new Uint8Array(Selection.mask) : null,
      bbox: Selection.bbox ? { ...Selection.bbox } : null
    };
    // truncate redo branch
    this.stack = this.stack.slice(0, this.index+1);
    this.stack.push({ label, snap, sel, docWidth: App.docWidth, docHeight: App.docHeight });
    if (this.stack.length > MAX_HISTORY) this.stack.shift();
    this.index = this.stack.length - 1;
    UI.refreshHistory();
  }

  undo() {
    if (this.index <= 0) return;
    this.index--;
    this._restore(this.stack[this.index]);
    UI.refreshHistory();
  }

  redo() {
    if (this.index >= this.stack.length-1) return;
    this.index++;
    this._restore(this.stack[this.index]);
    UI.refreshHistory();
  }

  jumpTo(i) {
    if (i<0||i>=this.stack.length) return;
    this.index = i;
    this._restore(this.stack[i]);
    UI.refreshHistory();
  }

  _restore(entry) {
    const snap   = entry.snap;
    const docW   = entry.docWidth  || App.docWidth;
    const docH   = entry.docHeight || App.docHeight;

    // Restore document dimensions
    App.docWidth  = docW;
    App.docHeight = docH;
    Selection.init();
    Engine.resize(docW, docH);
    document.getElementById('st-size').textContent = `${docW}×${docH}`;

    // rebuild layers from snapshot
    const promises = snap.map(s => new Promise(res => {
      let layer = App.layers.find(l=>l.id===s.id);
      if (!layer) {
        layer = new Layer(s.name, s.width||docW, s.height||docH);
        layer.id = s.id;
        App.layers.push(layer);
      }
      layer.name      = s.name;
      layer.visible   = s.visible;
      layer.locked    = s.locked;
      layer.opacity   = s.opacity;
      layer.blendMode = s.blendMode;
      layer.x = s.x; layer.y = s.y;
      layer.type     = s.type || 'image';
      layer.textData = s.textData ? { ...s.textData } : null;
      // Text layers re-render from textData; image layers load from dataURL
      if (layer.type === 'text' && layer.textData) {
        layer.renderText();
        res();
      } else {
        const img = new Image();
        img.onload = () => {
          const w = s.width  || img.width  || docW;
          const h = s.height || img.height || docH;
          // Resize canvas if dimensions changed (e.g. after crop / canvas-resize / rotate)
          if (layer.canvas.width !== w || layer.canvas.height !== h) {
            layer.canvas.width  = w;
            layer.canvas.height = h;
            layer.ctx = layer.canvas.getContext('2d');
            layer.ctx.imageSmoothingEnabled = false;
          }
          layer.ctx.clearRect(0, 0, w, h);
          layer.ctx.drawImage(img, 0, 0);
          res();
        };
        img.src = s.dataURL;
      }
    }));
    // remove layers not in snap
    const ids = snap.map(s=>s.id);
    App.layers = App.layers.filter(l=>ids.includes(l.id));
    // maintain snap order
    App.layers.sort((a,b)=>ids.indexOf(a.id)-ids.indexOf(b.id));

    Promise.all(promises).then(()=>{
      App.activeLayerIndex = Math.min(App.activeLayerIndex, App.layers.length-1);
      // Restore selection state
      if (entry.sel && entry.sel.mask) {
        Selection.mask.set(entry.sel.mask);
        Selection.bbox = entry.sel.bbox ? { ...entry.sel.bbox } : null;
        Selection._maskDirty = true;
      }
      Engine.composite();
      UI.refreshLayerPanel();
      UI.updateLayerControls();
    });
  }
}

/* ═══════════════════════════════════════════
   Layer
   ═══════════════════════════════════════════ */
class Layer {
  constructor(name, w, h) {
    this.id        = uid();
    this.name      = name;
    this.visible   = true;
    this.locked    = false;
    this.opacity   = 100;
    this.blendMode = 'source-over';
    this.x         = 0;
    this.y         = 0;
    this.type      = 'image'; // 'image' | 'text'
    this.textData  = null;    // { text, font, size, bold, italic, underline, align, color }

    this.canvas    = document.createElement('canvas');
    this.canvas.width  = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
  }

  /** Re-render text to canvas from textData (text layers only) */
  renderText() {
    if (this.type !== 'text' || !this.textData || !this.textData.text) return;
    const d = this.textData;
    const fontStr = `${d.italic ? 'italic ' : ''}${d.bold ? 'bold ' : ''}${d.size}px "${d.font}"`;
    const lines   = d.text.split('\n');
    const lineH   = d.size * 1.2;
    const PAD     = 2;

    // Measure max line width
    const tmp = document.createElement('canvas');
    tmp.width = 4096; tmp.height = 64;
    const tc  = tmp.getContext('2d');
    tc.font   = fontStr;
    let maxW  = 0;
    lines.forEach(l => { maxW = Math.max(maxW, tc.measureText(l).width); });

    const W = Math.max(4, Math.ceil(maxW) + PAD * 2);
    const H = Math.max(4, Math.ceil(lines.length * lineH) + PAD * 2);

    this.canvas.width  = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.font        = fontStr;
    this.ctx.fillStyle   = d.color || '#000000';
    this.ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
      let x;
      if (d.align === 'center') { this.ctx.textAlign = 'center'; x = W / 2; }
      else if (d.align === 'right')  { this.ctx.textAlign = 'right';  x = W - PAD; }
      else                           { this.ctx.textAlign = 'left';   x = PAD; }
      this.ctx.fillText(line, x, PAD + i * lineH);
    });
  }

  clear(){ this.ctx.clearRect(0,0,this.canvas.width,this.canvas.height); }

  fill(color='#ffffff') {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0,0,this.canvas.width,this.canvas.height);
  }

  /** Resize canvas, optionally resampling existing content */
  resize(newW, newH, method='bilinear') {
    const tmp = document.createElement('canvas');
    tmp.width=newW; tmp.height=newH;
    const tCtx = tmp.getContext('2d');
    tCtx.imageSmoothingEnabled = (method==='bilinear');
    tCtx.imageSmoothingQuality = 'high';
    tCtx.drawImage(this.canvas, 0, 0, newW, newH);
    this.canvas.width=newW; this.canvas.height=newH;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.drawImage(tmp,0,0);
  }

  /** Return thumbnail as data-url */
  thumbnail(size=THUMB_SIZE) {
    const tmp = document.createElement('canvas');
    const aspect = this.canvas.width/this.canvas.height;
    tmp.width  = aspect>=1 ? size : Math.round(size*aspect);
    tmp.height = aspect>=1 ? Math.round(size/aspect) : size;
    const c = tmp.getContext('2d');
    c.imageSmoothingEnabled = true;
    c.drawImage(this.canvas, 0,0, tmp.width, tmp.height);
    return tmp.toDataURL();
  }

  /** Get/set entire pixel data */
  getImageData() {
    return this.ctx.getImageData(0,0,this.canvas.width,this.canvas.height);
  }
  putImageData(id) {
    this.ctx.putImageData(id,0,0);
  }
}

/* ═══════════════════════════════════════════
   LayerManager
   ═══════════════════════════════════════════ */
const LayerMgr = {

  addTextLayer(textData, x, y) {
    Hist.snapshot('新增文字圖層');
    const l = new Layer('文字', 4, 4);
    l.type     = 'text';
    l.textData = { ...textData };
    l.x = x;
    l.y = y;
    l.renderText();
    App.layers.splice(App.activeLayerIndex + 1, 0, l);
    App.activeLayerIndex = App.activeLayerIndex + 1;
    Engine.composite();
    UI.refreshLayerPanel();
    return l;
  },

  add(name, w, h, fill=null) {
    Hist.snapshot('新增圖層');
    const l = new Layer(name||`圖層 ${App.layers.length+1}`, w||App.docWidth, h||App.docHeight);
    if (fill) l.fill(fill);
    App.layers.splice(App.activeLayerIndex, 0, l);
    Engine.composite();
    UI.refreshLayerPanel();
    return l;
  },

  addAt(index, layer) {
    App.layers.splice(index, 0, layer);
  },

  duplicate() {
    const src = this.active();
    if (!src) return;
    Hist.snapshot('複製圖層');
    const l = new Layer(src.name+' 副本', src.canvas.width, src.canvas.height);
    l.ctx.drawImage(src.canvas,0,0);
    l.opacity   = src.opacity;
    l.blendMode = src.blendMode;
    l.visible   = src.visible;
    l.type      = src.type;
    l.textData  = src.textData ? { ...src.textData } : null;
    App.layers.splice(App.activeLayerIndex+1,0,l);
    App.activeLayerIndex++;
    Engine.composite();
    UI.refreshLayerPanel();
  },

  delete(index) {
    if (App.layers.length<=1) { alert('至少需要一個圖層'); return; }
    index = index??App.activeLayerIndex;
    Hist.snapshot('刪除圖層');
    App.layers.splice(index,1);
    App.activeLayerIndex = Math.max(0, Math.min(index, App.layers.length-1));
    Engine.composite();
    UI.refreshLayerPanel();
  },

  select(index) {
    App.activeLayerIndex = clamp(index, 0, App.layers.length-1);
    UI.refreshLayerPanel();
    UI.updateLayerControls();
  },

  active() { return App.layers[App.activeLayerIndex] || null; },

  moveUp(index) {
    index = index??App.activeLayerIndex;
    if (index >= App.layers.length-1) return;
    Hist.snapshot('移動圖層');
    [App.layers[index], App.layers[index+1]] = [App.layers[index+1], App.layers[index]];
    if (App.activeLayerIndex===index) App.activeLayerIndex++;
    Engine.composite();
    UI.refreshLayerPanel();
  },

  moveDown(index) {
    index = index??App.activeLayerIndex;
    if (index<=0) return;
    Hist.snapshot('移動圖層');
    [App.layers[index], App.layers[index-1]] = [App.layers[index-1], App.layers[index]];
    if (App.activeLayerIndex===index) App.activeLayerIndex--;
    Engine.composite();
    UI.refreshLayerPanel();
  },

  mergeDown(index) {
    index = index??App.activeLayerIndex;
    if (index<=0) return;
    Hist.snapshot('向下合併');
    const top = App.layers[index];
    const bot = App.layers[index-1];
    bot.ctx.save();
    bot.ctx.globalAlpha = top.opacity/100;
    bot.ctx.globalCompositeOperation = top.blendMode;
    bot.ctx.drawImage(top.canvas, top.x-bot.x, top.y-bot.y);
    bot.ctx.restore();
    // Merging always produces a pixel layer
    bot.type = 'image';
    bot.textData = null;
    App.layers.splice(index,1);
    App.activeLayerIndex = Math.max(0, index-1);
    Engine.composite();
    UI.refreshLayerPanel();
  },

  flatten() {
    Hist.snapshot('平面化影像');
    const flat = new Layer('背景', App.docWidth, App.docHeight);
    flat.fill('#ffffff');
    flat.ctx.save();
    [...App.layers].reverse().forEach(l => {
      if (!l.visible) return;
      flat.ctx.globalAlpha = l.opacity/100;
      flat.ctx.globalCompositeOperation = l.blendMode;
      flat.ctx.drawImage(l.canvas, l.x, l.y);
    });
    flat.ctx.restore();
    App.layers = [flat];
    App.activeLayerIndex = 0;
    Engine.composite();
    UI.refreshLayerPanel();
  },

  rename(index, name) {
    if (App.layers[index]) App.layers[index].name = name;
    UI.refreshLayerPanel();
  },

  setOpacity(index, val) {
    if (!App.layers[index]) return;
    App.layers[index].opacity = clamp(val,0,100);
    Engine.composite();
    UI.updateLayerThumb(index);
  },

  setBlendMode(index, mode) {
    if (!App.layers[index]) return;
    App.layers[index].blendMode = mode;
    Engine.composite();
  }
};
