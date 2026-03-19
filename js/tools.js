'use strict';
/* ═══════════════════════════════════════════════════════
   tools.js  —  ToolManager + All Tools
   ═══════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════
   Tool Manager
   ═══════════════════════════════════════════ */
const ToolMgr = {
  tools:   {},
  current: null,
  name:    'move',

  register(name, tool) { this.tools[name]=tool; },

  activate(name) {
    if (this.current && this.current.deactivate) this.current.deactivate();
    this.name    = name;
    this.current = this.tools[name];
    if (this.current && this.current.activate) this.current.activate();
    UI.updateToolOptions(name);
    document.getElementById('st-tool').textContent='工具: '+(this.current&&this.current.label||name);
    // update cursor
    const ov=document.getElementById('overlay-canvas');
    ov.className='cursor-'+(this.current&&this.current.cursor||'crosshair');
    // update toolbar buttons
    document.querySelectorAll('.tb-btn').forEach(b=>{
      b.classList.toggle('active', b.dataset.tool===name);
    });
  }
};

/* ── Brush stroke helper (shared by Brush, Pencil, Eraser) ── */
function strokeDab(ctx, x, y, size, color, opacity, hardness, erasing=false, flowAlpha=1) {
  const r = size/2;
  ctx.save();
  if (erasing) {
    ctx.globalCompositeOperation='destination-out';
    ctx.globalAlpha = opacity/100 * flowAlpha;
    ctx.fillStyle='rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation='source-over';
    ctx.globalAlpha = opacity/100 * flowAlpha;
    ctx.fillStyle = color;
  }

  if (hardness >= 99) {
    // Hard circle
    ctx.beginPath();
    ctx.arc(x,y,r,0,Math.PI*2);
    ctx.fill();
  } else {
    // Soft gradient brush — power-curve falloff for richer feathering
    // p=3 at hardness=0 (cubic, very soft), p=1 at hardness=99 (linear)
    const h = hardness / 100;
    const p = 1 + 2 * (1 - h);
    const grad = ctx.createRadialGradient(x,y,r*h,x,y,r);
    if (erasing) {
      [0, 0.25, 0.5, 0.75, 1].forEach(t => {
        grad.addColorStop(t, `rgba(0,0,0,${Math.pow(1-t,p).toFixed(4)})`);
      });
    } else {
      const {r:cr,g:cg,b:cb}=hexToRgb(color);
      [0, 0.25, 0.5, 0.75, 1].forEach(t => {
        grad.addColorStop(t, `rgba(${cr},${cg},${cb},${Math.pow(1-t,p).toFixed(4)})`);
      });
    }
    ctx.fillStyle=grad;
    ctx.beginPath();
    ctx.arc(x,y,r,0,Math.PI*2);
    ctx.fill();
  }
  ctx.restore();
}

function paintLine(ctx, x1,y1,x2,y2, size, color, opacity, hardness, spacing, erasing=false) {
  const dist = Math.hypot(x2-x1,y2-y1);
  const step = Math.max(1, size*spacing);
  const steps= Math.max(1, Math.ceil(dist/step));
  for(let i=0;i<=steps;i++){
    const t=i/steps;
    strokeDab(ctx, lerp(x1,x2,t), lerp(y1,y2,t), size, color, opacity, hardness, erasing);
  }
}

/* ─────────────────────────────────────────────
   Selection-aware stroke buffer
   All drawing tools use this when a selection is active.
   The flow:
     1. _SB.begin(layerCanvas)        – snapshot layer, clear raw buf
     2. Paint dabs/lines → _SB.bufCtx (not layer.ctx)
     3. _SB.flush(layer.ctx, erasing) – restore snapshot, apply masked buf
   ───────────────────────────────────────────── */
const _SB = {
  buf: null, bufCtx: null,    // raw stroke in DOC space (doc-sized)
  snap: null, snapCtx: null,  // pre-stroke snapshot of LAYER canvas (layer-sized)
  tmp:  null, tmpCtx:  null,  // masked composite temp (doc-sized)

  _ensureDoc() {
    const W=App.docWidth, H=App.docHeight;
    if (!this.buf) {
      this.buf = document.createElement('canvas'); this.bufCtx = this.buf.getContext('2d');
      this.tmp = document.createElement('canvas'); this.tmpCtx = this.tmp.getContext('2d');
    }
    if (this.buf.width!==W||this.buf.height!==H) {
      this.buf.width=this.tmp.width=W; this.buf.height=this.tmp.height=H;
    }
  },

  begin(layerCanvas) {
    this._ensureDoc();
    // Snap is sized to match the layer canvas (may differ from doc size)
    if (!this.snap) {
      this.snap = document.createElement('canvas'); this.snapCtx = this.snap.getContext('2d');
    }
    this.snap.width  = layerCanvas.width;
    this.snap.height = layerCanvas.height;
    this.snapCtx.clearRect(0,0,layerCanvas.width,layerCanvas.height);
    this.snapCtx.drawImage(layerCanvas, 0,0);
    // Clear the doc-space stroke buf
    this.bufCtx.clearRect(0,0,App.docWidth,App.docHeight);
  },

  // layer: the Layer object (needs .x, .y, .canvas, .ctx)
  flush(layer, erasing) {
    const W=App.docWidth, H=App.docHeight;
    const lw=layer.canvas.width, lh=layer.canvas.height;
    const lx=layer.x, ly=layer.y;
    // Restore pre-stroke layer state from snapshot
    layer.ctx.clearRect(0,0,lw,lh);
    layer.ctx.drawImage(this.snap, 0,0);
    // Copy stroke buf (doc-space) to tmp, clip to selection mask (doc-space)
    this.tmpCtx.clearRect(0,0,W,H);
    this.tmpCtx.drawImage(this.buf, 0,0);
    this.tmpCtx.globalCompositeOperation = 'destination-in';
    this.tmpCtx.drawImage(Selection.getMaskCanvas(), 0,0);
    this.tmpCtx.globalCompositeOperation = 'source-over';
    // Apply tmp to layer with (-lx, -ly) offset to map doc-space → layer-space
    if (erasing) {
      layer.ctx.globalCompositeOperation = 'destination-out';
      layer.ctx.drawImage(this.tmp, -lx,-ly);
      layer.ctx.globalCompositeOperation = 'source-over';
    } else {
      layer.ctx.drawImage(this.tmp, -lx,-ly);
    }
  }
};

/* Draw eraser footprint as opaque white marks (for accumulation buffer).
   Used by EraserTool so dabs can later be applied as destination-out. */
function strokeDabAccum(ctx, x, y, size, opacity, hardness, flowAlpha=1) {
  const r = size/2;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = opacity/100 * flowAlpha;
  if (hardness >= 99) {
    ctx.fillStyle = 'white';
  } else {
    const h = hardness / 100;
    const p = 1 + 2 * (1 - h);
    const grad = ctx.createRadialGradient(x,y,r*h,x,y,r);
    [0, 0.25, 0.5, 0.75, 1].forEach(t => {
      grad.addColorStop(t, `rgba(255,255,255,${Math.pow(1-t,p).toFixed(4)})`);
    });
    ctx.fillStyle = grad;
  }
  ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
  ctx.restore();
}

function paintLineAccum(ctx, x1,y1,x2,y2, size, opacity, hardness, spacing) {
  const dist=Math.hypot(x2-x1,y2-y1);
  const step=Math.max(1,size*spacing);
  const steps=Math.max(1,Math.ceil(dist/step));
  for(let i=0;i<=steps;i++){
    const t=i/steps;
    strokeDabAccum(ctx, lerp(x1,x2,t), lerp(y1,y2,t), size, opacity, hardness);
  }
}

/* ═══════════════════════════════════════════
   1. Move Tool  (moves active layer)
   ═══════════════════════════════════════════ */
class MoveTool {
  constructor(){ this.label='移動'; this.cursor='move'; this._dragging=false; this._sx=0; this._sy=0; this._ox=0; this._oy=0; }
  onPointerDown(e,x,y){
    const l=LayerMgr.active(); if(!l||l.locked) return;
    this._dragging=true; this._sx=x; this._sy=y; this._ox=l.x; this._oy=l.y;
  }
  onPointerMove(e,x,y){
    if(!this._dragging) return;
    const l=LayerMgr.active(); if(!l) return;
    l.x=Math.round(this._ox+(x-this._sx));
    l.y=Math.round(this._oy+(y-this._sy));
    Engine.composite();
  }
  onPointerUp(){
    if(this._dragging){ this._dragging=false; Hist.snapshot('移動圖層'); }
  }
}

/* ═══════════════════════════════════════════
   2. Brush Tool
   ═══════════════════════════════════════════ */
class BrushTool {
  constructor(){ this.label='筆刷'; this.cursor='none'; this._drawing=false; this._lx=0; this._ly=0; }
  get size()     { return App.brush.size; }
  get opacity()  { return App.brush.opacity; }
  get hardness() { return App.brush.hardness; }
  get spacing()  { return App.brush.spacing; }
  get color()    {
    const l = LayerMgr.active();
    return (l && l.type === 'rmbg-mask') ? '#ffffff' : App.fgColor;
  }

  onPointerDown(e,x,y){
    const l=LayerMgr.active(); if(!l||l.locked||l.type==='text') return;
    this._drawing=true; this._lx=x; this._ly=y;
    const pressure=e.pointerType==='mouse'?1:(e.pressure||1);
    if (!Selection.empty()) {
      _SB.begin(l.canvas);
      strokeDab(_SB.bufCtx, x,y, this.size*pressure, this.color, this.opacity, this.hardness);
      _SB.flush(l, false);
    } else {
      strokeDab(l.ctx, x-l.x,y-l.y, this.size*pressure, this.color, this.opacity, this.hardness);
    }
    Engine.composite();
  }
  onPointerMove(e,x,y){
    if(!this._drawing) return;
    const l=LayerMgr.active(); if(!l||l.locked) return;
    const pressure=e.pointerType==='mouse'?1:(e.pressure||1);
    if (!Selection.empty()) {
      paintLine(_SB.bufCtx, this._lx,this._ly,x,y, this.size*pressure, this.color, this.opacity, this.hardness, this.spacing);
      _SB.flush(l, false);
    } else {
      paintLine(l.ctx, this._lx-l.x,this._ly-l.y,x-l.x,y-l.y, this.size*pressure, this.color, this.opacity, this.hardness, this.spacing);
    }
    this._lx=x; this._ly=y;
    Engine.composite();
  }
  onPointerUp(){
    if(this._drawing){ Hist.snapshot('筆刷'); this._drawing=false; }
  }
  drawOverlay(oc) {
    // draw brush cursor circle
    if (App._cursorX!==undefined) {
      oc.save();
      oc.strokeStyle='rgba(255,255,255,0.8)';
      oc.lineWidth=1;
      oc.beginPath();
      oc.arc(App._cursorX, App._cursorY, this.size/2, 0, Math.PI*2);
      oc.stroke();
      oc.strokeStyle='rgba(0,0,0,0.5)';
      oc.lineWidth=2;
      oc.beginPath();
      oc.arc(App._cursorX, App._cursorY, this.size/2+1, 0, Math.PI*2);
      oc.stroke();
      oc.restore();
    }
  }
}

/* ═══════════════════════════════════════════
   3. Pencil Tool  (hard edge, no pressure)
   ═══════════════════════════════════════════ */
class PencilTool extends BrushTool {
  constructor(){ super(); this.label='鉛筆'; }
  get hardness(){ return 100; }
  get spacing() { return 0.25; }
}

/* ═══════════════════════════════════════════
   4. Eraser Tool
   ═══════════════════════════════════════════ */
