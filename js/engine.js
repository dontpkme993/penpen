'use strict';
/* ═══════════════════════════════════════════════════════
   engine.js  —  CanvasEngine · SelectionManager · Rulers
   ═══════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════
   Canvas Engine  (compositing + zoom/pan)
   ═══════════════════════════════════════════ */
const Engine = {
  mainCanvas:    null,
  mainCtx:       null,
  overlayCanvas: null,
  overlayCtx:    null,
  compCanvas:    null,   // off-screen composite buffer
  compCtx:       null,
  gridVisible:   false,
  rulersVisible: false,
  marchOffset:   0,      // for marching-ants animation
  _marchTimer:   null,

  init(mainCanvas, overlayCanvas) {
    this.mainCanvas    = mainCanvas;
    this.mainCtx       = mainCanvas.getContext('2d');
    this.overlayCanvas = overlayCanvas;
    this.overlayCtx    = overlayCanvas.getContext('2d');
    this.compCanvas    = document.createElement('canvas');
    this.compCtx       = this.compCanvas.getContext('2d');
    this.mainCtx.imageSmoothingEnabled    = false;
    this.overlayCtx.imageSmoothingEnabled = false;
    this._startMarch();
  },

  resize(w, h) {
    this.mainCanvas.width    = w;
    this.mainCanvas.height   = h;
    this.overlayCanvas.width = w;
    this.overlayCanvas.height= h;
    this.compCanvas.width    = w;
    this.compCanvas.height   = h;
    this.mainCtx.imageSmoothingEnabled    = false;
    this.overlayCtx.imageSmoothingEnabled = false;
    // Container CSS size = pixel size × zoom  (canvas CSS fills container via width/height:100%)
    const container = document.getElementById('canvas-container');
    if (container) {
      container.style.width  = (w * App.zoom) + 'px';
      container.style.height = (h * App.zoom) + 'px';
    }
  },

  /** Composite all layers → main canvas */
  composite() {
    const w = App.docWidth, h = App.docHeight;
    this.compCtx.clearRect(0,0,w,h);

    // draw bottom→top
    for (let i = App.layers.length-1; i >= 0; i--) {
      const l = App.layers[i];
      if (!l.visible) continue;
      this.compCtx.save();
      this.compCtx.globalAlpha = l.opacity/100;
      this.compCtx.globalCompositeOperation = l.blendMode;
      this.compCtx.drawImage(l.canvas, l.x, l.y);
      this.compCtx.restore();
    }

    this.mainCtx.clearRect(0,0,w,h);
    this.mainCtx.drawImage(this.compCanvas,0,0);
    this.drawOverlay();
  },

  /** Draw selection marching ants + tool overlays */
  drawOverlay() {
    const oc  = this.overlayCtx;
    const w   = App.docWidth;
    const h   = App.docHeight;
    oc.clearRect(0,0,w,h);

    // Selection
    Selection.drawAnts(oc, this.marchOffset);

    // Current tool overlay (transform handles, etc.)
    if (ToolMgr.current && ToolMgr.current.drawOverlay) {
      ToolMgr.current.drawOverlay(oc);
    }

    // Grid
    if (this.gridVisible) this._drawGrid(oc, w, h);
  },

  _drawGrid(oc, w, h) {
    const sz = 32;
    oc.save();
    oc.strokeStyle = 'rgba(255,255,255,0.08)';
    oc.lineWidth   = 1;
    oc.beginPath();
    for (let x=0; x<=w; x+=sz){ oc.moveTo(x,0); oc.lineTo(x,h); }
    for (let y=0; y<=h; y+=sz){ oc.moveTo(0,y); oc.lineTo(w,y); }
    oc.stroke();
    oc.restore();
  },

  _startMarch() {
    this._marchTimer = setInterval(()=>{
      if (!Selection.empty()) {
        this.marchOffset = (this.marchOffset+1)%10;
        this.drawOverlay();
      }
    }, 80);
  },

  /** Convert screen (client) coords → canvas document coords */
  screenToCanvas(sx, sy) {
    const rect = this.overlayCanvas.getBoundingClientRect();
    const zoom = App.zoom;
    return {
      x: (sx - rect.left)  / zoom,
      y: (sy - rect.top)   / zoom
    };
  },

  toggleGrid() {
    this.gridVisible = !this.gridVisible;
    document.getElementById('m-grid')
      ?.classList.toggle('view-on', this.gridVisible);
    this.drawOverlay();
  },

  toggleRulers() {
    this.rulersVisible = !this.rulersVisible;
    const show = this.rulersVisible;
    document.getElementById('ruler-h').style.display = show ? 'block' : 'none';
    document.getElementById('ruler-v').style.display = show ? 'block' : 'none';
    document.getElementById('ruler-corner').style.display = show ? 'block' : 'none';
    const sz = show ? 'var(--ruler-sz)' : '0';
    const wrapper = document.getElementById('canvas-wrapper');
    wrapper.style.gridTemplateColumns = `${sz} 1fr`;
    wrapper.style.gridTemplateRows = `${sz} 1fr`;
    document.getElementById('m-rulers')
      ?.classList.toggle('view-on', show);
  }
};

