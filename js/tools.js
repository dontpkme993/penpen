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
  get color()    { return App.fgColor; }

  onPointerDown(e,x,y){
    const l=LayerMgr.active(); if(!l||l.locked||l.type==='text') return;
    this._drawing=true; this._lx=x; this._ly=y;
    const pressure=e.pressure||1;
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
    const pressure=e.pressure||1;
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
    if(this._drawing){ this._drawing=false; Hist.snapshot('筆刷'); }
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
    const p=e.pressure||1;
    if (!Selection.empty()) {
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
    const p=e.pressure||1;
    if (!Selection.empty()) {
      paintLineAccum(_SB.bufCtx, this._lx,this._ly,x,y, this.size*p, this.opacity, this.hardness, this.spacing);
      _SB.flush(l, true);
    } else {
      paintLine(l.ctx,this._lx-l.x,this._ly-l.y,x-l.x,y-l.y,this.size*p,this.color,this.opacity,this.hardness,this.spacing,true);
    }
    this._lx=x; this._ly=y;
    Engine.composite();
  }
  onPointerUp(){ if(this._drawing){ this._drawing=false; Hist.snapshot('橡皮擦'); } }
}

/* ═══════════════════════════════════════════
   5. Fill Tool  (flood fill)
   ═══════════════════════════════════════════ */
class FillTool {
  constructor(){ this.label='油漆桶'; this.cursor='crosshair'; }
  onPointerDown(e,x,y){
    const l=LayerMgr.active(); if(!l||l.locked||l.type==='text') return;
    Hist.snapshot('填滿');
    const tol=App.fill.tolerance||32;
    this._floodFill(l, Math.round(x), Math.round(y), App.fgColor, tol);
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
    if(this._points.length>2) Selection.setLasso(this._points, this.mode);
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
    if (this._points.length >= 3) Selection.setLasso(this._points, this.mode);
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
    Hist.snapshot('裁切');
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

  _size()   { return parseInt(document.getElementById('td-size')?.value||32)||32; }
  _font()   { return document.getElementById('td-font')?.value||'Arial'; }
  _bold()   { return document.getElementById('td-bold')?.classList.contains('active')||false; }
  _italic() { return document.getElementById('td-italic')?.classList.contains('active')||false; }
  _uline()  { return document.getElementById('td-underline')?.classList.contains('active')||false; }
  _align()  { return document.getElementById('td-align')?.value||'left'; }
  _text()   { return document.getElementById('td-textarea')?.value||''; }
  _fontStr(sz){ return `${this._italic()?'italic ':''}${this._bold()?'bold ':''}${sz}px "${this._font()}"`; }

  _openDialog(d) {
    if(d.font)  document.getElementById('td-font').value  = d.font;
    if(d.size)  document.getElementById('td-size').value  = d.size;
    if(d.align) document.getElementById('td-align').value = d.align;
    document.getElementById('td-bold').classList.toggle('active',      !!d.bold);
    document.getElementById('td-italic').classList.toggle('active',    !!d.italic);
    document.getElementById('td-underline').classList.toggle('active', !!d.underline);
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
             align:this._align(), color:App.fgColor };
  }

  _commit(){
    const td=this._buildTextData();
    if(td.text.trim()){
      if(this._editingLayer){
        Hist.snapshot('編輯文字');
        this._editingLayer.textData=td;
        this._editingLayer.visible=true;
        this._editingLayer.renderText();
        Engine.composite();
        UI.refreshLayerPanel();
      } else {
        LayerMgr.addTextLayer(td, Math.round(this._x), Math.round(this._y));
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
    const PAD=2; const lineH=size*1.2;
    oc.save();
    oc.font=this._fontStr(size);
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
  onPointerUp(){ if(this._drawing){ this._drawing=false; Hist.snapshot('仿製印章'); } }
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

  activate()   { this._begin(); }
  deactivate() {
    if (this._st) this._commit();
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
    const {l,origImgData}=this._st;
    l.ctx.putImageData(origImgData,0,0);
    this._st=null;
    document.getElementById('overlay-canvas').style.cursor='';
    Engine.composite(); Engine.drawOverlay();
  }

  _commit() {
    if (!this._st) return;
    const s=this._st, l=s.l;
    l.ctx.clearRect(0,0,l.canvas.width,l.canvas.height);
    l.ctx.drawImage(s.cutC,0,0);
    this._drawFloat(l.ctx, l.x, l.y, s);
    // Transform rasterizes text layers
    if(l.type==='text'){ l.type='image'; l.textData=null; }
    Hist.snapshot(this.label);
    Selection.deselect();
    this._st=null;
    document.getElementById('overlay-canvas').style.cursor='';
    Engine.composite(); Engine.drawOverlay();
  }

  _drawFloat(ctx, lx, ly, s) {
    if (s.w===0||s.h===0) return;
    ctx.save();
    ctx.translate(s.cx-lx, s.cy-ly);
    ctx.rotate(s.angle);
    ctx.scale(s.w/s.origW, s.h/s.origH);
    ctx.drawImage(s.floatC, -s.origW/2, -s.origH/2);
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
  ToolMgr.register('ai-rmbg',          new AiRmbgTool());
  ToolMgr.register('ai-inpaint',        new AiInpaintTool());
}