class EraserTool extends BrushTool {
  constructor(){ super(); this.label='橡皮擦'; this.cursor='none'; }
  onPointerDown(e,x,y){
    const l=LayerMgr.active(); if(!l||l.locked||l.type==='text') return;
    this._drawing=true; this._lx=x; this._ly=y;
    const p=e.pointerType==='mouse'?1:(e.pressure||1);
    if (l.type === 'rmbg-mask') {
      // On mask layer: paint black (= remove) instead of erasing to transparency
      if (!Selection.empty()) {
        _SB.begin(l.canvas);
        strokeDab(_SB.bufCtx, x,y, this.size*p, '#000000', this.opacity, this.hardness);
        _SB.flush(l, false);
      } else {
        strokeDab(l.ctx,x-l.x,y-l.y,this.size*p,'#000000',this.opacity,this.hardness,false);
      }
    } else if (!Selection.empty()) {
      _SB.begin(l.canvas);
      strokeDabAccum(_SB.bufCtx, x,y, this.size*p, this.opacity, this.hardness);
      _SB.flush(l, true);
    } else {
      strokeDab(l.ctx,x-l.x,y-l.y,this.size*p,this.color,this.opacity,this.hardness,true);
    }
    Engine.composite();
  }
  onPointerMove(e,x,y){
    if(!this._drawing) return;
    const l=LayerMgr.active(); if(!l||l.locked) return;
    const p=e.pointerType==='mouse'?1:(e.pressure||1);
    if (l.type === 'rmbg-mask') {
      // On mask layer: paint black (= remove) instead of erasing to transparency
      if (!Selection.empty()) {
        paintLine(_SB.bufCtx, this._lx,this._ly,x,y, this.size*p,'#000000',this.opacity,this.hardness,this.spacing);
        _SB.flush(l, false);
      } else {
        paintLine(l.ctx,this._lx-l.x,this._ly-l.y,x-l.x,y-l.y,this.size*p,'#000000',this.opacity,this.hardness,this.spacing,false);
      }
    } else if (!Selection.empty()) {
      paintLineAccum(_SB.bufCtx, this._lx,this._ly,x,y, this.size*p, this.opacity, this.hardness, this.spacing);
      _SB.flush(l, true);
    } else {
      paintLine(l.ctx,this._lx-l.x,this._ly-l.y,x-l.x,y-l.y,this.size*p,this.color,this.opacity,this.hardness,this.spacing,true);
    }
    this._lx=x; this._ly=y;
    Engine.composite();
  }
  onPointerUp(){ if(this._drawing){ Hist.snapshot('橡皮擦'); this._drawing=false; } }
}

/* ═══════════════════════════════════════════
   5. Fill Tool  (flood fill)
   ═══════════════════════════════════════════ */
class FillTool {
  constructor(){ this.label='油漆桶'; this.cursor='crosshair'; }
  onPointerDown(e,x,y){
    const l=LayerMgr.active(); if(!l||l.locked||l.type==='text') return;
    const tol=App.fill.tolerance||32;
    this._floodFill(l, Math.round(x), Math.round(y), App.fgColor, tol);
    Hist.snapshot('填滿');
    Engine.composite();
  }
  _floodFill(layer, sx, sy, color, tolerance) {
    const lx=layer.x, ly=layer.y;
    const W=layer.canvas.width, H=layer.canvas.height;
    // Convert doc coords → layer-local coords
    const lsx=sx-lx, lsy=sy-ly;
    if(lsx<0||lsx>=W||lsy<0||lsy>=H) return; // click outside this layer's canvas
    const id=layer.ctx.getImageData(0,0,W,H);
    const d=id.data;
    const {r:fr,g:fg,b:fb}=hexToRgb(color);
    const si=(lsy*W+lsx)*4;
    const tr=d[si],tg=d[si+1],tb=d[si+2],ta=d[si+3];
    if(tr===fr&&tg===fg&&tb===fb&&ta===255) return;
    const diff=(i)=>Math.abs(d[i]-tr)+Math.abs(d[i+1]-tg)+Math.abs(d[i+2]-tb)+Math.abs(d[i+3]-ta);
    const visited=new Uint8Array(W*H);
    const stack=[[lsx,lsy]];
    while(stack.length){
      const [x,y]=stack.pop();
      if(x<0||x>=W||y<0||y>=H) continue;
      const j=y*W+x;
      if(visited[j]) continue;
      visited[j]=1;
      const i=j*4;
      if(diff(i)>tolerance*4) continue;
      // check selection using doc coords (layer-local + layer offset)
      if(!Selection.empty()&&!Selection.contains(x+lx,y+ly)) continue;
      d[i]=fr; d[i+1]=fg; d[i+2]=fb; d[i+3]=255;
      stack.push([x+1,y],[x-1,y],[x,y+1],[x,y-1]);
    }
    layer.ctx.putImageData(id,0,0);
  }
}

/* ═══════════════════════════════════════════
   6. Eyedropper Tool
   ═══════════════════════════════════════════ */
class EyedropperTool {
  constructor(){ this.label='滴管'; this.cursor='crosshair'; }
  onPointerDown(e,x,y){ this._pick(x,y); }
  onPointerMove(e,x,y){ if(e.buttons) this._pick(x,y); }
  _pick(x,y){
    // Pick from composite
    const px=Math.round(clamp(x,0,App.docWidth-1));
    const py=Math.round(clamp(y,0,App.docHeight-1));
    const id=Engine.mainCtx.getImageData(px,py,1,1).data;
    const hex=rgbToHex(id[0],id[1],id[2]);
    App.setFgColor(hex);
  }
}

/* ═══════════════════════════════════════════
   7. Rectangle Selection
   ═══════════════════════════════════════════ */
class SelectRectTool {
  constructor(){ this.label='矩形選取'; this.cursor='crosshair'; this._drawing=false; this._sx=0; this._sy=0; this._ex=0; this._ey=0; }
  get mode(){ return App.selection.mode||'new'; }
  onPointerDown(e,x,y){ this._drawing=true; this._sx=x; this._sy=y; this._ex=x; this._ey=y; }
  onPointerMove(e,x,y){
    if(!this._drawing) return;
    this._ex=e.shiftKey?this._sx+(x-this._sx>0?Math.abs(x-this._sx):-Math.abs(x-this._sx)):x;
    this._ey=e.shiftKey?this._sy+(y-this._sy>0?Math.abs(x-this._sx):-Math.abs(x-this._sx)):y;
    Engine.drawOverlay();
  }
  onPointerUp(e,x,y){
    if(!this._drawing) return;
    this._drawing=false;
    Selection.setRect(this._sx,this._sy,this._ex,this._ey, this.mode);
    Hist.snapshot('選取範圍');
  }
  drawOverlay(oc){
    if(!this._drawing) return;
    oc.save();
    oc.strokeStyle='white'; oc.lineWidth=1;
    oc.setLineDash([4,4]);
    const x=Math.min(this._sx,this._ex), y=Math.min(this._sy,this._ey);
    const w=Math.abs(this._ex-this._sx), h=Math.abs(this._ey-this._sy);
    oc.strokeRect(x,y,w,h);
    oc.restore();
  }
}

/* ═══════════════════════════════════════════
   8. Ellipse Selection
   ═══════════════════════════════════════════ */
class SelectEllipseTool extends SelectRectTool {
  constructor(){ super(); this.label='橢圓選取'; }
  onPointerUp(){
    if(!this._drawing) return;
    this._drawing=false;
    Selection.setEllipse(this._sx,this._sy,this._ex,this._ey, this.mode);
    Hist.snapshot('選取範圍');
  }
  drawOverlay(oc){
    if(!this._drawing) return;
    oc.save();
    oc.strokeStyle='white'; oc.lineWidth=1;
    oc.setLineDash([4,4]);
    const cx=(this._sx+this._ex)/2, cy=(this._sy+this._ey)/2;
    const rx=Math.abs(this._ex-this._sx)/2, ry=Math.abs(this._ey-this._sy)/2;
    oc.beginPath(); oc.ellipse(cx,cy,rx,ry,0,0,Math.PI*2); oc.stroke();
    oc.restore();
  }
}

/* ═══════════════════════════════════════════
   9. Lasso Tool
   ═══════════════════════════════════════════ */
class LassoTool {
  constructor(){ this.label='套索'; this.cursor='crosshair'; this._points=[]; this._drawing=false; }
  get mode(){ return App.selection.mode||'new'; }
  onPointerDown(e,x,y){ this._drawing=true; this._points=[{x,y}]; }
  onPointerMove(e,x,y){
    if(!this._drawing) return;
    this._points.push({x,y});
    Engine.drawOverlay();
  }
  onPointerUp(){
    if(!this._drawing) return;
    this._drawing=false;
    if(this._points.length>2){
      Selection.setLasso(this._points, this.mode);
      Hist.snapshot('選取範圍');
    }
    this._points=[];
  }
  drawOverlay(oc){
    if(!this._drawing||this._points.length<2) return;
    oc.save();
    oc.strokeStyle='white'; oc.lineWidth=1; oc.setLineDash([3,3]);
    oc.beginPath();
    oc.moveTo(this._points[0].x, this._points[0].y);
    this._points.slice(1).forEach(p=>oc.lineTo(p.x,p.y));
    oc.stroke();
    oc.restore();
  }
}

/* ═══════════════════════════════════════════
   10. Polygon Selection Tool
   ═══════════════════════════════════════════ */
class PolygonSelectTool {
  constructor() {
    this.label = '多邊形選取'; this.cursor = 'crosshair';
    this._points = [];   // placed vertices
    this._active = false;
    this._lastClickTime = 0;
    this._lastClickX = 0; this._lastClickY = 0;
  }
  get mode() { return App.selection.mode || 'new'; }

  deactivate() {
    this._points = []; this._active = false;
    Engine.drawOverlay();
  }

  onKeyDown(e) {
    if (e.key === 'Escape' && this._active) {
      this._points = []; this._active = false;
      Engine.drawOverlay();
      e.preventDefault();
    }
  }

  onPointerDown(e, x, y) {
    const now = Date.now();
    const SNAP_R = 8 / App.zoom;   // 8 screen-pixels snap radius
    // Double-click: second click within 300ms at almost the same position
    const distToLast = Math.hypot(x - this._lastClickX, y - this._lastClickY);
    const isDbl = this._active && (now - this._lastClickTime < 300) && (distToLast <= SNAP_R * 1.5);
    this._lastClickTime = now;
    this._lastClickX = x; this._lastClickY = y;

    if (!this._active) {
      // First click → start polygon
      this._active = true;
      this._points = [{x, y}];
      Engine.drawOverlay();
      return;
    }

    if (isDbl) {
      // Double-click: first click already added the last vertex, just close
      this._close();
      return;
    }

    // Click near start → snap-close (requires ≥ 3 vertices already placed)
    if (this._points.length >= 3 &&
        Math.hypot(x - this._points[0].x, y - this._points[0].y) <= SNAP_R) {
      this._close();
      return;
    }

    // Normal click → add vertex
    this._points.push({x, y});
    Engine.drawOverlay();
  }

  _close() {
    if (this._points.length >= 3) {
      Selection.setLasso(this._points, this.mode);
      Hist.snapshot('選取範圍');
    }
    this._points = []; this._active = false;
    Engine.drawOverlay();
  }

  drawOverlay(oc) {
    if (!this._active || this._points.length < 1) return;
    const pts = this._points;
    const cx = App._cursorX, cy = App._cursorY;
    const hasCursor = cx !== undefined;
    const SNAP_R = 8 / App.zoom;
    const nearStart = hasCursor && pts.length >= 3 &&
                      Math.hypot(cx - pts[0].x, cy - pts[0].y) <= SNAP_R;

    oc.save();

    // Edges so far + rubber-band line to cursor
    oc.strokeStyle = 'white'; oc.lineWidth = 1; oc.setLineDash([3, 3]);
    oc.beginPath();
    oc.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) oc.lineTo(pts[i].x, pts[i].y);
    if (hasCursor) oc.lineTo(nearStart ? pts[0].x : cx, nearStart ? pts[0].y : cy);
    oc.stroke();

    // Snap circle on start point when cursor hovers near it
    if (nearStart) {
      oc.setLineDash([]);
      oc.strokeStyle = 'rgba(255,220,50,0.9)'; oc.lineWidth = 1.5;
      oc.beginPath(); oc.arc(pts[0].x, pts[0].y, SNAP_R, 0, Math.PI*2); oc.stroke();
    }