/* ═══════════════════════════════════════════
   Zoom / Pan
   ═══════════════════════════════════════════ */
const ZoomPan = {
  LEVELS: [0.0625,0.083,0.125,0.167,0.25,0.333,0.5,0.667,0.75,1,1.25,1.5,2,3,4,5,6,8,12,16,32],

  setZoom(z, cx, cy) {
    const container = document.getElementById('canvas-container');
    const scrollArea= document.getElementById('canvas-scroll-area');
    const ov        = document.getElementById('overlay-canvas');
    const prevZ     = App.zoom;
    App.zoom = Math.max(this.LEVELS[0], Math.min(this.LEVELS[this.LEVELS.length-1], z));

    // Capture canvas screen position BEFORE resize (needed for cursor-stable scroll)
    const prevRect = (cx !== undefined && cy !== undefined) ? ov.getBoundingClientRect() : null;

    // Set the container's actual CSS size so scrollbars reflect the true zoomed size.
    // Canvas attributes stay at docWidth×docHeight (pixel resolution);
    // CSS width/height controls the display size via #main-canvas { width:100%; height:100% }
    container.style.width  = (App.docWidth  * App.zoom) + 'px';
    container.style.height = (App.docHeight * App.zoom) + 'px';

    // Adjust scroll so the canvas point under the cursor stays under the cursor.
    // getBoundingClientRect() after style change forces a layout reflow → accurate new position.
    if (prevRect) {
      const newRect = ov.getBoundingClientRect();
      // Where is the doc pixel that was under cursor now on screen?
      const docX = (cx - prevRect.left) / prevZ;
      const docY = (cy - prevRect.top)  / prevZ;
      // It is now at: newRect.left + docX * App.zoom  (x on screen)
      // We want it at: cx  →  scroll by the difference
      scrollArea.scrollLeft += (newRect.left + docX * App.zoom) - cx;
      scrollArea.scrollTop  += (newRect.top  + docY * App.zoom) - cy;
    }

    document.getElementById('st-zoom').textContent = `縮放: ${Math.round(App.zoom*100)}%`;
    Ruler.draw();
  },

  zoomIn(cx, cy)  { this.setZoom(this._nextLevel( 1), cx, cy); },
  zoomOut(cx, cy) { this.setZoom(this._nextLevel(-1), cx, cy); },
  zoomFit() {
    const sa = document.getElementById('canvas-scroll-area');
    // Subtract centering padding (2×24px) so the canvas sits inside the padding
    const zx = (sa.clientWidth  - 48) / App.docWidth;
    const zy = (sa.clientHeight - 48) / App.docHeight;
    this.setZoom(Math.min(zx, zy));
    // Canvas is now smaller than the scroll area → #canvas-center flexbox centers it
    // Reset scroll to (0,0) so flex centering takes effect
    sa.scrollLeft = 0;
    sa.scrollTop  = 0;
  },
  zoom100() { this.setZoom(1); },

  _nextLevel(dir) {
    const cur = App.zoom;
    const idx = this.LEVELS.findIndex(l=>l>=cur-0.001);
    const ni  = Math.max(0, Math.min(this.LEVELS.length-1, idx+dir));
    return this.LEVELS[ni];
  }
};

/* ═══════════════════════════════════════════
   Selection Manager
   ═══════════════════════════════════════════ */