    // Vertex dots (fixed screen size)
    const dotR = 3 / App.zoom;
    oc.setLineDash([]);
    oc.fillStyle = 'white'; oc.strokeStyle = 'rgba(0,0,0,0.6)'; oc.lineWidth = 0.5;
    pts.forEach(p => {
      oc.beginPath(); oc.arc(p.x, p.y, dotR, 0, Math.PI*2);
      oc.fill(); oc.stroke();
    });

    oc.restore();
  }
}

/* ═══════════════════════════════════════════
   11. Magic Wand Tool
   ═══════════════════════════════════════════ */
class MagicWandTool {
  constructor() { this.label='魔術棒'; this.cursor='crosshair'; }
  get mode()       { return App.selection.mode || 'new'; }
  get tolerance()  { return App.selection.tolerance ?? 32; }
  get contiguous() { return App.selection.contiguous ?? true; }

  onPointerDown(e, x, y) {
    let mode = this.mode;
    if (e.shiftKey) mode = 'add';
    else if (e.altKey)  mode = 'sub';
    Selection.magicWand(x, y, this.tolerance, mode, this.contiguous);
    Hist.snapshot('魔術棒選取');
  }
}

/* ═══════════════════════════════════════════
   11. Crop Tool
   ═══════════════════════════════════════════ */
class CropTool {
  constructor(){ this.label='裁切'; this.cursor='crosshair'; this._drawing=false; this._committed=false; this._sx=this._sy=this._ex=this._ey=0; }
  onPointerDown(e,x,y){
    if(this._committed){ this._apply(); return; }
    this._drawing=true; this._sx=x; this._sy=y; this._ex=x; this._ey=y;
  }
  onPointerMove(e,x,y){
    if(!this._drawing) return;
    this._ex=x; this._ey=y;
    Engine.drawOverlay();
  }
  onPointerUp(){
    if(!this._drawing) return;
    this._drawing=false;
    this._committed=true;
    Engine.drawOverlay();
  }
  _apply(){
    if(!this._committed) return;
    const x=Math.round(Math.min(this._sx,this._ex));
    const y=Math.round(Math.min(this._sy,this._ey));
    const w=Math.round(Math.abs(this._ex-this._sx));
    const h=Math.round(Math.abs(this._ey-this._sy));
    if(w<2||h<2){ this._committed=false; Engine.drawOverlay(); return; }
    App.cropDocument(x,y,w,h);
    this._committed=false;
    Engine.drawOverlay();
  }
  deactivate(){ this._committed=false; this._drawing=false; Engine.drawOverlay(); }
  drawOverlay(oc){
    const drawing=this._drawing;
    const committed=this._committed;
    if(!drawing&&!committed) return;
    const x=Math.min(this._sx,this._ex), y=Math.min(this._sy,this._ey);
    const w=Math.abs(this._ex-this._sx), h=Math.abs(this._ey-this._sy);
    oc.save();
    // dim outside
    oc.fillStyle='rgba(0,0,0,0.4)';
    oc.fillRect(0,0,App.docWidth,App.docHeight);
    oc.clearRect(x,y,w,h);
    oc.strokeStyle='white'; oc.lineWidth=1; oc.setLineDash([]);
    oc.strokeRect(x,y,w,h);
    // rule of thirds
    oc.strokeStyle='rgba(255,255,255,0.3)'; oc.lineWidth=0.5;
    oc.beginPath();
    oc.moveTo(x+w/3,y); oc.lineTo(x+w/3,y+h);
    oc.moveTo(x+2*w/3,y); oc.lineTo(x+2*w/3,y+h);
    oc.moveTo(x,y+h/3); oc.lineTo(x+w,y+h/3);
    oc.moveTo(x,y+2*h/3); oc.lineTo(x+w,y+2*h/3);
    oc.stroke();
    // corners
    const cs=8;
    oc.strokeStyle='white'; oc.lineWidth=2; oc.setLineDash([]);
    [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([cx,cy])=>{
      oc.beginPath();
      oc.moveTo(cx-(cx>x?cs:0),cy); oc.lineTo(cx+(cx<=x?cs:0),cy);
      oc.moveTo(cx,cy-(cy>y?cs:0)); oc.lineTo(cx,cy+(cy<=y?cs:0));
      oc.stroke();
    });
    if(committed){
      oc.fillStyle='rgba(255,255,255,0.9)';
      oc.font='12px sans-serif';
      oc.textAlign='center';
      oc.fillText(`${Math.round(w)}×${Math.round(h)} — 點擊確認，ESC取消`, x+w/2, y+h/2);
    }
    oc.restore();
  }
  onKeyDown(e){
    if(e.key==='Enter'&&this._committed) this._apply();
    if(e.key==='Escape'){ this._committed=false; this._drawing=false; Engine.drawOverlay(); }
  }
}

/* ═══════════════════════════════════════════
   11. Text Tool
   ═══════════════════════════════════════════ */
class TextTool {
  constructor(){
    this.label='文字'; this.cursor='text';
    this._active=false; this._x=0; this._y=0;
    this._editingLayer=null;
  }

  _size()          { return parseInt(document.getElementById('td-size')?.value||32)||32; }
  _font()          { return document.getElementById('td-font')?.value||'Arial'; }
  _bold()          { return document.getElementById('td-bold')?.classList.contains('active')||false; }
  _italic()        { return document.getElementById('td-italic')?.classList.contains('active')||false; }
  _uline()         { return document.getElementById('td-underline')?.classList.contains('active')||false; }
  _align()         { return document.getElementById('td-align')?.value||'left'; }
  _text()          { return document.getElementById('td-textarea')?.value||''; }
  _letterSpacing() { return parseFloat(document.getElementById('td-letter-spacing')?.value||0)||0; }
  _lineHeight()    { return parseFloat(document.getElementById('td-line-height')?.value||1.2)||1.2; }
  _fontStr(sz){ return `${this._italic()?'italic ':''}${this._bold()?'bold ':''}${sz}px "${this._font()}"`; }

  _openDialog(d) {
    if(d.font)  document.getElementById('td-font').value  = d.font;
    if(d.size)  document.getElementById('td-size').value  = d.size;
    if(d.align) document.getElementById('td-align').value = d.align;
    document.getElementById('td-bold').classList.toggle('active',      !!d.bold);
    document.getElementById('td-italic').classList.toggle('active',    !!d.italic);
    document.getElementById('td-underline').classList.toggle('active', !!d.underline);
    document.getElementById('td-letter-spacing').value = d.letterSpacing ?? 0;
    document.getElementById('td-line-height').value    = d.lineHeight    ?? 1.2;
    document.getElementById('td-textarea').value = d.text || '';
    document.getElementById('dlg-text').classList.remove('hidden');
    setTimeout(()=>document.getElementById('td-textarea').focus(), 0);
  }

  onPointerDown(e,x,y){
    if(this._active){ this._commit(); return; }
    this._active=true;
    const al=LayerMgr.active();
    if(al && al.type==='text' && !al.locked){
      // Edit existing text layer
      this._editingLayer=al;
      this._x=al.x; this._y=al.y;
      al.visible=false;
      Engine.composite();
      this._openDialog(al.textData||{});
    } else {
      // New text layer
      this._editingLayer=null;
      this._x=x; this._y=y;
      this._openDialog({});
    }
    Engine.drawOverlay();
  }

  _buildTextData(){
    return { text:this._text(), font:this._font(), size:this._size(),
             bold:this._bold(), italic:this._italic(), underline:this._uline(),
             align:this._align(), color:App.fgColor,
             letterSpacing:this._letterSpacing(), lineHeight:this._lineHeight() };
  }

  async _commit(){
    const td=this._buildTextData();
    if(td.text.trim()){
      if(this._editingLayer){
        this._editingLayer.textData=td;
        this._editingLayer.visible=true;
        await this._editingLayer.renderText();
        Hist.snapshot('編輯文字');
        Engine.composite();
        UI.refreshLayerPanel();
      } else {
        await LayerMgr.addTextLayer(td, Math.round(this._x), Math.round(this._y));
      }
    } else if(this._editingLayer){
      this._editingLayer.visible=true;
      Engine.composite();
    }
    this._cancel();
  }

  _cancel(){
    if(this._editingLayer){ this._editingLayer.visible=true; Engine.composite(); }
    this._editingLayer=null;
    this._active=false;
    document.getElementById('dlg-text').classList.add('hidden');
    Engine.drawOverlay();
  }

  deactivate(){ if(this._active) this._cancel(); }

  drawOverlay(oc){
    if(!this._active) return;
    const txt=this._text();
    if(!txt.trim()) return;
    const size=this._size();
    const align=this._align();
    const PAD=2; const lineH=size*this._lineHeight();
    oc.save();
    oc.font=this._fontStr(size);
    if('letterSpacing' in oc) oc.letterSpacing=`${this._letterSpacing()}px`;
    oc.fillStyle=App.fgColor||'#000';
    oc.textBaseline='top';
    let maxW=0;
    txt.split('\n').forEach(l=>{maxW=Math.max(maxW,oc.measureText(l).width);});
    const W=Math.ceil(maxW)+PAD*2;
    const anchorX=this._editingLayer?this._editingLayer.x:this._x;
    const anchorY=this._editingLayer?this._editingLayer.y:this._y;
    let drawX;
    if(align==='center')    {oc.textAlign='center';drawX=anchorX+W/2;}
    else if(align==='right'){oc.textAlign='right'; drawX=anchorX+W-PAD;}
    else                    {oc.textAlign='left';  drawX=anchorX+PAD;}
    txt.split('\n').forEach((line,i)=>oc.fillText(line,drawX,anchorY+PAD+i*lineH));
    oc.restore();
  }
}

/* ═══════════════════════════════════════════
   12. Gradient Tool
   ═══════════════════════════════════════════ */
class GradientTool {
  constructor(){ this.label='漸層'; this.cursor='crosshair'; this._drawing=false; this._sx=0; this._sy=0; }
  onPointerDown(e,x,y){ this._drawing=true; this._sx=x; this._sy=y; }
  onPointerMove(e,x,y){
    if(!this._drawing) return;
    this._ex=x; this._ey=y;
    Engine.drawOverlay();
  }
  onPointerUp(e,x,y){
    if(!this._drawing) return;
    this._drawing=false;
    const l=LayerMgr.active(); if(!l||l.locked||l.type==='text') return;
    Hist.snapshot('漸層');
    this._applyGradient(l, this._sx,this._sy, x, y);
    Engine.composite();
  }
  _applyGradient(layer, x1,y1,x2,y2){
    const type=App.gradient.type||'linear';
    const W=App.docWidth, H=App.docHeight;
    // Draw gradient to a temp canvas so we can mask it without touching layer pixels outside selection
    const tmpC=document.createElement('canvas'); tmpC.width=W; tmpC.height=H;
    const tc=tmpC.getContext('2d');
    const {r:r1,g:g1,b:b1}=hexToRgb(App.fgColor);
    const {r:r2,g:g2,b:b2}=hexToRgb(App.bgColor);
    let grad;
    if(type==='radial'){
      const radius=Math.hypot(x2-x1,y2-y1);
      grad=tc.createRadialGradient(x1,y1,0,x1,y1,radius);
    } else {
      grad=tc.createLinearGradient(x1,y1,x2,y2);
    }
    grad.addColorStop(0,`rgba(${r1},${g1},${b1},1)`);
    grad.addColorStop(1,`rgba(${r2},${g2},${b2},1)`);
    tc.fillStyle=grad;
    tc.fillRect(0,0,W,H);
    // Clip gradient to selection if active
    if(!Selection.empty()){
      tc.globalCompositeOperation='destination-in';
      tc.drawImage(Selection.getMaskCanvas(),0,0);
      tc.globalCompositeOperation='source-over';
    }
    // Apply with layer offset so doc-space gradient maps to layer-local coords
    layer.ctx.drawImage(tmpC, -layer.x, -layer.y);
  }
  drawOverlay(oc){
    if(!this._drawing) return;
    oc.save();
    oc.strokeStyle='rgba(255,255,255,0.7)'; oc.lineWidth=1; oc.setLineDash([4,4]);
    oc.beginPath(); oc.moveTo(this._sx,this._sy); oc.lineTo(this._ex||this._sx,this._ey||this._sy); oc.stroke();
    oc.restore();
  }
}

/* ═══════════════════════════════════════════
   13. Hand Tool  (pan)
   ═══════════════════════════════════════════ */
class HandTool {
  constructor(){ this.label='手形'; this.cursor='hand'; this._dragging=false; this._sx=0; this._sy=0; this._sslX=0; this._sslY=0; }
  onPointerDown(e,x,y){
    this._dragging=true;
    this._sx=e.clientX; this._sy=e.clientY;
    const sa=document.getElementById('canvas-scroll-area');
    this._sslX=sa.scrollLeft; this._sslY=sa.scrollTop;
    document.getElementById('overlay-canvas').className='cursor-hand-grabbing';
  }
  onPointerMove(e,x,y){
    if(!this._dragging) return;
    const sa=document.getElementById('canvas-scroll-area');
    sa.scrollLeft=this._sslX-(e.clientX-this._sx);
    sa.scrollTop =this._sslY-(e.clientY-this._sy);
    Ruler.draw();
  }
  onPointerUp(){ this._dragging=false; document.getElementById('overlay-canvas').className='cursor-hand'; }
}

/* ═══════════════════════════════════════════
   14. Zoom Tool
   ═══════════════════════════════════════════ */
class ZoomToolImpl {
  constructor(){ this.label='縮放'; this.cursor='zoom'; }
  onPointerDown(e,x,y){
    if(e.altKey) ZoomPan.zoomOut(e.clientX, e.clientY);
    else ZoomPan.zoomIn(e.clientX, e.clientY);
  }
}

/* ═══════════════════════════════════════════
   15. Clone Stamp
   ═══════════════════════════════════════════ */
class CloneStampTool {
  constructor(){ this.label='仿製印章'; this.cursor='crosshair'; this._drawing=false; this._src=null; this._srcSet=false; this._lx=0; this._ly=0; this._ox=0; this._oy=0; }
  get size()       { return App.stamp.size; }
  get opacity()    { return App.stamp.opacity; }
  get hardness()   { return App.stamp.hardness; }
  get brushShape() { return App.stamp.brushShape; }
  onPointerDown(e,x,y){
    if(e.altKey){ this._src={x,y}; this._srcSet=false; return; }
    if(!this._src) return;
    const l=LayerMgr.active(); if(!l||l.locked||l.type==='text') return;
    if(!this._srcSet){ this._srcSet=true; this._ox=x-this._src.x; this._oy=y-this._src.y; }
    this._drawing=true; this._lx=x; this._ly=y;
    this._stamp(l,x,y);
    Engine.composite();
  }
  onPointerMove(e,x,y){
    if(!this._drawing) return;
    const l=LayerMgr.active(); if(!l) return;
    const dist=Math.hypot(x-this._lx,y-this._ly);
    const step=Math.max(1,this.size*0.2);
    if(dist<step) return;
    this._stamp(l,x,y);
    this._lx=x; this._ly=y;
    Engine.composite();
  }
  onPointerUp(){ if(this._drawing){ Hist.snapshot('仿製印章'); this._drawing=false; } }
  _stamp(layer,x,y){
    const sx=x-this._ox, sy=y-this._oy;
    const r=this.size/2;
    const W=App.docWidth, H=App.docHeight;
    const hard=this.hardness, shape=this.brushShape;
    // Sample from composite
    const pw=Math.max(1,Math.round(r*2)), ph=Math.max(1,Math.round(r*2));
    const sample=Engine.mainCtx.getImageData(Math.round(sx-r),Math.round(sy-r),pw,ph);
    const tmp=document.createElement('canvas');
    tmp.width=pw; tmp.height=ph;
    const tc=tmp.getContext('2d');
    tc.putImageData(sample,0,0);
    // Apply shape mask with feathering
    const cx=pw/2, cy=ph/2;
    if(shape==='circle'){
      if(hard>=99){
        // Hard circle clip
        const mask=document.createElement('canvas'); mask.width=pw; mask.height=ph;
        const mc=mask.getContext('2d');
        mc.beginPath(); mc.arc(cx,cy,r,0,Math.PI*2); mc.fill();
        tc.globalCompositeOperation='destination-in';
        tc.drawImage(mask,0,0);
      } else {
        // Soft radial gradient mask
        const h=hard/100, p=1+2*(1-h);
        const grad=tc.createRadialGradient(cx,cy,r*h,cx,cy,r);
        [0,0.25,0.5,0.75,1].forEach(t=>grad.addColorStop(t,`rgba(0,0,0,${Math.pow(1-t,p).toFixed(4)})`));
        tc.globalCompositeOperation='destination-in';
        tc.fillStyle=grad;
        tc.beginPath(); tc.arc(cx,cy,r,0,Math.PI*2); tc.fill();
      }
    } else {
      // Square shape
      if(hard<99){
        // Soft corners via radial gradient from center to corner
        const h=hard/100, rCorner=Math.sqrt(2)*r, p=1+2*(1-h);
        const grad=tc.createRadialGradient(cx,cy,rCorner*h,cx,cy,rCorner);
        [0,0.25,0.5,0.75,1].forEach(t=>grad.addColorStop(t,`rgba(0,0,0,${Math.pow(1-t,p).toFixed(4)})`));
        tc.globalCompositeOperation='destination-in';
        tc.fillStyle=grad;
        tc.fillRect(0,0,pw,ph);
      }
      // Hard square needs no mask (already rectangular)
    }
    tc.globalCompositeOperation='source-over';
    // Draw stamp onto a doc-sized temp canvas at doc coords
    const fullC=document.createElement('canvas'); fullC.width=W; fullC.height=H;
    const fc=fullC.getContext('2d');
    fc.globalAlpha=this.opacity/100;
    fc.drawImage(tmp,Math.round(x-r),Math.round(y-r));
    fc.globalAlpha=1;
    if (!Selection.empty()) {
      fc.globalCompositeOperation='destination-in';
      fc.drawImage(Selection.getMaskCanvas(),0,0);
    }
    // Map doc-space → layer-space with (-lx, -ly) offset
    layer.ctx.drawImage(fullC, -layer.x, -layer.y);
  }
}

/* ═══════════════════════════════════════════
   Transform Tool  (scale × 8 handles + rotate)
   ═══════════════════════════════════════════ */
class TransformTool {
  // mode: 'free' (scale+rotate+move) | 'scale' (scale+move) | 'rotate' (rotate+move)
  constructor(mode='free') {
    this.mode = mode;
    this.label = { free:'自由變形', scale:'縮放', rotate:'旋轉' }[mode];
    this.cursor = 'crosshair';
    this._st = null;
  }

  get _canScale()  { return this.mode === 'free' || this.mode === 'scale'; }
  get _canRotate() { return this.mode === 'free' || this.mode === 'rotate'; }

  activate() {
    if (!this._st) this._begin();
    else { this._renderFloat(); Engine.composite(); Engine.drawOverlay(); }
  }
  deactivate() {
    if (this._st) { this._st.prevToolName = null; this._commit(); }
    document.getElementById('overlay-canvas').style.cursor = '';
  }

  /* ─────── Setup ─────── */
  _begin() {
    const l = LayerMgr.active(); if (!l) return;
    const lx=l.x, ly=l.y, lw=l.canvas.width, lh=l.canvas.height;
    const hasSel = !Selection.empty();

    let bx,by,bw,bh;
    if (hasSel) { const b=Selection.bbox; bx=b.x; by=b.y; bw=b.w; bh=b.h; }
    else        { bx=lx; by=ly; bw=lw; bh=lh; }
    if (bw<=0||bh<=0) return;

    const origImgData = l.ctx.getImageData(0,0,lw,lh);

    const floatC = document.createElement('canvas');
    floatC.width=bw; floatC.height=bh;
    const floatCtx = floatC.getContext('2d');
    floatCtx.drawImage(l.canvas, lx-bx, ly-by);
    if (hasSel) {
      floatCtx.globalCompositeOperation='destination-in';
      floatCtx.drawImage(Selection.getMaskCanvas(), -bx, -by);
      floatCtx.globalCompositeOperation='source-over';
    }

    const cutC = document.createElement('canvas');
    cutC.width=lw; cutC.height=lh;
    const cutCtx = cutC.getContext('2d');
    cutCtx.drawImage(l.canvas,0,0);
    cutCtx.globalCompositeOperation='destination-out';
    if (hasSel) cutCtx.drawImage(Selection.getMaskCanvas(), -lx,-ly);
    else        cutCtx.clearRect(0,0,lw,lh);
    cutCtx.globalCompositeOperation='source-over';

    l.ctx.clearRect(0,0,lw,lh);
    l.ctx.drawImage(cutC,0,0);

    this._st = {
      l, origImgData, floatC, cutC,
      origW:bw, origH:bh,
      cx:bx+bw/2, cy:by+bh/2,
      w:bw, h:bh, angle:0,
      handle:null,
      snapCx:0, snapCy:0, snapW:0, snapH:0, snapAngle:0, dragX:0, dragY:0,
    };
    this._renderFloat();
    Engine.composite(); Engine.drawOverlay();
  }

  _cancel() {
    if (!this._st) return;
    const {l,origImgData,prevToolName}=this._st;
    l.ctx.putImageData(origImgData,0,0);
    this._st=null;
    document.getElementById('overlay-canvas').style.cursor='';
    Engine.composite(); Engine.drawOverlay();
    if (prevToolName) ToolMgr.activate(prevToolName);
  }

  _commit() {
    if (!this._st) return;
    const s=this._st, l=s.l;
    l.ctx.clearRect(0,0,l.canvas.width,l.canvas.height);
    l.ctx.drawImage(s.cutC,0,0);
    this._drawFloat(l.ctx, l.x, l.y, s);
    // Transform rasterizes text layers
    if(l.type==='text'){ l.type='image'; l.textData=null; }
    Hist.snapshot(s.commitLabel || this.label);
    Selection.deselect();
    const prevTool = s.prevToolName;
    this._st=null;
    document.getElementById('overlay-canvas').style.cursor='';
    Engine.composite(); Engine.drawOverlay();
    if (prevTool) ToolMgr.activate(prevTool);
  }

  _drawFloat(ctx, lx, ly, s) {
    if (s.w===0||s.h===0) return;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(s.cx-lx, s.cy-ly);
    ctx.rotate(s.angle);
    ctx.scale(s.w/s.origW, s.h/s.origH);
    // explicit dw/dh ensures supersampled floatC is drawn at logical origW×origH
    ctx.drawImage(s.floatC, -s.origW/2, -s.origH/2, s.origW, s.origH);
    ctx.restore();
  }

  _renderFloat() {
    const s=this._st, l=s.l;
    l.ctx.clearRect(0,0,l.canvas.width,l.canvas.height);
    l.ctx.drawImage(s.cutC,0,0);
    this._drawFloat(l.ctx, l.x, l.y, s);
  }

  /* ─────── Handle geometry ─────── */
  _handles() {
    const s=this._st;
    const hw=s.w/2, hh=s.h/2;
    const cos=Math.cos(s.angle), sin=Math.sin(s.angle);
    const pt=(lx,ly)=>({ x:s.cx+lx*cos-ly*sin, y:s.cy+lx*sin+ly*cos });
    return [
      pt(-hw,-hh), pt(0,-hh), pt(hw,-hh),
      pt(-hw,  0),            pt(hw,  0),
      pt(-hw, hh), pt(0, hh), pt(hw, hh),
    ];
  }

  _rotHandle() {
    const s=this._st;
    const off = s.h/2 + 22/App.zoom;
    const sin=Math.sin(s.angle), cos=Math.cos(s.angle);
    return { x: s.cx + off*sin, y: s.cy - off*cos };
  }