const Selection = {
  mask:  null,   // Uint8Array, length = docWidth*docHeight
  bbox:  null,   // {x,y,w,h} or null
  _maskCanvas: null,
  _maskDirty:  true,

  init() {
    const sz = App.docWidth * App.docHeight;
    this.mask = new Uint8Array(sz);
    this.bbox = null;
  },

  empty() { return this.bbox === null; },

  selectAll() {
    this.mask.fill(255);
    this.bbox = {x:0, y:0, w:App.docWidth, h:App.docHeight};
    this._maskDirty = true;
    this._updateStatus();
    Engine.drawOverlay();
  },

  deselect() {
    if (this.mask) this.mask.fill(0);
    this.bbox = null;
    this._maskDirty = true;
    this._updateStatus();
    Engine.drawOverlay();
  },

  invert() {
    for (let i=0;i<this.mask.length;i++) this.mask[i]=255-this.mask[i];
    this._maskDirty = true;
    this._recalcBbox();
    this._updateStatus();
    Engine.drawOverlay();
  },

  /** Set a rectangle as selection (mode: 'new'|'add'|'subtract'|'intersect') */
  setRect(x1,y1,x2,y2, mode='new') {
    const W=App.docWidth, H=App.docHeight;
    const rx=Math.round(clamp(Math.min(x1,x2),0,W));
    const ry=Math.round(clamp(Math.min(y1,y2),0,H));
    const rw=Math.round(clamp(Math.max(x1,x2),0,W))-rx;
    const rh=Math.round(clamp(Math.max(y1,y2),0,H))-ry;
    const tmp = new Uint8Array(W*H);
    for (let y=ry;y<ry+rh;y++)
      for (let x=rx;x<rx+rw;x++)
        tmp[y*W+x]=255;
    this._apply(tmp, mode);
  },

  /** Set an ellipse as selection */
  setEllipse(x1,y1,x2,y2, mode='new') {
    const W=App.docWidth, H=App.docHeight;
    const cx=(x1+x2)/2, cy=(y1+y2)/2;
    const rx=Math.abs(x2-x1)/2, ry=Math.abs(y2-y1)/2;
    const tmp = new Uint8Array(W*H);
    const x0=Math.round(clamp(cx-rx,0,W)), xe=Math.round(clamp(cx+rx,0,W));
    const y0=Math.round(clamp(cy-ry,0,H)), ye=Math.round(clamp(cy+ry,0,H));
    for (let y=y0;y<=ye;y++)
      for (let x=x0;x<=xe;x++) {
        const dx=(x-cx)/rx, dy=(y-cy)/ry;
        if (dx*dx+dy*dy<=1) tmp[y*W+x]=255;
      }
    this._apply(tmp, mode);
  },

  /** Set lasso polygon as selection */
  setLasso(points, mode='new') {
    const W=App.docWidth, H=App.docHeight;
    const tmp = new Uint8Array(W*H);
    if (points.length < 3) return;
    const minY=Math.max(0,Math.floor(Math.min(...points.map(p=>p.y))));
    const maxY=Math.min(H-1,Math.ceil(Math.max(...points.map(p=>p.y))));
    for (let y=minY;y<=maxY;y++) {
      const xs=[];
      for (let i=0;i<points.length;i++) {
        const p1=points[i], p2=points[(i+1)%points.length];
        if ((p1.y<=y&&p2.y>y)||(p2.y<=y&&p1.y>y)) {
          const t=(y-p1.y)/(p2.y-p1.y);
          xs.push(p1.x+(p2.x-p1.x)*t);
        }
      }
      xs.sort((a,b)=>a-b);
      for (let i=0;i<xs.length-1;i+=2) {
        const x0=Math.round(clamp(xs[i],0,W));
        const x1=Math.round(clamp(xs[i+1],0,W));
        for (let x=x0;x<x1;x++) tmp[y*W+x]=255;
      }
    }
    this._apply(tmp, mode);
  },

  /** Magic wand selection.
   *  px, py are document-space coordinates.
   *  tmp mask is always doc-sized; pixel sampling is done in layer-local space. */
  magicWand(px, py, tolerance=32, mode='new', contiguous=true) {
    const layer = LayerMgr.active();
    if (!layer) return;
    const DW=App.docWidth, DH=App.docHeight;
    const LW=layer.canvas.width, LH=layer.canvas.height;
    const lx=layer.x, ly=layer.y;
    const imgData = layer.getImageData();  // layer-local pixels (LW×LH)
    const d = imgData.data;
    const tmp = new Uint8Array(DW*DH);     // selection mask in doc space
    // Convert click from doc → layer-local
    const cx = Math.round(clamp(px-lx, 0, LW-1));
    const cy = Math.round(clamp(py-ly, 0, LH-1));
    const si = (cy*LW+cx)*4;
    const tr=d[si], tg=d[si+1], tb=d[si+2], ta=d[si+3];
    const thresh = tolerance * 4;
    // Check tolerance of a doc-space pixel (convert to layer-local to sample)
    const inTol = (dx, dy) => {
      const llx=dx-lx, lly=dy-ly;
      if (llx<0||llx>=LW||lly<0||lly>=LH) return false; // outside layer = no match
      const i=(lly*LW+llx)*4;
      return Math.abs(d[i]-tr)+Math.abs(d[i+1]-tg)+Math.abs(d[i+2]-tb)+Math.abs(d[i+3]-ta) <= thresh;
    };
    if (contiguous) {
      // flood-fill in doc space starting from clicked doc coord
      const startDX = Math.round(clamp(px, 0, DW-1));
      const startDY = Math.round(clamp(py, 0, DH-1));
      const visited = new Uint8Array(DW*DH);
      const stack = [[startDX, startDY]];
      while (stack.length) {
        const [x,y] = stack.pop();
        if (x<0||x>=DW||y<0||y>=DH) continue;
        if (visited[y*DW+x]) continue;
        visited[y*DW+x] = 1;
        if (!inTol(x, y)) continue;
        tmp[y*DW+x] = 255;
        stack.push([x+1,y],[x-1,y],[x,y+1],[x,y-1]);
      }
    } else {
      // select all doc pixels whose layer color is within tolerance
      for (let y=0; y<DH; y++)
        for (let x=0; x<DW; x++)
          if (inTol(x, y)) tmp[y*DW+x] = 255;
    }
    this._apply(tmp, mode);
  },

  _apply(tmp, mode) {
    const n=this.mask.length;
    if (mode==='new')       { for(let i=0;i<n;i++) this.mask[i]=tmp[i]; }
    else if(mode==='add')   { for(let i=0;i<n;i++) this.mask[i]=Math.max(this.mask[i],tmp[i]); }
    else if(mode==='sub')   { for(let i=0;i<n;i++) this.mask[i]=this.mask[i]&~tmp[i]; }
    else if(mode==='inter') { for(let i=0;i<n;i++) this.mask[i]=this.mask[i]&tmp[i]; }
    this._maskDirty = true;
    this._recalcBbox();
    this._updateStatus();
    Engine.drawOverlay();
  },

  /** Return a cached canvas where the selection mask is the alpha channel. */
  getMaskCanvas() {
    if (!this._maskDirty && this._maskCanvas) return this._maskCanvas;
    const W = App.docWidth, H = App.docHeight;
    if (!this._maskCanvas) this._maskCanvas = document.createElement('canvas');
    this._maskCanvas.width = W; this._maskCanvas.height = H;
    const mc = this._maskCanvas.getContext('2d');
    const id = mc.createImageData(W, H);
    const m = this.mask;
    for (let i = 0; i < m.length; i++) {
      const b = i << 2;
      id.data[b] = id.data[b+1] = id.data[b+2] = 255;
      id.data[b+3] = m[i];
    }
    mc.putImageData(id, 0, 0);
    this._maskDirty = false;
    return this._maskCanvas;
  },

  _recalcBbox() {
    const W=App.docWidth, H=App.docHeight;
    let x0=W,y0=H,x1=0,y1=0,found=false;
    for(let y=0;y<H;y++)
      for(let x=0;x<W;x++)
        if(this.mask[y*W+x]){
          found=true;
          if(x<x0)x0=x; if(x>x1)x1=x;
          if(y<y0)y0=y; if(y>y1)y1=y;
        }
    this.bbox = found?{x:x0,y:y0,w:x1-x0+1,h:y1-y0+1}:null;
  },

  _updateStatus() {
    const el=document.getElementById('st-sel');
    if(this.bbox)
      el.textContent=`選取: ${this.bbox.w}×${this.bbox.h}`;
    else
      el.textContent='無選取';
  },

  /** Draw marching ants on overlay canvas */
  drawAnts(oc, offset) {
    if (!this.bbox) return;
    const W=App.docWidth, H=App.docHeight;
    oc.save();
    oc.strokeStyle='black';
    oc.lineWidth=1;
    oc.setLineDash([5,5]);
    oc.lineDashOffset=offset;
    this._traceEdges(oc, W, H);
    oc.strokeStyle='white';
    oc.lineDashOffset=offset+5;
    this._traceEdges(oc, W, H);
    oc.restore();
  },

  _traceEdges(oc, W, H) {
    oc.beginPath();
    const mask=this.mask;
    const get=(x,y)=>x>=0&&x<W&&y>=0&&y<H?mask[y*W+x]:0;
    for(let y=0;y<=H;y++)
      for(let x=0;x<=W;x++){
        const c=get(x,y), l=get(x-1,y), u=get(x,y-1);
        if(c!==l){ oc.moveTo(x,y); oc.lineTo(x,y+1); }
        if(c!==u){ oc.moveTo(x,y); oc.lineTo(x+1,y); }
      }
    oc.stroke();
  },

  /** Apply selection mask to a ctx (clip) before drawing */
  applyMaskClip(ctx) {
    if (!this.bbox) return false;
    const W=App.docWidth, H=App.docHeight;
    const tmp = document.createElement('canvas');
    tmp.width=W; tmp.height=H;
    const tc=tmp.getContext('2d');
    const id=tc.createImageData(W,H);
    for(let i=0;i<this.mask.length;i++){
      id.data[i*4+3]=this.mask[i];
    }
    tc.putImageData(id,0,0);
    ctx.save();
    ctx.globalCompositeOperation='destination-in';
    // We'll use compositing after draw instead of clip
    return true;
  },

  /** Get selection bounds for copy/paste */
  getBounds() { return this.bbox; },

  /** Check if point is inside selection */
  contains(x,y) {
    if (!this.bbox) return true; // no selection = whole canvas
    x=Math.round(x); y=Math.round(y);
    if(x<0||x>=App.docWidth||y<0||y>=App.docHeight) return false;
    return this.mask[y*App.docWidth+x]>0;
  }
};