  /* ─────── Hit test ─────── */
  _hitTest(x,y) {
    const s=this._st, HR=8/App.zoom;
    if (this._canRotate) {
      const rh=this._rotHandle();
      if (Math.hypot(x-rh.x,y-rh.y)<=HR) return 'rotate';
    }
    if (this._canScale) {
      const names=['tl','tm','tr','ml','mr','bl','bm','br'];
      const hs=this._handles();
      for (let i=0;i<8;i++) if (Math.hypot(x-hs[i].x,y-hs[i].y)<=HR) return names[i];
    }
    const c=Math.cos(-s.angle), sn=Math.sin(-s.angle);
    const dx=x-s.cx, dy=y-s.cy;
    const lx=dx*c-dy*sn, ly=dx*sn+dy*c;
    if (Math.abs(lx)<=s.w/2 && Math.abs(ly)<=s.h/2) return 'move';
    return null;
  }

  /* ─────── Pointer events ─────── */
  onPointerDown(e,x,y) {
    if (!this._st) return;
    const hit=this._hitTest(x,y);
    if (!hit) { this._commit(); return; }
    const s=this._st;
    s.handle=hit; s.dragX=x; s.dragY=y;
    s.snapCx=s.cx; s.snapCy=s.cy;
    s.snapW=s.w;   s.snapH=s.h;
    s.snapAngle=s.angle;
  }

  onPointerMove(e,x,y) {
    if (!this._st) return;
    const s=this._st;
    this._setCursor(x,y);
    if (!s.handle) { Engine.drawOverlay(); return; }

    if (s.handle==='move') {
      s.cx=s.snapCx+(x-s.dragX);
      s.cy=s.snapCy+(y-s.dragY);
    } else if (s.handle==='rotate') {
      s.angle=Math.atan2(y-s.cy, x-s.cx)+Math.PI/2;
    } else {
      this._applyScale(e,x,y);
    }
    this._renderFloat();
    Engine.composite(); Engine.drawOverlay();
  }

  onPointerUp() { if (this._st) this._st.handle=null; }

  /* ─────── Scale (no-flip fix) ─────── */
  // Returns the fixed anchor point in local space for each handle
  _anchor(handle, hw, hh) {
    return {
      tl:[+hw,+hh], tm:[0,+hh], tr:[-hw,+hh],
      ml:[+hw,  0],             mr:[-hw,  0],
      bl:[+hw,-hh], bm:[0,-hh], br:[-hw,-hh],
    }[handle];
  }

  _applyScale(e,x,y) {
    const s=this._st;
    // Always use positive snap dimensions to avoid sign issues
    const hw=s.snapW/2, hh=s.snapH/2;
    const h=s.handle;

    // Transform cursor into snap-local (unrotated) space
    const c=Math.cos(-s.snapAngle), sn=Math.sin(-s.snapAngle);
    const dx=x-s.snapCx, dy=y-s.snapCy;
    let clx=dx*c-dy*sn, cly=dx*sn+dy*c;

    const [alx,aly]=this._anchor(h,hw,hh);

    // Edge handles: lock the off-axis cursor to the anchor position
    // so newLCx/newLCy on that axis stays 0 (center unchanged)
    if (h==='tm'||h==='bm') clx=alx;
    if (h==='ml'||h==='mr') cly=aly;

    // Shift = aspect-ratio lock for corner handles
    const isCorner=['tl','tr','bl','br'].includes(h);
    if (e.shiftKey && isCorner && hw>0 && hh>0) {
      const dw=Math.abs(clx-alx), dh=Math.abs(cly-aly), asp=hw/hh;
      if (dw/dh>asp) cly=aly+Math.sign(cly-aly||1)*dw/asp;
      else           clx=alx+Math.sign(clx-alx||1)*dh*asp;
    }

    const MIN=2/App.zoom;
    // Use |cursor - anchor| so dimensions are ALWAYS positive → no flipping
    let newW=(h==='tm'||h==='bm') ? s.snapW : Math.max(MIN, Math.abs(clx-alx));
    let newH=(h==='ml'||h==='mr') ? s.snapH : Math.max(MIN, Math.abs(cly-aly));

    // New local center = midpoint between cursor and anchor (works for any drag direction)
    const newLCx=(h==='tm'||h==='bm') ? 0 : (clx+alx)/2;
    const newLCy=(h==='ml'||h==='mr') ? 0 : (cly+aly)/2;

    // Rotate new local center back to doc space
    const c2=Math.cos(s.snapAngle), s2=Math.sin(s.snapAngle);
    s.cx=s.snapCx+newLCx*c2-newLCy*s2;
    s.cy=s.snapCy+newLCx*s2+newLCy*c2;
    s.w=newW; s.h=newH;
  }

  /* ─────── Cursor ─────── */
  _setCursor(x,y) {
    const hit=this._hitTest(x,y);
    const map={
      tl:'nw-resize', tm:'n-resize',  tr:'ne-resize',
      ml:'w-resize',                   mr:'e-resize',
      bl:'sw-resize', bm:'s-resize',  br:'se-resize',
      rotate:'grab',  move:'move',
    };
    document.getElementById('overlay-canvas').style.cursor = hit ? (map[hit]||'crosshair') : 'crosshair';
  }

  /* ─────── Overlay ─────── */
  drawOverlay(oc) {
    if (!this._st) return;
    const hs=this._handles();
    const lw=1.5/App.zoom, HR=5/App.zoom;

    oc.save();
    oc.setLineDash([]);

    // Box outline
    oc.beginPath();
    oc.moveTo(hs[0].x,hs[0].y); oc.lineTo(hs[2].x,hs[2].y);
    oc.lineTo(hs[7].x,hs[7].y); oc.lineTo(hs[5].x,hs[5].y);
    oc.closePath();
    oc.strokeStyle='rgba(74,158,255,0.9)'; oc.lineWidth=lw; oc.stroke();

    if (this._canRotate) {
      const rh=this._rotHandle();
      // Stem line from TM to rotation handle
      oc.beginPath(); oc.moveTo(hs[1].x,hs[1].y); oc.lineTo(rh.x,rh.y);
      oc.strokeStyle='rgba(74,158,255,0.7)'; oc.stroke();
      // Rotation handle circle
      oc.beginPath(); oc.arc(rh.x,rh.y,HR,0,Math.PI*2);
      oc.fillStyle='rgba(74,158,255,0.9)'; oc.fill();
      oc.strokeStyle='white'; oc.lineWidth=lw; oc.stroke();
    }

    if (this._canScale) {
      hs.forEach(h=>{
        oc.beginPath(); oc.arc(h.x,h.y,HR,0,Math.PI*2);
        oc.fillStyle='white'; oc.fill();
        oc.strokeStyle='rgba(0,80,200,0.8)'; oc.lineWidth=lw; oc.stroke();
      });
    }

    // Rotate-only mode: draw a centre crosshair so there's a visual anchor
    if (this.mode==='rotate') {
      const {cx,cy}=this._st, CR=7/App.zoom;
      oc.strokeStyle='rgba(74,158,255,0.9)'; oc.lineWidth=lw;
      oc.beginPath(); oc.moveTo(cx-CR,cy); oc.lineTo(cx+CR,cy); oc.stroke();
      oc.beginPath(); oc.moveTo(cx,cy-CR); oc.lineTo(cx,cy+CR); oc.stroke();
    }

    oc.restore();
  }

  /* ─────── Key ─────── */
  onKeyDown(e) {
    if (!this._st) return;
    if (e.key==='Enter')  { e.preventDefault(); this._commit(); }
    if (e.key==='Escape') { e.preventDefault(); this._cancel(); }
  }
}

/* ═══════════════════════════════════════════
   AI Tools
   ═══════════════════════════════════════════ */
class AiRmbgTool {
  constructor() { this.label = 'AI 去背'; this.cursor = 'crosshair'; }
  activate()    { AiRmbg.open(); }
}

class AiInpaintTool {
  constructor() { this.label = 'AI 移除物體'; this.cursor = 'crosshair'; }
  activate()    { AiInpaint.open(); }
}

class AiUpsampleTool {
  constructor() { this.label = 'AI 放大'; this.cursor = 'crosshair'; }
  activate()    { AiUpsample.open(); }
}

class AiSamTool {
  constructor() { this.label = 'AI 智慧選取'; this.cursor = 'crosshair'; }

  activate()   { AiSam.open(); }
  deactivate() { AiSam._clearPoints(); }

  onPointerDown(e, x, y) {
    if (!App.docWidth) return;
    const addMode = e.shiftKey || e.altKey;
    const label   = e.altKey ? 0 : 1;
    AiSam.runPoint(Math.round(x), Math.round(y), label, addMode);
  }

  drawOverlay(oc) {
    const points = AiSam.getPoints();
    if (!points.length) return;
    points.forEach(p => {
      const r = 6;
      oc.beginPath();
      oc.arc(p.x, p.y, r, 0, Math.PI * 2);
      oc.fillStyle   = p.label === 1 ? 'rgba(0,200,100,0.9)' : 'rgba(220,50,50,0.9)';
      oc.fill();
      oc.strokeStyle = 'white';
      oc.lineWidth   = 2;
      oc.stroke();
      oc.fillStyle    = 'white';
      oc.font         = 'bold 11px sans-serif';
      oc.textAlign    = 'center';
      oc.textBaseline = 'middle';
      oc.fillText(p.label === 1 ? '+' : '\u2212', p.x, p.y);
    });
  }
}

class AiOutpaintTool {
  constructor() { this.label = 'AI 擴展畫面'; this.cursor = 'default'; }
  activate()   { AiOutpaint.open(); }
}

/* ═══════════════════════════════════════════
   Shape Draw Tools
   直線 / 矩形 / 圓角矩形 / 橢圓形 / 箭頭線 / 多邊形
   ═══════════════════════════════════════════ */

/* ── 箭頭繪製 helper（共用）
   globalAlpha 由呼叫端 ctx 狀態繼承，此函式不覆寫 ── */
function drawArrowHead(ctx, ex, ey, ang, lw) {
  const style = App.shape.arrowStyle || 'filled';
  const hAng  = style === 'wide' ? Math.PI / 4 : Math.PI / 6;
  const hLen  = Math.max(12, lw * 4);
  ctx.save();
  ctx.setLineDash([]);
  if (style === 'open') {
    ctx.strokeStyle = App.fgColor;
    ctx.lineWidth   = lw;
    ctx.lineCap     = 'round';
    ctx.beginPath();
    ctx.moveTo(ex - hLen * Math.cos(ang - hAng), ey - hLen * Math.sin(ang - hAng));
    ctx.lineTo(ex, ey);
    ctx.lineTo(ex - hLen * Math.cos(ang + hAng), ey - hLen * Math.sin(ang + hAng));
    ctx.stroke();
  } else {
    ctx.fillStyle = App.fgColor;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - hLen * Math.cos(ang - hAng), ey - hLen * Math.sin(ang - hAng));
    ctx.lineTo(ex - hLen * Math.cos(ang + hAng), ey - hLen * Math.sin(ang + hAng));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/* 線段終點縮進量：空心箭頭不縮（線直接到尖端），實心/寬縮進 70% 藏住圓角 */
function arrowInset(lw) {
  const style = App.shape.arrowStyle || 'filled';
  return style === 'open' ? 0 : Math.max(12, lw * 4) * 0.7;
}

// Dash patterns stored as lineWidth multipliers so gaps stay visible at any thickness
const SHAPE_DASH_SCALE = {
  'solid':     [],
  'dash':      [4, 3],
  'long-dash': [8, 3],
  'dot':       [1, 3],
  'dash-dot':  [6, 3, 1, 3],
};

class ShapeDrawTool {
  constructor(shapeType) {
    this.shapeType = shapeType;
    const labels = {
      line:         '直線',
      rect:         '矩形',
      round:        '圓角矩形',
      ellipse:      '橢圓形',
      arrow:        '箭頭線',
      polygon:      '多邊形',
      star:         '星形',
      'arrow-shape':'箭頭形',
    };
    this.label  = labels[shapeType] || shapeType;
    this.cursor = 'crosshair';
    this._active = false;
    this._sx = 0; this._sy = 0;
    this._ex = 0; this._ey = 0;
    this._shift = false;
    this._alt   = false;
  }

  onPointerDown(e, x, y) {
    const l = LayerMgr.active();
    if (!l || l.locked || l.type === 'text') return;
    this._active = true;
    this._sx = x; this._sy = y;
    this._ex = x; this._ey = y;
    this._shift = e.shiftKey;
    this._alt   = e.altKey;
    Engine.drawOverlay();
  }

  onPointerMove(e, x, y) {
    if (!this._active) return;
    this._shift = e.shiftKey;
    this._alt   = e.altKey;
    [this._ex, this._ey] = this._constrain(this._sx, this._sy, x, y, e.shiftKey);
    Engine.drawOverlay();
  }

  onPointerUp(e, x, y) {
    if (!this._active) return;
    this._shift = e.shiftKey;
    this._alt   = e.altKey;
    [this._ex, this._ey] = this._constrain(this._sx, this._sy, x, y, e.shiftKey);
    this._active = false;
    const [sx, sy, ex, ey] = this._getCoords();
    // Discard near-zero size strokes
    if (this.shapeType === 'line' || this.shapeType === 'arrow') {
      if (Math.hypot(ex - sx, ey - sy) < 2) { Engine.drawOverlay(); return; }
    } else {
      if (Math.abs(ex - sx) < 2 && Math.abs(ey - sy) < 2) { Engine.drawOverlay(); return; }
    }
    this._commit();
  }

  deactivate() {
    this._active = false;
    Engine.drawOverlay();
  }

  /* ── Shift constraint ── */
  _constrain(sx, sy, ex, ey, shift) {
    if (!shift) return [ex, ey];
    const dx = ex - sx, dy = ey - sy;
    if (this.shapeType === 'line' || this.shapeType === 'arrow') {
      // Snap to nearest 45° angle
      const angle = Math.atan2(dy, dx);
      const snap  = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
      const dist  = Math.hypot(dx, dy);
      return [
        sx + Math.round(Math.cos(snap) * dist),
        sy + Math.round(Math.sin(snap) * dist),
      ];
    } else {
      // Force square / circle
      const d = Math.min(Math.abs(dx), Math.abs(dy));
      return [sx + Math.sign(dx) * d, sy + Math.sign(dy) * d];
    }
  }

  /* ── Alt = draw from center ── */
  _getCoords() {
    let sx = this._sx, sy = this._sy, ex = this._ex, ey = this._ey;
    if (this._alt && this.shapeType !== 'line' && this.shapeType !== 'arrow') {
      sx = 2 * this._sx - ex;
      sy = 2 * this._sy - ey;
    }
    return [sx, sy, ex, ey];
  }

  /* ── Apply canvas style (shared by preview and commit) ── */
  _applyCtxStyle(ctx, preview) {
    const s = App.shape;
    ctx.globalAlpha   = preview ? Math.min(s.opacity / 100, 0.85) : s.opacity / 100;
    const lw = Math.max(1, s.lineWidth);
    ctx.lineWidth     = lw;
    ctx.lineCap       = 'round';
    ctx.lineJoin      = 'round';
    const scale = SHAPE_DASH_SCALE[s.dash];
    ctx.setLineDash(scale && scale.length ? scale.map(v => v * lw) : []);
    ctx.lineDashOffset = 0;
    ctx.strokeStyle   = App.fgColor;
    ctx.fillStyle     = App.bgColor;
  }

  /* ── Render shape to any ctx ── */
  _renderShape(ctx, sx, sy, ex, ey) {
    const s    = App.shape;
    const mode = (this.shapeType === 'line' || this.shapeType === 'arrow') ? 'stroke' : s.fillMode;
    const x = Math.min(sx, ex), y = Math.min(sy, ey);
    const w = Math.abs(ex - sx),  h = Math.abs(ey - sy);

    ctx.beginPath();
    switch (this.shapeType) {

      case 'line': {
        const dir = s.arrowDir || 'none';
        const ang  = Math.atan2(ey - sy, ex - sx);
        const lw   = ctx.lineWidth;
        if (dir === 'none') {
          ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
        } else {
          const ins  = arrowInset(lw);
          const si   = (dir === 'start' || dir === 'both') ? ins : 0;
          const ei   = (dir === 'end'   || dir === 'both') ? ins : 0;
          ctx.moveTo(sx + si * Math.cos(ang), sy + si * Math.sin(ang));
          ctx.lineTo(ex - ei * Math.cos(ang), ey - ei * Math.sin(ang));
          ctx.stroke();
          if (dir === 'end'   || dir === 'both') drawArrowHead(ctx, ex, ey, ang, lw);
          if (dir === 'start' || dir === 'both') drawArrowHead(ctx, sx, sy, ang + Math.PI, lw);
        }
        return;
      }

      case 'arrow': {
        // 保留向下相容（舊 shape-arrow 工具 id）
        const ang   = Math.atan2(ey - sy, ex - sx);
        const lw    = ctx.lineWidth;
        const inset = arrowInset(lw);
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex - inset * Math.cos(ang), ey - inset * Math.sin(ang));
        ctx.stroke();
        drawArrowHead(ctx, ex, ey, ang, lw);
        return;
      }

      case 'rect':
        ctx.rect(x, y, w, h);
        break;

      case 'round': {
        const r = Math.max(0, Math.min(s.cornerRadius, w / 2, h / 2));
        if (ctx.roundRect) {
          ctx.roundRect(x, y, w, h, r);
        } else {
          ctx.moveTo(x + r, y);
          ctx.lineTo(x + w - r, y);
          ctx.quadraticCurveTo(x + w, y,     x + w, y + r);
          ctx.lineTo(x + w, y + h - r);
          ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
          ctx.lineTo(x + r, y + h);
          ctx.quadraticCurveTo(x, y + h,     x, y + h - r);
          ctx.lineTo(x, y + r);
          ctx.quadraticCurveTo(x, y,         x + r, y);
          ctx.closePath();
        }
        break;
      }

      case 'ellipse':
        if (w > 0 && h > 0)
          ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        break;

      case 'polygon': {
        const sides = Math.max(3, s.polygonSides || 6);
        const cx = (sx + ex) / 2, cy = (sy + ey) / 2;
        const rx = w / 2,          ry = h / 2;
        for (let i = 0; i < sides; i++) {
          const a = (i / sides) * Math.PI * 2 - Math.PI / 2;
          const px = cx + rx * Math.cos(a);
          const py = cy + ry * Math.sin(a);
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath();
        break;
      }

      case 'star': {
        const pts   = Math.max(3, s.starPoints || 5);
        const ratio = Math.max(0.1, Math.min(0.9, s.starInnerRatio || 0.45));
        const cx = (sx + ex) / 2, cy = (sy + ey) / 2;
        const rx = w / 2, ry = h / 2;
        const total = pts * 2;
        for (let i = 0; i < total; i++) {
          const a  = (i / total) * Math.PI * 2 - Math.PI / 2;
          const r  = i % 2 === 0 ? 1 : ratio;
          const px = cx + rx * r * Math.cos(a);
          const py = cy + ry * r * Math.sin(a);
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath();
        break;
      }

      case 'arrow-shape': {
        // Block arrow: direction follows drag (ex>=sx → right, ex<sx → left)
        const headLen = w * Math.max(0.1, Math.min(0.9, s.arrowHeadRatio || 0.4));
        const bodyH   = h * Math.max(0.1, Math.min(0.95, s.arrowBodyRatio || 0.5));
        const shaftTop    = y + (h - bodyH) / 2;
        const shaftBottom = y + (h + bodyH) / 2;
        if (ex >= sx) {
          // pointing right →
          const neckX = x + w - headLen;
          ctx.moveTo(x,      shaftTop);
          ctx.lineTo(neckX,  shaftTop);
          ctx.lineTo(neckX,  y);
          ctx.lineTo(x + w,  y + h / 2);
          ctx.lineTo(neckX,  y + h);
          ctx.lineTo(neckX,  shaftBottom);
          ctx.lineTo(x,      shaftBottom);
        } else {
          // pointing left ←
          const neckX = x + headLen;
          ctx.moveTo(x + w,  shaftTop);
          ctx.lineTo(neckX,  shaftTop);
          ctx.lineTo(neckX,  y);
          ctx.lineTo(x,      y + h / 2);
          ctx.lineTo(neckX,  y + h);
          ctx.lineTo(neckX,  shaftBottom);
          ctx.lineTo(x + w,  shaftBottom);
        }
        ctx.closePath();
        break;
      }
    }

    if (mode === 'fill' || mode === 'both') ctx.fill();
    if (mode === 'stroke' || mode === 'both') ctx.stroke();
  }

  /* ── Overlay preview ── */
  drawOverlay(oc) {
    if (!this._active) return;
    const [sx, sy, ex, ey] = this._getCoords();
    oc.save();
    this._applyCtxStyle(oc, true);
    this._renderShape(oc, sx, sy, ex, ey);
    // Alt: show center crosshair marker
    if (this._alt && this.shapeType !== 'line' && this.shapeType !== 'arrow') {
      oc.setLineDash([]);
      oc.lineWidth   = 1;
      oc.globalAlpha = 0.7;
      oc.strokeStyle = 'rgba(255,255,255,0.9)';
      oc.beginPath();
      oc.moveTo(this._sx - 6, this._sy); oc.lineTo(this._sx + 6, this._sy);
      oc.moveTo(this._sx, this._sy - 6); oc.lineTo(this._sx, this._sy + 6);
      oc.stroke();
    }
    oc.restore();
  }

  /* ── Commit: render to floating canvas → auto-enter free transform ── */
  _commit() {
    const l = LayerMgr.active();
    if (!l || l.locked) return;
    const [sx, sy, ex, ey] = this._getCoords();

    // 直線工具直接合進圖層，不進入自由變形
    if (this.shapeType === 'line') {
      l.ctx.save();
      l.ctx.translate(-l.x, -l.y);
      this._applyCtxStyle(l.ctx, false);
      this._renderShape(l.ctx, sx, sy, ex, ey);
      l.ctx.restore();
      Hist.snapshot('繪製直線');
      Engine.composite(); Engine.drawOverlay();
      return;
    }

    // Bounding box in document space, padded for stroke width
    const lw  = Math.max(1, App.shape.lineWidth);
    const pad = Math.ceil(lw / 2) + 2;
    const bx  = Math.min(sx, ex) - pad;
    const by  = Math.min(sy, ey) - pad;
    const bw  = Math.max(1, Math.abs(ex - sx) + pad * 2);
    const bh  = Math.max(1, Math.abs(ey - sy) + pad * 2);

    // Snapshot layer state before shape (used by transform for cancel + background)
    const origImgData = l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height);
    const cutC = document.createElement('canvas');
    cutC.width = l.canvas.width; cutC.height = l.canvas.height;
    cutC.getContext('2d').drawImage(l.canvas, 0, 0);

    // Render shape into a 2× supersampled canvas for better anti-aliasing after transform
    const SS = 2;
    const floatC = document.createElement('canvas');
    floatC.width = bw * SS; floatC.height = bh * SS;
    const floatCtx = floatC.getContext('2d');
    floatCtx.save();
    floatCtx.scale(SS, SS);
    floatCtx.translate(-bx, -by);
    this._applyCtxStyle(floatCtx, false);
    this._renderShape(floatCtx, sx, sy, ex, ey);
    floatCtx.restore();

    // Pre-load TransformTool state with the floating shape
    const tfTool = ToolMgr.tools['transform-free'];
    const names  = { line:'直線', rect:'矩形', round:'圓角矩形', ellipse:'橢圓形', arrow:'箭頭線', polygon:'多邊形', star:'星形', 'arrow-shape':'箭頭形' };
    tfTool._st = {
      l, origImgData, floatC, cutC,
      origW: bw, origH: bh,
      cx: bx + bw / 2, cy: by + bh / 2,
      w: bw, h: bh, angle: 0,
      handle: null,
      snapCx: 0, snapCy: 0, snapW: 0, snapH: 0, snapAngle: 0, dragX: 0, dragY: 0,
      commitLabel: '繪製' + (names[this.shapeType] || '形狀'),
      prevToolName: ToolMgr.name,
    };

    // Switch to free transform — activate() detects pre-loaded _st and skips _begin()
    ToolMgr.activate('transform-free');
  }
}

/* ═══════════════════════════════════════════
   Curve Tool  —  小畫家三段式貝茲曲線
   Phase 0 → 拖出直線（P0→P3）
   Phase 1 → 拖拉第一個彎曲（二次貝茲預覽，mouseup 轉換成三次）
   Phase 2 → 拖拉第二個彎曲（三次貝茲），mouseup commit
   Escape  → 任意階段取消
   ═══════════════════════════════════════════ */
class CurveTool {
  constructor() {
    this.label  = '曲線';
    this.cursor = 'crosshair';
    this._phase    = 0;
    this._dragging = false;
    this._p0  = null;   // 起點
    this._p3  = null;   // 終點
    this._cpQ = null;   // phase1 二次貝茲控制點（raw drag）
    this._cp1 = null;   // 三次 CP1（由 cpQ 換算）
    this._cp2 = null;   // 三次 CP2（phase2 drag）
  }

  deactivate() { this._cancel(); }
  onEscape()   { this._cancel(); }

  _cancel() {
    this._phase = 0; this._dragging = false;
    this._cpQ = null; this._cp1 = null; this._cp2 = null;
    Engine.drawOverlay();
  }

  onPointerDown(e, x, y) {
    const l = LayerMgr.active();
    if (!l || l.locked || l.type === 'text') return;
    this._dragging = true;
    if (this._phase === 0) {
      this._p0 = {x, y};
      this._p3 = {x, y};
      // 清空前一筆殘留的控制點，避免 _endAngle 讀到舊值
      this._cpQ = null; this._cp1 = null; this._cp2 = null;
    }
    Engine.drawOverlay();
  }

  onPointerMove(e, x, y) {
    if (!this._p0) return;
    if (this._phase === 0 && !this._dragging) return;
    if (this._phase === 0) {
      if (e.shiftKey) [x, y] = this._snap45(this._p0.x, this._p0.y, x, y);
      this._p3 = {x, y};
    } else if (this._phase === 1 && this._dragging) {
      this._cpQ = {x, y};
    } else if (this._phase === 2 && this._dragging) {
      this._cp2 = {x, y};
    }
    Engine.drawOverlay();
  }

  onPointerUp(e, x, y) {
    if (!this._dragging) return;
    this._dragging = false;

    if (this._phase === 0) {
      if (e.shiftKey) [x, y] = this._snap45(this._p0.x, this._p0.y, x, y);
      this._p3 = {x, y};
      if (Math.hypot(x - this._p0.x, y - this._p0.y) < 3) { this._cancel(); return; }
      // 預設 cpQ 在中點（零彎曲）
      this._cpQ = { x: (this._p0.x + x) / 2, y: (this._p0.y + y) / 2 };
      this._phase = 1;

    } else if (this._phase === 1) {
      this._cpQ = {x, y};
      // 二次貝茲 → 三次換算
      this._cp1 = {
        x: this._p0.x + (2/3) * (this._cpQ.x - this._p0.x),
        y: this._p0.y + (2/3) * (this._cpQ.y - this._p0.y),
      };
      // CP2 初始值：P3 方向的對稱點（保持 phase1 形狀不跳變）
      this._cp2 = {
        x: this._p3.x + (2/3) * (this._cpQ.x - this._p3.x),
        y: this._p3.y + (2/3) * (this._cpQ.y - this._p3.y),
      };
      this._phase = 2;

    } else if (this._phase === 2) {
      this._cp2 = {x, y};
      this._commit();
      this._phase = 0;
    }
    Engine.drawOverlay();
  }

  /* ── 45° 角鎖定 ── */
  _snap45(sx, sy, ex, ey) {
    const ang  = Math.atan2(ey - sy, ex - sx);
    const snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
    const d    = Math.hypot(ex - sx, ey - sy);
    return [sx + Math.round(Math.cos(snap) * d), sy + Math.round(Math.sin(snap) * d)];
  }

  /* ── 套用線段樣式（與 ShapeDrawTool 相同規則）── */
  _applyStyle(ctx, preview) {
    const s  = App.shape;
    const lw = Math.max(1, s.lineWidth);
    ctx.globalAlpha   = preview ? Math.min(s.opacity / 100, 0.85) : s.opacity / 100;
    ctx.lineWidth     = lw;
    ctx.lineCap       = 'round';
    ctx.lineJoin      = 'round';
    const sc = SHAPE_DASH_SCALE[s.dash];
    ctx.setLineDash(sc && sc.length ? sc.map(v => v * lw) : []);
    ctx.lineDashOffset = 0;
    ctx.strokeStyle   = App.fgColor;
  }

  /* 曲線繪製的有效起點／終點（子類可覆寫） */
  _curveStartP0() { return this._p0; }
  _curveEndP3()   { return this._p3; }

  /* ── Overlay 即時預覽 ── */
  drawOverlay(oc) {
    if (!this._p0) return;
    if (this._phase === 0 && !this._dragging) return;

    const sp = this._curveStartP0();  // 有效曲線起點
    const ep = this._curveEndP3();    // 有效曲線終點

    oc.save();
    this._applyStyle(oc, true);
    oc.beginPath();
    oc.moveTo(sp.x, sp.y);

    if (this._phase === 0) {
      // 直線預覽
      oc.lineTo(ep.x, ep.y);
      oc.stroke();

    } else if (this._phase === 1) {
      // 二次貝茲預覽（直接用 cpQ）
      const q = this._cpQ || this._p3;
      oc.quadraticCurveTo(q.x, q.y, ep.x, ep.y);
      oc.stroke();
      // CP 把手（連到原始 P3，也就是箭頭尖端）
      this._drawHandle1(oc, q);

    } else if (this._phase === 2) {
      // 三次貝茲預覽
      oc.bezierCurveTo(
        this._cp1.x, this._cp1.y,
        this._cp2.x, this._cp2.y,
        ep.x, ep.y
      );
      oc.stroke();
      // CP 把手
      this._drawHandle1(oc, this._cpQ);
      this._drawHandle2(oc, this._cp2);
    }

    oc.restore();
  }

  /* 黃色 CP1 把手（phase1 raw drag point，直觀顯示"拉力點"） */
  _drawHandle1(oc, q) {
    if (!q) return;
    oc.save();
    oc.globalAlpha = 0.75;
    oc.setLineDash([3, 4]);
    oc.lineWidth = 1;
    oc.strokeStyle = 'rgba(255,210,0,0.9)';
    oc.beginPath();
    oc.moveTo(this._p0.x, this._p0.y); oc.lineTo(q.x, q.y);
    oc.moveTo(this._p3.x, this._p3.y); oc.lineTo(q.x, q.y);
    oc.stroke();
    oc.setLineDash([]);
    oc.fillStyle   = 'rgba(255,210,0,0.95)';
    oc.strokeStyle = 'white';
    oc.lineWidth   = 1.5;
    oc.beginPath(); oc.arc(q.x, q.y, 5, 0, Math.PI * 2); oc.fill(); oc.stroke();
    oc.restore();
  }

  /* 藍色 CP2 把手（phase2，連接終點） */
  _drawHandle2(oc, cp2) {
    if (!cp2) return;
    oc.save();
    oc.globalAlpha = 0.75;
    oc.setLineDash([3, 4]);
    oc.lineWidth = 1;
    oc.strokeStyle = 'rgba(80,200,255,0.9)';
    oc.beginPath();
    oc.moveTo(this._p3.x, this._p3.y); oc.lineTo(cp2.x, cp2.y);
    oc.stroke();
    oc.setLineDash([]);
    oc.fillStyle   = 'rgba(80,200,255,0.95)';
    oc.strokeStyle = 'white';
    oc.lineWidth   = 1.5;
    oc.beginPath(); oc.arc(cp2.x, cp2.y, 5, 0, Math.PI * 2); oc.fill(); oc.stroke();
    oc.restore();
  }

  /* ── Commit 到圖層 ── */
  _commit() {
    const l = LayerMgr.active();
    if (!l || l.locked) return;
    const p0 = this._p0, p3 = this._p3;
    const cp1 = this._cp1, cp2 = this._cp2;

    const draw = (ctx, ox, oy) => {
      ctx.save();
      this._applyStyle(ctx, false);
      ctx.beginPath();
      ctx.moveTo(p0.x + ox, p0.y + oy);
      ctx.bezierCurveTo(
        cp1.x + ox, cp1.y + oy,
        cp2.x + ox, cp2.y + oy,
        p3.x  + ox, p3.y  + oy
      );
      ctx.stroke();
      ctx.restore();
    };

    if (!Selection.empty()) {
      _SB.begin(l.canvas);
      draw(_SB.bufCtx, 0, 0);
      _SB.flush(l, false);
    } else {
      draw(l.ctx, -l.x, -l.y);
    }
    Hist.snapshot('繪製曲線');
    Engine.composite();
    Engine.drawOverlay();
  }


  /* ── 終點切線角度 ── */
  _endAngle() {
    const p0 = this._p0, p3 = this._p3;
    if (!p0 || !p3) return 0;
    if (this._phase === 2 && this._cp2) {
      const dx = p3.x - this._cp2.x, dy = p3.y - this._cp2.y;
      if (Math.hypot(dx, dy) > 0.5) return Math.atan2(dy, dx);
    }
    if (this._phase >= 1 && this._cpQ) {
      const dx = p3.x - this._cpQ.x, dy = p3.y - this._cpQ.y;
      if (Math.hypot(dx, dy) > 0.5) return Math.atan2(dy, dx);
    }
    return Math.atan2(p3.y - p0.y, p3.x - p0.x);
  }

  /* ── 起點切線角度（反向）── */
  _startAngle() {
    const p0 = this._p0, p3 = this._p3;
    if (!p0 || !p3) return Math.PI;
    if (this._phase === 2 && this._cp1) {
      const dx = p0.x - this._cp1.x, dy = p0.y - this._cp1.y;
      if (Math.hypot(dx, dy) > 0.5) return Math.atan2(dy, dx);
    }
    if (this._phase >= 1 && this._cpQ) {
      const dx = p0.x - this._cpQ.x, dy = p0.y - this._cpQ.y;
      if (Math.hypot(dx, dy) > 0.5) return Math.atan2(dy, dx);
    }
    return Math.atan2(p0.y - p3.y, p0.x - p3.x);
  }

  /* 曲線繪製的有效起點／終點（依 arrowDir inset） */
  _curveStartP0() {
    const dir = App.shape.arrowDir || 'none';
    if ((dir === 'start' || dir === 'both') && this._p0 && this._p3) {
      const ang   = this._startAngle();
      const inset = arrowInset(Math.max(1, App.shape.lineWidth));
      return { x: this._p0.x - inset * Math.cos(ang), y: this._p0.y - inset * Math.sin(ang) };
    }
    return this._p0;
  }

  _curveEndP3() {
    const dir = App.shape.arrowDir || 'none';
    if ((dir === 'end' || dir === 'both') && this._p0 && this._p3) {
      const ang   = this._endAngle();
      const inset = arrowInset(Math.max(1, App.shape.lineWidth));
      return { x: this._p3.x - inset * Math.cos(ang), y: this._p3.y - inset * Math.sin(ang) };
    }
    return this._p3;
  }

  /* ── Overlay 即時預覽 ── */
  drawOverlay(oc) {
    if (!this._p0) return;
    if (this._phase === 0 && !this._dragging) return;

    const sp  = this._curveStartP0();
    const ep  = this._curveEndP3();
    const dir = App.shape.arrowDir || 'none';
    const s   = App.shape;
    const lw  = Math.max(1, s.lineWidth);

    oc.save();
    this._applyStyle(oc, true);
    oc.beginPath();
    oc.moveTo(sp.x, sp.y);

    if (this._phase === 0) {
      oc.lineTo(ep.x, ep.y);
      oc.stroke();
    } else if (this._phase === 1) {
      const q = this._cpQ || this._p3;
      oc.quadraticCurveTo(q.x, q.y, ep.x, ep.y);
      oc.stroke();
      this._drawHandle1(oc, q);
    } else if (this._phase === 2) {
      oc.bezierCurveTo(this._cp1.x, this._cp1.y, this._cp2.x, this._cp2.y, ep.x, ep.y);
      oc.stroke();
      this._drawHandle1(oc, this._cpQ);
      this._drawHandle2(oc, this._cp2);
    }

    // 箭頭疊加
    if (dir !== 'none') {
      oc.globalAlpha = Math.min(s.opacity / 100, 0.85);
      if (dir === 'end'   || dir === 'both') drawArrowHead(oc, this._p3.x, this._p3.y, this._endAngle(), lw);
      if (dir === 'start' || dir === 'both') drawArrowHead(oc, this._p0.x, this._p0.y, this._startAngle(), lw);
    }

    oc.restore();
  }

  /* ── Commit 到圖層 ── */
  _commit() {
    const l = LayerMgr.active();
    if (!l || l.locked) return;
    const p0  = this._p0, p3 = this._p3;
    const cp1 = this._cp1, cp2 = this._cp2;
    const dir = App.shape.arrowDir || 'none';
    const s   = App.shape;

    const draw = (ctx, ox, oy) => {
      const lw = Math.max(1, s.lineWidth);
      const sp = this._curveStartP0();
      const ep = this._curveEndP3();
      ctx.save();
      this._applyStyle(ctx, false);
      ctx.beginPath();
      ctx.moveTo(sp.x + ox, sp.y + oy);
      ctx.bezierCurveTo(cp1.x + ox, cp1.y + oy, cp2.x + ox, cp2.y + oy, ep.x + ox, ep.y + oy);
      ctx.stroke();
      if (dir === 'end'   || dir === 'both') drawArrowHead(ctx, p3.x + ox, p3.y + oy, this._endAngle(),   lw);
      if (dir === 'start' || dir === 'both') drawArrowHead(ctx, p0.x + ox, p0.y + oy, this._startAngle(), lw);
      ctx.restore();
    };

    if (!Selection.empty()) {
      _SB.begin(l.canvas);
      draw(_SB.bufCtx, 0, 0);
      _SB.flush(l, false);
    } else {
      draw(l.ctx, -l.x, -l.y);
    }
    Hist.snapshot('繪製曲線');
    Engine.composite();
    Engine.drawOverlay();
  }
}

/* ── PolylineTool ── */
class PolylineTool {
  constructor() {
    this.label  = '折線';
    this._pts   = [];
    this._active = false;
    this._lastClickTime = 0;
    this._lastClickX = 0; this._lastClickY = 0;
  }

  _applyStyle(ctx) {
    const s  = App.shape;
    const lw = Math.max(1, s.lineWidth);
    ctx.strokeStyle = App.fgColor;
    ctx.lineWidth   = lw;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.globalAlpha = (s.opacity ?? 100) / 100;
    const scale = SHAPE_DASH_SCALE[s.dash] || [];
    ctx.setLineDash(scale.length ? scale.map(v => v * lw) : []);
  }

  onPointerDown(e, x, y) {
    const now = Date.now();
    const SNAP_R = 8 / App.zoom;
    const distToLast = Math.hypot(x - this._lastClickX, y - this._lastClickY);
    const isDbl = this._active && (now - this._lastClickTime < 300) && (distToLast <= SNAP_R * 2);
    this._lastClickTime = now;
    this._lastClickX = x; this._lastClickY = y;

    if (!this._active) {
      this._pts   = [{ x, y }];
      this._active = true;
      Engine.drawOverlay();
      return;
    }

    if (isDbl) {
      // Double-click: finalise (last single-click already added prev point)
      if (this._pts.length >= 2) this._commit();
      else this._cancel();
      return;
    }

    this._pts.push({ x, y });
    Engine.drawOverlay();
  }

  onPointerMove(e, x, y) {
    if (!this._active) return;
    Engine.drawOverlay();
  }

  onPointerUp() { /* clicks handled in Down */ }

  onEnter() {
    if (this._pts.length >= 2) this._commit();
  }

  onEscape() { this._cancel(); }

  deactivate() { this._cancel(); }

  drawOverlay(oc) {
    if (!this._active || this._pts.length === 0) return;
    const s   = App.shape;
    const pts = this._pts;
    const cx  = App._cursorX, cy = App._cursorY;
    const lw  = Math.max(1, s.lineWidth);
    const dir = s.arrowDir || 'none';
    const ins = arrowInset(lw);
    const last = pts.length - 1;

    // 計算游標段箭頭方向（游標到最後一點擊點的方向）
    const hasCursor = cx !== undefined;
    const cursorDx = hasCursor ? cx - pts[last].x : 0;
    const cursorDy = hasCursor ? cy - pts[last].y : 0;
    const cursorDist = Math.hypot(cursorDx, cursorDy);
    const cursorAng  = cursorDist > 0.5 ? Math.atan2(cursorDy, cursorDx) : null;

    oc.save();
    this._applyStyle(oc);
    oc.beginPath();
    oc.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) oc.lineTo(pts[i].x, pts[i].y);
    // 游標段：終點箭頭時縮進，避免線段末端伸出箭頭
    if (hasCursor) {
      if ((dir === 'end' || dir === 'both') && cursorAng !== null) {
        oc.lineTo(cx - ins * Math.cos(cursorAng), cy - ins * Math.sin(cursorAng));
      } else {
        oc.lineTo(cx, cy);
      }
    }
    if (s.polylineClose && pts.length >= 2) oc.closePath();
    oc.stroke();

    // 箭頭預覽：終點箭頭跟隨游標
    if (dir !== 'none') {
      if (dir === 'end' || dir === 'both') {
        if (hasCursor && cursorAng !== null) {
          // 游標處顯示箭頭（≥1 個點即可）
          drawArrowHead(oc, cx, cy, cursorAng, lw);
        } else if (pts.length >= 2) {
          // 游標未動或不可用：顯示在最後一個點
          const ang = Math.atan2(pts[last].y - pts[last-1].y, pts[last].x - pts[last-1].x);
          drawArrowHead(oc, pts[last].x, pts[last].y, ang, lw);
        }
      }
      if ((dir === 'start' || dir === 'both') && pts.length >= 2) {
        const ang = Math.atan2(pts[0].y - pts[1].y, pts[0].x - pts[1].x);
        drawArrowHead(oc, pts[0].x, pts[0].y, ang, lw);
      }
    }
    // vertex handles
    oc.setLineDash([]);
    oc.fillStyle = '#fff';
    oc.strokeStyle = App.fgColor;
    oc.lineWidth = 1;
    oc.globalAlpha = 0.8;
    for (const p of pts) {
      oc.beginPath();
      oc.arc(p.x, p.y, 4, 0, Math.PI * 2);
      oc.fill(); oc.stroke();
    }
    oc.restore();
  }

  _commit() {
    const l = LayerMgr.active();
    if (!l || l.locked) { this._cancel(); return; }
    const pts = this._pts.slice();
    const s   = App.shape;
    const dir = s.arrowDir || 'none';

    const draw = (ctx, ox, oy) => {
      const lw  = Math.max(1, s.lineWidth);
      const ins = arrowInset(lw);
      ctx.save();
      this._applyStyle(ctx);
      ctx.beginPath();
      ctx.moveTo(pts[0].x + ox, pts[0].y + oy);
      if (dir !== 'none' && pts.length >= 2) {
        const last = pts.length - 1;
        // 起點縮進（有起點箭頭時）
        const startIns = (dir === 'start' || dir === 'both') ? ins : 0;
        // 終點縮進（有終點箭頭時）
        const endIns   = (dir === 'end'   || dir === 'both') ? ins : 0;
        const angS = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
        const angE = Math.atan2(pts[last].y - pts[last-1].y, pts[last].x - pts[last-1].x);
        // 第一段起點縮進
        ctx.moveTo(pts[0].x + ox + startIns * Math.cos(angS),
                   pts[0].y + oy + startIns * Math.sin(angS));
        for (let i = 1; i < last; i++) ctx.lineTo(pts[i].x + ox, pts[i].y + oy);
        // 最後一段終點縮進
        ctx.lineTo(pts[last].x + ox - endIns * Math.cos(angE),
                   pts[last].y + oy - endIns * Math.sin(angE));
        if (s.polylineClose) ctx.closePath();
        ctx.stroke();
        if (dir === 'end' || dir === 'both') {
          drawArrowHead(ctx, pts[last].x + ox, pts[last].y + oy, angE, lw);
        }
        if (dir === 'start' || dir === 'both') {
          const ang = Math.atan2(pts[0].y - pts[1].y, pts[0].x - pts[1].x);
          drawArrowHead(ctx, pts[0].x + ox, pts[0].y + oy, ang, lw);
        }
      } else {
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x + ox, pts[i].y + oy);
        if (s.polylineClose) ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();
    };

    if (!Selection.empty()) {
      _SB.begin(l.canvas);
      draw(_SB.bufCtx, 0, 0);
      _SB.flush(l, false);
    } else {
      draw(l.ctx, -l.x, -l.y);
    }
    Hist.snapshot('繪製折線');
    Engine.composite();
    this._cancel();
  }

  _cancel() {
    this._pts    = [];
    this._active = false;
    Engine.drawOverlay();
  }
}