/* ═══════════════════════════════════════════
   Rulers
   ═══════════════════════════════════════════ */
const Ruler = {
  draw() {
    const rulerH=document.getElementById('ruler-h');
    const rulerV=document.getElementById('ruler-v');
    const sa=document.getElementById('canvas-scroll-area');
    if (!rulerH || !rulerV) return;

    const z=App.zoom;
    const scrollX=sa.scrollLeft;
    const scrollY=sa.scrollTop;

    // Container margin (from flexbox centering)
    const container=document.getElementById('canvas-container');
    const cRect=container.getBoundingClientRect();
    const saRect=sa.getBoundingClientRect();
    const originX=cRect.left-saRect.left+sa.scrollLeft;
    const originY=cRect.top -saRect.top +sa.scrollTop;

    this._drawH(rulerH, z, scrollX, originX, sa.clientWidth);
    this._drawV(rulerV, z, scrollY, originY, sa.clientHeight);
  },

  _drawH(canvas, z, scrollX, originX, viewW) {
    canvas.width = viewW;
    const ctx=canvas.getContext('2d');
    ctx.clearRect(0,0,viewW,canvas.height);
    ctx.fillStyle='#2d2d2d';
    ctx.fillRect(0,0,viewW,canvas.height);
    ctx.fillStyle='#888';
    ctx.font='8px sans-serif';
    ctx.textAlign='center';

    const step=this._step(z);
    const start=Math.floor((scrollX-originX)/z/step)*step;
    const end  =Math.ceil ((scrollX-originX+viewW)/z/step)*step;

    ctx.strokeStyle='#555';
    ctx.lineWidth=1;
    ctx.beginPath();
    for(let v=start;v<=end;v+=step){
      const sx=originX-scrollX+v*z;
      if(sx<0||sx>viewW) continue;
      const major=(v%(step*5)===0);
      ctx.moveTo(sx, major?4:8);
      ctx.lineTo(sx, canvas.height);
      if(major) ctx.fillText(v, sx, 8);
    }
    ctx.stroke();
  },

  _drawV(canvas, z, scrollY, originY, viewH) {
    canvas.height = viewH;
    const ctx=canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width,viewH);
    ctx.fillStyle='#2d2d2d';
    ctx.fillRect(0,0,canvas.width,viewH);
    ctx.fillStyle='#888';
    ctx.font='8px sans-serif';
    ctx.textBaseline='middle';

    const step=this._step(z);
    const start=Math.floor((scrollY-originY)/z/step)*step;
    const end  =Math.ceil ((scrollY-originY+viewH)/z/step)*step;

    ctx.strokeStyle='#555';
    ctx.lineWidth=1;
    ctx.beginPath();
    for(let v=start;v<=end;v+=step){
      const sy=originY-scrollY+v*z;
      if(sy<0||sy>viewH) continue;
      const major=(v%(step*5)===0);
      ctx.moveTo(major?4:8, sy);
      ctx.lineTo(canvas.width, sy);
      if(major){
        ctx.save();
        ctx.translate(8,sy);
        ctx.rotate(-Math.PI/2);
        ctx.fillText(v,0,0);
        ctx.restore();
      }
    }
    ctx.stroke();
  },

  _step(z) {
    if(z>=8)  return 10;
    if(z>=4)  return 20;
    if(z>=2)  return 50;
    if(z>=1)  return 100;
    if(z>=0.5) return 200;
    return 500;
  }
};