/* ── Register all tools ── */
function registerTools() {
  ToolMgr.register('move',          new MoveTool());
  ToolMgr.register('brush',         new BrushTool());
  ToolMgr.register('pencil',        new PencilTool());
  ToolMgr.register('eraser',        new EraserTool());
  ToolMgr.register('fill',          new FillTool());
  ToolMgr.register('eyedropper',    new EyedropperTool());
  ToolMgr.register('select-rect',   new SelectRectTool());
  ToolMgr.register('select-ellipse',new SelectEllipseTool());
  ToolMgr.register('lasso',         new LassoTool());
  ToolMgr.register('polygon-select',new PolygonSelectTool());
  ToolMgr.register('magic-wand',    new MagicWandTool());
  ToolMgr.register('crop',          new CropTool());
  ToolMgr.register('text',          new TextTool());
  ToolMgr.register('gradient',      new GradientTool());
  ToolMgr.register('hand',          new HandTool());
  ToolMgr.register('zoom-tool',     new ZoomToolImpl());
  ToolMgr.register('clone-stamp',      new CloneStampTool());
  ToolMgr.register('transform-free',   new TransformTool('free'));
  ToolMgr.register('transform-scale',  new TransformTool('scale'));
  ToolMgr.register('transform-rotate', new TransformTool('rotate'));
  ToolMgr.register('shape-curve',       new CurveTool());
  ToolMgr.register('shape-curve-arrow', new CurveTool());     // 向下相容
  ToolMgr.register('shape-line',    new ShapeDrawTool('line'));
  ToolMgr.register('shape-rect',    new ShapeDrawTool('rect'));
  ToolMgr.register('shape-round',   new ShapeDrawTool('round'));
  ToolMgr.register('shape-ellipse', new ShapeDrawTool('ellipse'));
  ToolMgr.register('shape-arrow',   new ShapeDrawTool('arrow'));
  ToolMgr.register('shape-polygon', new ShapeDrawTool('polygon'));
  ToolMgr.register('shape-star',         new ShapeDrawTool('star'));
  ToolMgr.register('shape-arrow-shape',  new ShapeDrawTool('arrow-shape'));
  ToolMgr.register('shape-polyline', new PolylineTool());
  ToolMgr.register('ai-rmbg',          new AiRmbgTool());
  ToolMgr.register('ai-inpaint',        new AiInpaintTool());
  ToolMgr.register('ai-upsample',       new AiUpsampleTool());
  ToolMgr.register('ai-sam',            new AiSamTool());
  ToolMgr.register('ai-outpaint',       new AiOutpaintTool());
}
