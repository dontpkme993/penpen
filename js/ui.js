'use strict';
/* ═══════════════════════════════════════════════════════
   ui.js  —  UI Manager · Color Picker · Dialogs · Panels
   ═══════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════
   Color Picker
   ═══════════════════════════════════════════ */
const ColorPicker = {
  h: 0, s: 100, v: 100, a: 100,
  _draggingSV: false,
  _draggingHue: false,
  _draggingAlpha: false,
  _target: 'fg',   // 'fg' or 'bg'

  init() {
    const sv  = document.getElementById('cp-sv');
    const hue = document.getElementById('cp-hue');
    const alp = document.getElementById('cp-alpha');

    sv.addEventListener('mousedown',  e=>{ this._draggingSV=true; this._pickSV(e); });
    hue.addEventListener('mousedown', e=>{ this._draggingHue=true; this._pickHue(e); });
    alp.addEventListener('mousedown', e=>{ this._draggingAlpha=true; this._pickAlpha(e); });

    window.addEventListener('mousemove', e=>{
      if (this._draggingSV)   this._pickSV(e);
      if (this._draggingHue)  this._pickHue(e);
      if (this._draggingAlpha) this._pickAlpha(e);
    });
    window.addEventListener('mouseup', ()=>{
      this._draggingSV=false; this._draggingHue=false; this._draggingAlpha=false;
    });

    // input fields
    ['cp-h','cp-s','cp-b','cp-r','cp-g','cp-b2','cp-hex','cp-a'].forEach(id=>{
      document.getElementById(id).addEventListener('change', ()=>this._onInputChange());
    });

    this._drawHueBar();
    this.setHSV(0,0,0,100);
  },

  setHSV(h,s,v,a=100) {
    this.h=h; this.s=s; this.v=v; this.a=a;
    this._updateAll();
  },

  setHex(hex, a=100) {
    const {r,g,b}=hexToRgb(hex);
    const {h,s,v}=rgbToHsv(r,g,b);
    this.setHSV(h,s,v,a);
  },

  getHex()  { return rgbToHex(...Object.values(hsvToRgb(this.h,this.s,this.v))); },
  getRgba() {
    const {r,g,b}=hsvToRgb(this.h,this.s,this.v);
    return {r,g,b,a:this.a};
  },

  _pickSV(e) {
    const sv=document.getElementById('cp-sv');
    const rect=sv.getBoundingClientRect();
    const x=clamp(e.clientX-rect.left,0,rect.width);
    const y=clamp(e.clientY-rect.top,0,rect.height);
    this.s=Math.round(x/rect.width*100);
    this.v=Math.round(100-y/rect.height*100);
    this._updateAll();
    this._emitColor();
  },

  _pickHue(e) {
    const hue=document.getElementById('cp-hue');
    const rect=hue.getBoundingClientRect();
    const x=clamp(e.clientX-rect.left,0,rect.width);
    this.h=Math.round(x/rect.width*360);
    this._drawSVGrad();
    this._updateAll();
    this._emitColor();
  },

  _pickAlpha(e) {
    const alp=document.getElementById('cp-alpha');
    const rect=alp.getBoundingClientRect();
    const x=clamp(e.clientX-rect.left,0,rect.width);
    this.a=Math.round(x/rect.width*100);
    this._updateAll();
    this._emitColor();
  },

  _updateAll() {
    this._drawSVGrad();
    this._updateCursors();
    this._updateInputs();
    this._updatePreviews();
    this._drawAlphaBar();
  },

  _drawSVGrad() {
    const sv=document.getElementById('cp-sv');
    const ctx=sv.getContext('2d');
    const w=sv.width, h=sv.height;
    ctx.clearRect(0,0,w,h);
    // base hue
    const {r,g,b}=hsvToRgb(this.h,100,100);
    ctx.fillStyle=`rgb(${r},${g},${b})`;
    ctx.fillRect(0,0,w,h);
    // white gradient left
    const gW=ctx.createLinearGradient(0,0,w,0);
    gW.addColorStop(0,'rgba(255,255,255,1)');
    gW.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=gW; ctx.fillRect(0,0,w,h);
    // black gradient bottom
    const gB=ctx.createLinearGradient(0,0,0,h);
    gB.addColorStop(0,'rgba(0,0,0,0)');
    gB.addColorStop(1,'rgba(0,0,0,1)');
    ctx.fillStyle=gB; ctx.fillRect(0,0,w,h);
  },

  _drawHueBar() {
    const hue=document.getElementById('cp-hue');
    const ctx=hue.getContext('2d');
    const w=hue.width, h=hue.height;
    const g=ctx.createLinearGradient(0,0,w,0);
    for(let i=0;i<=6;i++) {
      const {r,g2,b}=hsvToRgb(i*60,100,100);
      const {r:rr,g:gg,b:bb}=hsvToRgb(i*60,100,100);
      g.addColorStop(i/6,`rgb(${rr},${gg},${bb})`);
    }
    ctx.fillStyle=g; ctx.fillRect(0,0,w,h);
  },

  _drawAlphaBar() {
    const alp=document.getElementById('cp-alpha');
    const ctx=alp.getContext('2d');
    const w=alp.width, h=alp.height;
    // checkerboard
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle='#666'; ctx.fillRect(0,0,w,h);
    ctx.fillStyle='#999';
    for(let x=0;x<w;x+=8) {
      const off=(Math.floor(x/8)%2)*8;
      ctx.fillRect(x,off,8,8); ctx.fillRect(x,off+16,8,8);
    }
    const {r,g,b}=hsvToRgb(this.h,this.s,this.v);
    const g2=ctx.createLinearGradient(0,0,w,0);
    g2.addColorStop(0,`rgba(${r},${g},${b},0)`);
    g2.addColorStop(1,`rgba(${r},${g},${b},1)`);
    ctx.fillStyle=g2; ctx.fillRect(0,0,w,h);
  },

  _updateCursors() {
    const sv=document.getElementById('cp-sv');
    const cur=document.getElementById('cp-sv-cursor');
    const svRect=sv.getBoundingClientRect();
    // Position relative to the colorpicker container
    const cpRect=document.getElementById('colorpicker').getBoundingClientRect();
    const svTop=svRect.top-cpRect.top;
    cur.style.left=(this.s/100*sv.offsetWidth+sv.offsetLeft)+'px';
    cur.style.top =((100-this.v)/100*sv.offsetHeight+sv.offsetTop)+'px';

    const hueC=document.getElementById('cp-hue-cursor');
    hueC.style.left=(this.h/360*100)+'%';
    const alpC=document.getElementById('cp-alpha-cursor');
    alpC.style.left=(this.a/100*100)+'%';
  },

  _updateInputs() {
    const {r,g,b}=hsvToRgb(this.h,this.s,this.v);
    document.getElementById('cp-h').value=this.h;
    document.getElementById('cp-s').value=this.s;
    document.getElementById('cp-b').value=this.v;
    document.getElementById('cp-r').value=r;
    document.getElementById('cp-g').value=g;
    document.getElementById('cp-b2').value=b;
    document.getElementById('cp-hex').value=rgbToHex(r,g,b).replace('#','');
    document.getElementById('cp-a').value=this.a;
  },

  _updatePreviews() {
    const hex=this.getHex();
    document.getElementById('cp-prev-new').style.background=hex;
    // old shows current app color
    const current=this._target==='fg'?App.fgColor:App.bgColor;
    document.getElementById('cp-prev-old').style.background=current;
  },

  _onInputChange() {
    const h=Math.min(360,Math.max(0,parseInt(document.getElementById('cp-h').value)||0));
    const s=Math.min(100,Math.max(0,parseInt(document.getElementById('cp-s').value)||0));
    const v=Math.min(100,Math.max(0,parseInt(document.getElementById('cp-b').value)||0));
    const hex=document.getElementById('cp-hex').value;
    if(hex.length===6) {
      this.setHex('#'+hex);
    } else {
      this.setHSV(h,s,v,Math.min(100,Math.max(0,parseInt(document.getElementById('cp-a').value)||100)));
    }
    this._emitColor();
  },

  _emitColor() {
    const hex=this.getHex();
    if(this._target==='fg') App.setFgColor(hex);
    else App.setBgColor(hex);
  }
};

/* ═══════════════════════════════════════════
   UI Manager
   ═══════════════════════════════════════════ */
const UI = {

  init() {
    this._initMenuBar();
    this._initToolbar();
    this._initToolGroups();
    this._initLayerPanel();
    this._initMenus();
    this._initDialogs();
    this._initColorSwatches();
    this.updateLayerControls();
  },

  /* ── 選單列開關管理 ── */
  _initMenuBar() {
    const items = document.querySelectorAll('#menu-bar .menu-item');
    let active = null;

    const closeAll = () => {
      if (active) { active.classList.remove('menu-open'); active = null; }
    };

    const openItem = item => {
      closeAll();
      item.classList.add('menu-open');
      active = item;
    };

    items.forEach(item => {
      // 點擊選單大項標題 → 切換開關
      item.addEventListener('click', e => {
        // 若點的是 dropdown 內部項目，交給 _initMenus 處理，此處只管標題
        if (e.target.closest('.dropdown')) return;
        // 用 stopPropagation 避免立刻被 document click 關掉
        e.stopPropagation();
        if (active === item) closeAll();
        else openItem(item);
      });

      // 滑鼠移入：若已有選單展開，直接切換
      item.addEventListener('mouseenter', () => {
        if (active && active !== item) openItem(item);
      });
    });

    // 點擊選單項目後關閉（drop-item 本身的 click 由 _initMenus 處理功能，這裡只負責收起）
    document.querySelectorAll('#menu-bar .drop-item:not(.has-sub)').forEach(di => {
      di.addEventListener('click', closeAll);
    });

    // 點擊選單區域外部 → 關閉
    document.addEventListener('click', e => {
      if (!e.target.closest('#menu-bar .menu-item')) closeAll();
    });

    // Escape 鍵 → 關閉
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeAll();
    });
  },

  /* ── Toolbar ── */
  _initToolbar() {
    document.querySelectorAll('.tb-btn[data-tool]').forEach(btn=>{
      btn.addEventListener('click', ()=>ToolMgr.activate(btn.dataset.tool));
    });
    document.getElementById('fg-swatch').addEventListener('click', ()=>{
      ColorPicker._target='fg';
      ColorPicker.setHex(App.fgColor);
    });
    document.getElementById('bg-swatch').addEventListener('click', ()=>{
      ColorPicker._target='bg';
      ColorPicker.setHex(App.bgColor);
    });
    document.getElementById('swap-colors').addEventListener('click', ()=>{
      const tmp=App.fgColor;
      App.setFgColor(App.bgColor);
      App.setBgColor(tmp);
    });
    document.getElementById('reset-colors').addEventListener('click', ()=>{
      App.setFgColor('#000000');
      App.setBgColor('#ffffff');
    });
  },

  /* ── Tool Groups (collapsible tool variants with flyout) ── */
  _initToolGroups() {
    const closeAll = () => {
      document.querySelectorAll('.tb-group-popup').forEach(p => p.classList.add('hidden'));
    };

    document.querySelectorAll('.tb-group').forEach(group => {
      const mainBtn = group.querySelector('.tb-group-main');
      const arrBtn  = group.querySelector('.tb-group-arr');
      const popup   = group.querySelector('.tb-group-popup');

      // arrow click → toggle flyout popup
      arrBtn.addEventListener('click', e => {
        e.stopPropagation();
        const wasHidden = popup.classList.contains('hidden');
        closeAll();
        if (wasHidden) {
          const rect = group.getBoundingClientRect();
          popup.style.left = (rect.right + 4) + 'px';
          popup.style.top  = rect.top + 'px';
          popup.classList.remove('hidden');
        }
      });

      // option click → update main button + activate tool + close
      group.querySelectorAll('.tb-group-opt').forEach(opt => {
        opt.addEventListener('click', e => {
          e.stopPropagation();
          const tool = opt.dataset.tool;
          // update main button to show selected tool's icon
          mainBtn.dataset.tool = tool;
          mainBtn.innerHTML = opt.querySelector('svg').outerHTML;
          mainBtn.title = opt.title;
          // mark active option in popup
          group.querySelectorAll('.tb-group-opt').forEach(o => o.classList.remove('active'));
          opt.classList.add('active');
          closeAll();
          ToolMgr.activate(tool);
        });
      });
    });

    // close popups when clicking outside any tool group
    document.addEventListener('click', e => {
      if (!e.target.closest('.tb-group')) closeAll();
    });
  },

  /* ── Tool Options Bar ── */
  updateToolOptions(toolName) {
    const bar=document.getElementById('tool-options-content');
    bar.innerHTML='';

    const mkLabel=(txt)=>{ const l=document.createElement('label'); l.textContent=txt; return l; };
    const mkRange=(id,min,max,val,step=1)=>{
      const inp=document.createElement('input');
      inp.type='range'; inp.id=id; inp.min=min; inp.max=max; inp.value=val; inp.step=step;
      return inp;
    };
    const mkNum=(id,min,max,val,w=52)=>{
      const inp=document.createElement('input');
      inp.type='number'; inp.id=id; inp.min=min; inp.max=max; inp.value=val;
      inp.style.width=w+'px';
      return inp;
    };
    const mkSep=()=>{ const s=document.createElement('div'); s.className='opt-sep'; return s; };
    const mkSelect=(id,options,val)=>{
      const s=document.createElement('select'); s.id=id;
      options.forEach(([v,t])=>{ const o=document.createElement('option'); o.value=v; o.textContent=t; s.appendChild(o); });
      s.value=val||options[0][0];
      return s;
    };
    const link=(rangeId,numId,getter,setter)=>{
      const r=document.getElementById(rangeId), n=document.getElementById(numId);
      if(!r||!n) return;
      r.addEventListener('input',()=>{ n.value=r.value; setter(+r.value); Engine.drawOverlay(); });
      n.addEventListener('change',()=>{ r.value=n.value; setter(+n.value); Engine.drawOverlay(); });
    };

    if(['brush','pencil','eraser'].includes(toolName)){
      bar.appendChild(mkLabel('大小:'));
      bar.appendChild(mkRange('opt-size',1,500,App.brush.size));
      bar.appendChild(mkNum('opt-size-num',1,500,App.brush.size,52));
      bar.appendChild(mkSep());
      bar.appendChild(mkLabel('不透明:'));
      bar.appendChild(mkRange('opt-opacity',1,100,App.brush.opacity));
      bar.appendChild(mkNum('opt-opacity-num',1,100,App.brush.opacity,44));
      bar.appendChild(document.createTextNode('%'));
      bar.appendChild(mkSep());
      if(toolName!=='pencil'){
        bar.appendChild(mkLabel('硬度:'));
        bar.appendChild(mkRange('opt-hardness',0,100,App.brush.hardness));
        bar.appendChild(mkNum('opt-hardness-num',0,100,App.brush.hardness,44));
        bar.appendChild(document.createTextNode('%'));
      }
      link('opt-size','opt-size-num',()=>App.brush.size,v=>App.brush.size=v);
      link('opt-opacity','opt-opacity-num',()=>App.brush.opacity,v=>App.brush.opacity=v);
      if(toolName!=='pencil')
        link('opt-hardness','opt-hardness-num',()=>App.brush.hardness,v=>App.brush.hardness=v);
    }

    if(['select-rect','select-ellipse','lasso'].includes(toolName)){
      bar.appendChild(mkLabel('模式:'));
      const modeSelect=mkSelect('opt-sel-mode',[['new','新選取'],['add','增加'],['sub','減少'],['inter','交集']],App.selection.mode);
      modeSelect.addEventListener('change',()=>App.selection.mode=modeSelect.value);
      bar.appendChild(modeSelect);
      bar.appendChild(mkSep());
      bar.appendChild(mkLabel('消除鋸齒:'));
      const aa=document.createElement('input'); aa.type='checkbox'; aa.checked=true;
      bar.appendChild(aa);
    }

    if(toolName==='magic-wand'){
      bar.appendChild(mkLabel('模式:'));
      const modeSelect=mkSelect('opt-mw-mode',[['new','新選取'],['add','增加'],['sub','減少'],['inter','交集']],App.selection.mode);
      modeSelect.addEventListener('change',()=>App.selection.mode=modeSelect.value);
      bar.appendChild(modeSelect);
      bar.appendChild(mkSep());
      bar.appendChild(mkLabel('容差:'));
      bar.appendChild(mkRange('opt-mw-tol',0,255,App.selection.tolerance));
      bar.appendChild(mkNum('opt-mw-tol-num',0,255,App.selection.tolerance,44));
      link('opt-mw-tol','opt-mw-tol-num',()=>App.selection.tolerance,v=>App.selection.tolerance=v);
      bar.appendChild(mkSep());
      bar.appendChild(mkLabel('連續:'));
      const cont=document.createElement('input'); cont.type='checkbox'; cont.id='opt-mw-cont';
      cont.checked=App.selection.contiguous;
      cont.addEventListener('change',()=>App.selection.contiguous=cont.checked);
      bar.appendChild(cont);
      bar.appendChild(mkSep());
      const hint=document.createElement('span'); hint.textContent='Shift=增加  Alt=減少'; hint.style.color='var(--c-text-dim)'; hint.style.fontSize='11px';
      bar.appendChild(hint);
    }

    if(toolName==='clone-stamp'){
      bar.appendChild(mkLabel('大小:'));
      bar.appendChild(mkRange('opt-stamp-size',1,500,App.stamp.size));
      bar.appendChild(mkNum('opt-stamp-size-num',1,500,App.stamp.size,52));
      bar.appendChild(mkSep());
      bar.appendChild(mkLabel('不透明:'));
      bar.appendChild(mkRange('opt-stamp-opacity',1,100,App.stamp.opacity));
      bar.appendChild(mkNum('opt-stamp-opacity-num',1,100,App.stamp.opacity,44));
      bar.appendChild(document.createTextNode('%'));
      bar.appendChild(mkSep());
      bar.appendChild(mkLabel('硬度:'));
      bar.appendChild(mkRange('opt-stamp-hardness',0,100,App.stamp.hardness));
      bar.appendChild(mkNum('opt-stamp-hardness-num',0,100,App.stamp.hardness,44));
      bar.appendChild(document.createTextNode('%'));
      bar.appendChild(mkSep());
      bar.appendChild(mkLabel('形狀:'));
      const shapeSelect=mkSelect('opt-stamp-shape',[['circle','圓形'],['square','方形']],App.stamp.brushShape);
      shapeSelect.addEventListener('change',()=>App.stamp.brushShape=shapeSelect.value);
      bar.appendChild(shapeSelect);
      link('opt-stamp-size','opt-stamp-size-num',()=>App.stamp.size,v=>App.stamp.size=v);
      link('opt-stamp-opacity','opt-stamp-opacity-num',()=>App.stamp.opacity,v=>App.stamp.opacity=v);
      link('opt-stamp-hardness','opt-stamp-hardness-num',()=>App.stamp.hardness,v=>App.stamp.hardness=v);
      bar.appendChild(mkSep());
      const hint=document.createElement('span'); hint.textContent='Alt+點擊 設定來源點'; hint.style.color='var(--c-text-dim)'; hint.style.fontSize='11px';
      bar.appendChild(hint);
    }

    if(toolName==='fill'){
      bar.appendChild(mkLabel('容差:'));
      bar.appendChild(mkRange('opt-tolerance',0,255,App.fill.tolerance));
      bar.appendChild(mkNum('opt-tolerance-num',0,255,App.fill.tolerance,44));
      link('opt-tolerance','opt-tolerance-num',()=>App.fill.tolerance,v=>App.fill.tolerance=v);
    }

    if(toolName==='crop'){
      // Auto crop button
      const autoBtn=document.createElement('button');
      autoBtn.className='btn-cancel'; autoBtn.textContent='自動裁切';
      autoBtn.title='依當前圖層內容物自動偵測邊界並裁切';
      autoBtn.addEventListener('click',()=>{
        let minX=App.docWidth, minY=App.docHeight, maxX=-1, maxY=-1;
        App.layers.forEach(layer=>{
          if(!layer.visible) return;
          const lw=layer.canvas.width, lh=layer.canvas.height;
          const data=layer.ctx.getImageData(0,0,lw,lh).data;
          for(let y=0;y<lh;y++)
            for(let x=0;x<lw;x++)
              if(data[(y*lw+x)*4+3]>0){
                const dx=layer.x+x, dy=layer.y+y;
                if(dx<minX)minX=dx; if(dx>maxX)maxX=dx;
                if(dy<minY)minY=dy; if(dy>maxY)maxY=dy;
              }
        });
        if(maxX<0) return; // 所有可見圖層皆透明
        // 夾入文件範圍
        const docX =Math.max(0,            minX);
        const docY =Math.max(0,            minY);
        const docX2=Math.min(App.docWidth,  maxX+1);
        const docY2=Math.min(App.docHeight, maxY+1);
        const cropW=docX2-docX, cropH=docY2-docY;
        if(cropW<1||cropH<1) return;
        Hist.snapshot('自動裁切');
        App.cropDocument(docX,docY,cropW,cropH);
      });
      bar.appendChild(autoBtn);
      // separator
      const sep=document.createElement('span');
      sep.style.cssText='display:inline-block;width:1px;height:14px;background:var(--c-border2);margin:0 6px;vertical-align:middle';
      bar.appendChild(sep);
      // confirm / cancel
      const commitBtn=document.createElement('button');
      commitBtn.className='btn-ok'; commitBtn.textContent='確認裁切';
      commitBtn.addEventListener('click',()=>ToolMgr.current._apply&&ToolMgr.current._apply());
      bar.appendChild(commitBtn);
      const cancelBtn=document.createElement('button');
      cancelBtn.className='btn-cancel'; cancelBtn.textContent='取消';
      cancelBtn.addEventListener('click',()=>{
        if(ToolMgr.current){ToolMgr.current._committed=false;ToolMgr.current._drawing=false;Engine.drawOverlay();}
      });
      bar.appendChild(cancelBtn);
    }
  },

  /* ── Layer Panel ── */
  _initLayerPanel() {
    document.getElementById('btn-add-layer').addEventListener('click', ()=>LayerMgr.add());
    document.getElementById('btn-dup-layer').addEventListener('click', ()=>LayerMgr.duplicate());
    document.getElementById('btn-del-layer').addEventListener('click', ()=>LayerMgr.delete());
    document.getElementById('btn-merge-down').addEventListener('click', ()=>LayerMgr.mergeDown());

    const blendSel=document.getElementById('layer-blend-mode');
    blendSel.addEventListener('change', ()=>{
      LayerMgr.setBlendMode(App.activeLayerIndex, blendSel.value);
    });

    const opSlider=document.getElementById('layer-opacity-slider');
    const opNum   =document.getElementById('layer-opacity-num');
    opSlider.addEventListener('input', ()=>{ opNum.value=opSlider.value; LayerMgr.setOpacity(App.activeLayerIndex,+opSlider.value); });
    opNum.addEventListener('change',   ()=>{ opSlider.value=opNum.value; LayerMgr.setOpacity(App.activeLayerIndex,+opNum.value); });
  },

  _drawThumb(tc, src) {
    const ratio = src.width / src.height;
    let tw, th;
    if (ratio >= 1) { tw = THUMB_SIZE; th = Math.max(1, Math.round(THUMB_SIZE / ratio)); }
    else { th = THUMB_SIZE; tw = Math.max(1, Math.round(THUMB_SIZE * ratio)); }
    tc.canvas.width = tw;
    tc.canvas.height = th;
    tc.drawImage(src, 0, 0, tw, th);
  },

  refreshLayerPanel() {
    const list=document.getElementById('layer-list');
    list.innerHTML='';
    App.layers.forEach((layer, i)=>{
      const item=document.createElement('div');
      item.className='layer-item'+(i===App.activeLayerIndex?' active':'');
      item.draggable=true;
      item.dataset.index=i;
      item.tabIndex=-1; // focusable on click (not in tab order)

      // Thumbnail
      const thumb=document.createElement('div');
      thumb.className='layer-thumb';
      const thumbCanvas=document.createElement('canvas');
      thumbCanvas.width=THUMB_SIZE; thumbCanvas.height=THUMB_SIZE;
      const tc=thumbCanvas.getContext('2d');
      this._drawThumb(tc, layer.canvas);
      thumb.appendChild(thumbCanvas);
      // Type badge
      const badge=document.createElement('div');
      badge.className='layer-type-badge'+(layer.type==='text'?' badge-text':' badge-image');
      badge.textContent=layer.type==='text'?'T':'';
      badge.title=layer.type==='text'?'文字圖層':'圖像圖層';
      thumb.appendChild(badge);
      item.appendChild(thumb);

      // Info
      const info=document.createElement('div');
      info.className='layer-info';
      const name=document.createElement('div');
      name.className='layer-name';
      name.textContent=layer.name;
      name.addEventListener('dblclick', ()=>this._renameLayer(item,i));
      const sub=document.createElement('div');
      sub.className='layer-sub';
      sub.textContent=`${layer.opacity}% ${layer.blendMode==='source-over'?'正常':layer.blendMode}`;
      info.appendChild(name); info.appendChild(sub);
      item.appendChild(info);

      // Buttons
      const btns=document.createElement('div');
      btns.className='layer-btns';

      const visBtn=document.createElement('button');
      visBtn.className='layer-btn'+(layer.visible?' active':' hidden-icon');
      visBtn.title='顯示/隱藏';
      visBtn.textContent=layer.visible?'👁':'👁';
      visBtn.addEventListener('click', e=>{
        e.stopPropagation();
        layer.visible=!layer.visible;
        Engine.composite(); this.refreshLayerPanel();
      });
      btns.appendChild(visBtn);

      const lockBtn=document.createElement('button');
      lockBtn.className='layer-btn'+(layer.locked?' active':'');
      lockBtn.title='鎖定/解鎖';
      lockBtn.textContent=layer.locked?'🔒':'🔓';
      lockBtn.addEventListener('click', e=>{
        e.stopPropagation();
        layer.locked=!layer.locked;
        this.refreshLayerPanel();
      });
      btns.appendChild(lockBtn);

      item.appendChild(btns);

      // Click to select (and restore focus so Delete key works)
      item.addEventListener('click', ()=>{
        LayerMgr.select(i);
        const active = document.querySelector('#layer-list .layer-item.active');
        if (active) active.focus({ preventScroll: true });
      });

      // Drag to reorder
      item.addEventListener('dragstart', e=>{
        e.dataTransfer.setData('text/plain',i);
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', ()=>item.classList.remove('dragging'));
      item.addEventListener('dragover', e=>{ e.preventDefault(); item.classList.add('drag-over'); });
      item.addEventListener('dragleave', ()=>item.classList.remove('drag-over'));
      item.addEventListener('drop', e=>{
        e.preventDefault();
        item.classList.remove('drag-over');
        const from=parseInt(e.dataTransfer.getData('text/plain'));
        const to=i;
        if(from!==to){ Hist.snapshot('重排圖層'); const l=App.layers.splice(from,1)[0]; App.layers.splice(to,0,l); App.activeLayerIndex=to; Engine.composite(); this.refreshLayerPanel(); }
      });

      // Right-click context menu
      item.addEventListener('contextmenu', e=>{
        e.preventDefault();
        App.activeLayerIndex=i;
        this.showContextMenu(e.clientX, e.clientY);
      });

      list.appendChild(item);
    });
  },

  _renameLayer(item, index) {
    const nameEl=item.querySelector('.layer-name');
    const input=document.createElement('input');
    input.className='layer-name-input';
    input.value=App.layers[index].name;
    nameEl.replaceWith(input);
    input.focus(); input.select();
    const commit=()=>{ LayerMgr.rename(index,input.value); this.refreshLayerPanel(); };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e=>{ if(e.key==='Enter') commit(); if(e.key==='Escape') this.refreshLayerPanel(); });
  },

  updateLayerThumb(index) {
    const items=document.querySelectorAll('.layer-item');
    if(!items[index]) return;
    const thumb=items[index].querySelector('.layer-thumb canvas');
    if(!thumb) return;
    const tc=thumb.getContext('2d');
    this._drawThumb(tc, App.layers[index].canvas);
  },

  updateLayerControls() {
    const l=LayerMgr.active();
    if(!l) return;
    document.getElementById('layer-blend-mode').value=l.blendMode;
    document.getElementById('layer-opacity-slider').value=l.opacity;
    document.getElementById('layer-opacity-num').value=l.opacity;
  },

  /* ── History Panel ── */
  refreshHistory() {
    const list=document.getElementById('history-list');
    list.innerHTML='';
    Hist.stack.forEach((entry,i)=>{
      const item=document.createElement('div');
      item.className='hist-item'+(i===Hist.index?' current':i>Hist.index?' future':'');
      item.textContent=entry.label;
      item.addEventListener('click',()=>Hist.jumpTo(i));
      list.appendChild(item);
    });
    list.scrollTop=list.scrollHeight;
  },

  /* ── Menus ── */
  _initMenus() {
    const bind=(id,fn)=>{ const el=document.getElementById(id); if(el) el.addEventListener('click',fn); };

    // File
    bind('m-new',          ()=>this.showDialog('dlg-new'));
    bind('m-open',         ()=>document.getElementById('file-input').click());
    bind('m-save-project', ()=>FileManager.saveProject());
    bind('m-open-project', ()=>document.getElementById('wpp-input').click());
    bind('m-export',       ()=>this.showExportDialog());
    bind('m-place',        ()=>{ FileManager._placeMode = true; document.getElementById('file-input').click(); });

    // .pp 檔案輸入
    document.getElementById('wpp-input').addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) FileManager.loadProject(file);
      e.target.value = ''; // 允許重複開啟同一檔案
    });

    // Edit
    bind('m-undo',      ()=>Hist.undo());
    bind('m-redo',      ()=>Hist.redo());
    bind('m-cut',       ()=>App.cut());
    bind('m-copy',      ()=>App.copySelection());
    bind('m-paste',     ()=>App.pasteFromClipboard());
    bind('m-selectall',  ()=>{ Hist.snapshot('全選'); Selection.selectAll(); });
    bind('m-deselect',   ()=>{ Hist.snapshot('取消選取'); Selection.deselect(); });
    bind('m-invert-sel', ()=>{ Hist.snapshot('反向選取'); Selection.invert(); });
    bind('m-expand-sel',   ()=>this.showSelModifyDialog('expand'));
    bind('m-contract-sel', ()=>this.showSelModifyDialog('contract'));
    bind('m-fill',      ()=>App.fillFg());
    bind('m-fill-bg',   ()=>App.fillBg());

    // Image
    bind('m-imgsize',    ()=>this.showImgSizeDialog());
    bind('m-canvassize', ()=>this.showCanvasSizeDialog());
    bind('m-rot90cw',    ()=>App.rotateDocument(90));
    bind('m-rot90ccw',   ()=>App.rotateDocument(-90));
    bind('m-rot180',     ()=>App.rotateDocument(180));
    bind('m-fliph',      ()=>App.flipDocument('h'));
    bind('m-flipv',      ()=>App.flipDocument('v'));

    // Image > Adjustments
    bind('m-adj-bc',      ()=>this.showAdjDialog('亮度/對比度', this._buildBCDialog(), (params)=>Filters.brightnessContrast(params.brightness, params.contrast)));
    bind('m-adj-hs',      ()=>this.showAdjDialog('色相/飽和度', this._buildHSDialog(), (params)=>Filters.hueSatLightness(params.hue, params.sat, params.light)));
    bind('m-adj-levels',  ()=>this.showLevelsDialog());
    bind('m-adj-curves',  ()=>this.showCurvesDialog());
    bind('m-adj-cb',      ()=>this.showColorBalanceDialog());
    bind('m-adj-invert',  ()=>Filters.invert());
    bind('m-adj-desat',   ()=>Filters.desaturate());
    bind('m-adj-threshold',()=>this.showSimpleSliderDialog('臨界值','臨界值',0,255,128,v=>Filters.threshold(v)));

    // Layer
    bind('m-newlayer', ()=>LayerMgr.add());
    bind('m-duplayer', ()=>LayerMgr.duplicate());
    bind('m-dellayer', ()=>LayerMgr.delete());
    bind('m-mergedown',()=>LayerMgr.mergeDown());
    bind('m-flatten',  ()=>LayerMgr.flatten());

    // Filter
    bind('f-gaussian',   ()=>this.showSimpleSliderDialog('高斯模糊','半徑',0.5,50,2,v=>Filters.gaussianBlur(v),true));
    bind('f-motion',     ()=>this.showMotionBlurDialog());
    bind('f-radial',     ()=>this.showSimpleSliderDialog('放射模糊','強度',1,50,10,v=>Filters.radialBlur(v),true));
    bind('f-boxblur',    ()=>this.showSimpleSliderDialog('方塊模糊','半徑',1,50,4,v=>Filters.boxBlur(v),true));
    bind('f-sharpen',    ()=>Filters.sharpen(0.8));
    bind('f-unsharp',    ()=>this.showUnsharpDialog());
    bind('f-addnoise',   ()=>this.showNoiseDialog());
    bind('f-median',     ()=>this.showSimpleSliderDialog('中位數','半徑',1,5,1,v=>Filters.medianFilter(v),true));
    bind('f-pixelate',   ()=>this.showSimpleSliderDialog('像素化','尺寸',2,100,10,v=>Filters.pixelate(v),true));
    bind('f-emboss',     ()=>Filters.emboss());
    bind('f-vignette',   ()=>this.showVignetteDialog());
    bind('f-posterize',  ()=>this.showSimpleSliderDialog('海報化','層次',2,8,4,v=>Filters.posterize(v),true));
    bind('f-glitch',     ()=>this.showSimpleSliderDialog('故障藝術','強度',5,100,20,v=>Filters.glitch(v),true));

    // About
    bind('m-about', ()=>this.showDialog('dlg-about'));

    // View
    bind('m-zoomin',  ()=>ZoomPan.zoomIn());
    bind('m-zoomout', ()=>ZoomPan.zoomOut());
    bind('m-zoomfit', ()=>ZoomPan.zoomFit());
    bind('m-zoom100', ()=>ZoomPan.zoom100());
    bind('m-rulers',  ()=>Engine.toggleRulers());
    bind('m-grid',    ()=>Engine.toggleGrid());
  },

  /* ── Dialogs ── */
  _initDialogs() {
    // New document
    document.getElementById('nw-ok').addEventListener('click', ()=>{
      const w=Math.max(1,parseInt(document.getElementById('nw-width').value)||800);
      const h=Math.max(1,parseInt(document.getElementById('nw-height').value)||600);
      const bg=document.getElementById('nw-bg').value;
      this.hideDialog('dlg-new');
      App.newDocument(w,h,bg);
    });
    document.getElementById('nw-cancel').addEventListener('click', ()=>this.hideDialog('dlg-new'));
    document.querySelectorAll('.preset').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        document.getElementById('nw-width').value=btn.dataset.w;
        document.getElementById('nw-height').value=btn.dataset.h;
      });
    });

    // Export
    document.getElementById('exp-ok').addEventListener('click', ()=>{ FileManager.exportFile(); this.hideDialog('dlg-export'); });
    document.getElementById('exp-cancel').addEventListener('click', ()=>this.hideDialog('dlg-export'));
    document.getElementById('exp-quality').addEventListener('input', ()=>{
      document.getElementById('exp-quality-val').textContent=document.getElementById('exp-quality').value;
      this._updateExportPreview();
    });
    document.getElementById('exp-format').addEventListener('change', ()=>{
      const fmt=document.getElementById('exp-format').value;
      document.getElementById('exp-quality-row').style.display=fmt==='png'?'none':'flex';
      this._updateExportPreview();
    });

    // Image size
    document.getElementById('is-ok').addEventListener('click', ()=>{
      const w=Math.max(1,parseInt(document.getElementById('is-width').value)||App.docWidth);
      const h=Math.max(1,parseInt(document.getElementById('is-height').value)||App.docHeight);
      const resample=document.getElementById('is-resample').value;
      this.hideDialog('dlg-imgsize');
      App.resizeDocument(w,h,resample);
    });
    document.getElementById('is-cancel').addEventListener('click', ()=>this.hideDialog('dlg-imgsize'));

    // Canvas size
    document.getElementById('cs-ok').addEventListener('click', ()=>{
      const w=Math.max(1,parseInt(document.getElementById('cs-width').value)||App.docWidth);
      const h=Math.max(1,parseInt(document.getElementById('cs-height').value)||App.docHeight);
      const activeAnchor=document.querySelector('.anchor-btn.active');
      const ax=parseFloat(activeAnchor?.dataset.ax||0);
      const ay=parseFloat(activeAnchor?.dataset.ay||0);
      this.hideDialog('dlg-canvassize');
      App.canvasResize(w,h,ax,ay);
    });
    document.getElementById('cs-cancel').addEventListener('click', ()=>this.hideDialog('dlg-canvassize'));
    document.querySelectorAll('.anchor-btn').forEach(btn=>{
      btn.addEventListener('click',()=>{
        document.querySelectorAll('.anchor-btn').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Adjustment dialog ok/cancel
    document.getElementById('adj-ok').addEventListener('click', ()=>{
      Filters._noHistory = false;
      const fn=this._adjApplyFn;
      if(fn){
        if(this._adjOrigData){ const l=LayerMgr.active(); if(l) l.ctx.putImageData(this._adjOrigData,0,0); }
        fn();
      }
      this.hideDialog('dlg-adj');
    });
    document.getElementById('adj-cancel').addEventListener('click', ()=>{
      Filters._noHistory = false;
      if(this._adjOrigData){
        const l=LayerMgr.active();
        if(l) l.ctx.putImageData(this._adjOrigData,0,0);
        Engine.composite();
      }
      this.hideDialog('dlg-adj');
    });

    // Filter dialog
    document.getElementById('flt-ok').addEventListener('click', ()=>{
      Filters._noHistory = false;
      const fn=this._fltApplyFn;
      if(fn){
        if(this._fltOrigData){ const l=LayerMgr.active(); if(l) l.ctx.putImageData(this._fltOrigData,0,0); }
        fn();
      }
      this.hideDialog('dlg-filter');
    });
    document.getElementById('flt-cancel').addEventListener('click', ()=>{
      Filters._noHistory = false;
      if(this._fltOrigData){
        const l=LayerMgr.active();
        if(l) l.ctx.putImageData(this._fltOrigData,0,0);
        Engine.composite();
      }
      this.hideDialog('dlg-filter');
    });

    // Selection Modify dialog
    const smRange = document.getElementById('sm-range');
    const smNum   = document.getElementById('sm-num');
    const smPreview = () => {
      if (!document.getElementById('sm-preview')?.checked || !this._smOrigMask) return;
      const r = +smRange.value;
      Selection.mask.set(this._smOrigMask);
      Selection._maskDirty = true;
      if (this._smType === 'expand') Selection.expand(r);
      else Selection.contract(r);
    };
    smRange?.addEventListener('input',  () => { smNum.value   = smRange.value; smPreview(); });
    smNum?.addEventListener('change',   () => { smRange.value = smNum.value;   smPreview(); });
    document.getElementById('sm-ok')?.addEventListener('click', () => {
      const r = +smRange.value;
      if (this._smOrigMask) { Selection.mask.set(this._smOrigMask); Selection._maskDirty = true; }
      Hist.snapshot(this._smType === 'expand' ? '擴大選取區' : '內縮選取區');
      if (this._smType === 'expand') Selection.expand(r);
      else Selection.contract(r);
      this._smOrigMask = null;
      this.hideDialog('dlg-sel-modify');
    });
    document.getElementById('sm-cancel')?.addEventListener('click', () => {
      if (this._smOrigMask) {
        Selection.mask.set(this._smOrigMask);
        Selection._maskDirty = true;
        Selection._recalcBbox();
        Selection._updateStatus();
        Engine.drawOverlay();
        this._smOrigMask = null;
      }
      this.hideDialog('dlg-sel-modify');
    });

    // Context menu
    document.getElementById('ctx-layer-dup').addEventListener('click', ()=>{ LayerMgr.duplicate(); this.hideContextMenu(); });
    document.getElementById('ctx-layer-del').addEventListener('click', ()=>{ LayerMgr.delete(); this.hideContextMenu(); });
    document.getElementById('ctx-layer-rename').addEventListener('click', ()=>{
      const items=document.querySelectorAll('.layer-item');
      if(items[App.activeLayerIndex]) this._renameLayer(items[App.activeLayerIndex],App.activeLayerIndex);
      this.hideContextMenu();
    });
    document.getElementById('ctx-layer-merge').addEventListener('click', ()=>{ LayerMgr.mergeDown(); this.hideContextMenu(); });
    document.getElementById('ctx-flatten').addEventListener('click', ()=>{ LayerMgr.flatten(); this.hideContextMenu(); });

    // Text dialog
    const _textTool = ()=>ToolMgr.tools.text;
    document.getElementById('td-ok').addEventListener('click', ()=>_textTool()?._commit());
    document.getElementById('td-cancel').addEventListener('click', ()=>_textTool()?._cancel());
    ['td-bold','td-italic','td-underline'].forEach(id=>{
      document.getElementById(id)?.addEventListener('click', ()=>{
        document.getElementById(id).classList.toggle('active');
        Engine.drawOverlay();
      });
    });
    document.getElementById('td-font').addEventListener('change', ()=>Engine.drawOverlay());
    document.getElementById('td-size').addEventListener('input', ()=>Engine.drawOverlay());
    document.getElementById('td-align').addEventListener('change', ()=>Engine.drawOverlay());
    document.getElementById('td-textarea').addEventListener('input', ()=>Engine.drawOverlay());
    document.getElementById('td-textarea').addEventListener('keydown', e=>{
      if(e.key==='Escape'){ e.preventDefault(); _textTool()?._cancel(); }
      else if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){ e.preventDefault(); _textTool()?._commit(); }
    });

    // About dialog
    document.getElementById('about-ok').addEventListener('click', ()=>this.hideDialog('dlg-about'));

    // Close dialogs on overlay click
    document.getElementById('modal-overlay').addEventListener('click', ()=>{
      document.querySelectorAll('.dialog:not(.hidden)').forEach(d=>{
        const id=d.id;
        if(id!=='dlg-new') this.hideDialog(id);
      });
    });

    // Swatches
    document.getElementById('swatch-add').addEventListener('click', ()=>{
      this._addSwatch(App.fgColor);
    });
  },

  showDialog(id) {
    document.getElementById('modal-overlay').classList.remove('hidden');
    document.getElementById(id).classList.remove('hidden');
  },

  hideDialog(id) {
    document.getElementById(id).classList.add('hidden');
    if(!document.querySelector('.dialog:not(.hidden)'))
      document.getElementById('modal-overlay').classList.add('hidden');
  },

  /* Selection Modify dialog */
  _smType: null,
  _smOrigMask: null,
  showSelModifyDialog(type) {
    if (Selection.empty()) return;
    this._smType = type;
    this._smOrigMask = new Uint8Array(Selection.mask);
    document.getElementById('sm-title').textContent = type === 'expand' ? '擴大選取區' : '內縮選取區';
    document.getElementById('sm-range').value = 5;
    document.getElementById('sm-num').value   = 5;
    this.showDialog('dlg-sel-modify');
  },

  /* Adjustment dialog builder */
  _adjApplyFn: null,
  _adjOrigData: null,
  showAdjDialog(title, bodyEl, applyFn) {
    document.getElementById('adj-title').textContent=title;
    const body=document.getElementById('adj-body');
    body.innerHTML='';
    body.appendChild(bodyEl);
    this._adjOrigData=LayerMgr.active()?.getImageData()??null;
    const preview=()=>{
      if(!document.getElementById('adj-preview').checked) return;
      if(this._adjOrigData){ const l=LayerMgr.active(); if(l) l.ctx.putImageData(this._adjOrigData,0,0); }
      applyFn(this._getAdjParams(bodyEl));
    };
    bodyEl.addEventListener('input', preview);
    this._adjApplyFn=()=>applyFn(this._getAdjParams(bodyEl));
    Filters._noHistory = true;
    this.showDialog('dlg-adj');
  },

  _getAdjParams(el) {
    const params={};
    el.querySelectorAll('input[type=range],input[type=number]').forEach(inp=>{
      params[inp.dataset.param]=+inp.value;
    });
    return params;
  },

  _buildBCDialog() {
    const div=document.createElement('div');
    div.innerHTML=`
      <div class="adj-row"><label>亮度</label><input type="range" min="-255" max="255" value="0" data-param="brightness"><input type="number" min="-255" max="255" value="0" data-param="brightness" style="width:56px"></div>
      <div class="adj-row"><label>對比度</label><input type="range" min="-255" max="255" value="0" data-param="contrast"><input type="number" min="-255" max="255" value="0" data-param="contrast" style="width:56px"></div>`;
    div.querySelectorAll('.adj-row').forEach(row=>{
      const [range,num]=row.querySelectorAll('input');
      range.addEventListener('input',()=>num.value=range.value);
      num.addEventListener('change',()=>range.value=num.value);
    });
    return div;
  },

  _buildHSDialog() {
    const div=document.createElement('div');
    div.innerHTML=`
      <div class="adj-row"><label>色相</label><input type="range" min="-180" max="180" value="0" data-param="hue"><input type="number" min="-180" max="180" value="0" data-param="hue" style="width:56px"></div>
      <div class="adj-row"><label>飽和度</label><input type="range" min="-100" max="100" value="0" data-param="sat"><input type="number" min="-100" max="100" value="0" data-param="sat" style="width:56px"></div>
      <div class="adj-row"><label>明度</label><input type="range" min="-100" max="100" value="0" data-param="light"><input type="number" min="-100" max="100" value="0" data-param="light" style="width:56px"></div>`;
    div.querySelectorAll('.adj-row').forEach(row=>{
      const [range,num]=row.querySelectorAll('input');
      range.addEventListener('input',()=>num.value=range.value);
      num.addEventListener('change',()=>range.value=num.value);
    });
    return div;
  },

  showLevelsDialog() {
    const div=document.createElement('div');
    div.innerHTML=`
      <canvas id="levels-canvas" width="256" height="80"></canvas>
      <div class="adj-row"><label>黑點</label><input type="range" id="lv-black" min="0" max="254" value="0"><input type="number" id="lv-black-n" min="0" max="254" value="0" style="width:56px"></div>
      <div class="adj-row"><label>灰點</label><input type="range" id="lv-gamma" min="1" max="999" value="100" step="1"><input type="number" id="lv-gamma-n" min="0.1" max="9.99" value="1.00" step="0.01" style="width:56px"></div>
      <div class="adj-row"><label>白點</label><input type="range" id="lv-white" min="1" max="255" value="255"><input type="number" id="lv-white-n" min="1" max="255" value="255" style="width:56px"></div>`;
    const orig=LayerMgr.active()?.getImageData()??null;
    const apply=()=>{
      if(orig){ const l=LayerMgr.active(); if(l) l.ctx.putImageData(orig,0,0); }
      const black=parseInt(div.querySelector('#lv-black').value);
      const gammaRaw=parseInt(div.querySelector('#lv-gamma').value);
      const gamma=gammaRaw/100;
      const white=parseInt(div.querySelector('#lv-white').value);
      Filters.levels(black,gamma,white);
    };
    div.addEventListener('input',()=>{ if(document.getElementById('adj-preview')?.checked) apply(); });
    // Sync pairs
    [['lv-black','lv-black-n',1],['lv-white','lv-white-n',1]].forEach(([rid,nid,scale])=>{
      const r=div.querySelector('#'+rid),n=div.querySelector('#'+nid);
      r?.addEventListener('input',()=>n.value=r.value);
      n?.addEventListener('change',()=>r.value=n.value);
    });
    const gr=div.querySelector('#lv-gamma'),gn=div.querySelector('#lv-gamma-n');
    gr?.addEventListener('input',()=>gn.value=(gr.value/100).toFixed(2));
    gn?.addEventListener('change',()=>gr.value=Math.round(gn.value*100));

    // Draw histogram
    setTimeout(()=>{
      if(!orig) return;
      const c=document.getElementById('levels-canvas');
      if(!c) return;
      const ctx=c.getContext('2d');
      const hist=new Uint32Array(256);
      for(let i=0;i<orig.data.length;i+=4){
        const g=Math.round(0.299*orig.data[i]+0.587*orig.data[i+1]+0.114*orig.data[i+2]);
        hist[g]++;
      }
      const max=Math.max(...hist);
      ctx.fillStyle='#333'; ctx.fillRect(0,0,256,80);
      ctx.fillStyle='#888';
      for(let x=0;x<256;x++){
        const h=Math.round(hist[x]/max*76);
        ctx.fillRect(x,80-h,1,h);
      }
    },50);

    document.getElementById('adj-title').textContent='色階';
    document.getElementById('adj-body').innerHTML='';
    document.getElementById('adj-body').appendChild(div);
    this._adjOrigData=orig;
    this._adjApplyFn=apply;
    Filters._noHistory = true;
    this.showDialog('dlg-adj');
  },

  showCurvesDialog() {
    const div=document.createElement('div');
    div.innerHTML=`<p style="font-size:11px;color:#888;margin-bottom:6px">點擊增加控制點，右鍵刪除</p>
      <canvas id="curves-canvas" width="256" height="256"></canvas>`;
    let points=[{x:0,y:0},{x:255,y:255}];
    let selectedPoint=null;
    const orig=LayerMgr.active()?.getImageData()??null;

    const drawCurves=()=>{
      const c=div.querySelector('#curves-canvas');
      if(!c) return;
      const ctx=c.getContext('2d');
      ctx.fillStyle='#2a2a2a'; ctx.fillRect(0,0,256,256);
      // grid
      ctx.strokeStyle='#444'; ctx.lineWidth=0.5;
      [64,128,192].forEach(v=>{
        ctx.beginPath();ctx.moveTo(v,0);ctx.lineTo(v,256);ctx.stroke();
        ctx.beginPath();ctx.moveTo(0,v);ctx.lineTo(256,v);ctx.stroke();
      });
      // diagonal reference
      ctx.strokeStyle='#555'; ctx.lineWidth=1; ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.moveTo(0,256); ctx.lineTo(256,0); ctx.stroke();
      ctx.setLineDash([]);
      // curve
      const lut=Filters._buildCurveLut(points.map(p=>({x:p.x,y:255-p.y})));
      ctx.strokeStyle='white'; ctx.lineWidth=1.5;
      ctx.beginPath();
      for(let x=0;x<256;x++){
        const y=256-lut[x];
        if(x===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.stroke();
      // points
      points.forEach(p=>{
        ctx.beginPath(); ctx.arc(p.x,p.y,4,0,Math.PI*2);
        ctx.fillStyle=selectedPoint===p?'#4a9eff':'white';
        ctx.fill();
      });
    };

    setTimeout(()=>{
      const c=div.querySelector('#curves-canvas');
      if(!c) return;
      drawCurves();
      c.addEventListener('mousedown',e=>{
        const rect=c.getBoundingClientRect();
        const x=Math.round(e.clientX-rect.left),y=Math.round(e.clientY-rect.top);
        if(e.button===2){
          // delete nearest
          const ni=points.findIndex(p=>Math.hypot(p.x-x,p.y-y)<8);
          if(ni>0&&ni<points.length-1) points.splice(ni,1);
        } else {
          const near=points.find(p=>Math.hypot(p.x-x,p.y-y)<8);
          if(near){ selectedPoint=near; }
          else { points.push({x,y}); points.sort((a,b)=>a.x-b.x); selectedPoint=points.find(p=>p.x===x&&p.y===y); }
        }
        drawCurves();
        if(document.getElementById('adj-preview')?.checked) applyPreview();
      });
      c.addEventListener('mousemove',e=>{
        if(!e.buttons||!selectedPoint) return;
        const rect=c.getBoundingClientRect();
        selectedPoint.x=clamp(Math.round(e.clientX-rect.left),0,255);
        selectedPoint.y=clamp(Math.round(e.clientY-rect.top),0,255);
        points.sort((a,b)=>a.x-b.x);
        drawCurves();
        if(document.getElementById('adj-preview')?.checked) applyPreview();
      });
      c.addEventListener('mouseup',()=>selectedPoint=null);
      c.addEventListener('contextmenu',e=>e.preventDefault());
    },50);

    const applyPreview=()=>{
      if(orig){ const l=LayerMgr.active(); if(l) l.ctx.putImageData(orig,0,0); }
      Filters.curves(points.map(p=>({x:p.x,y:255-p.y})));
    };

    document.getElementById('adj-title').textContent='曲線';
    document.getElementById('adj-body').innerHTML='';
    document.getElementById('adj-body').appendChild(div);
    this._adjOrigData=orig;
    this._adjApplyFn=applyPreview;
    Filters._noHistory = true;
    this.showDialog('dlg-adj');
  },

  showColorBalanceDialog() {
    const div=document.createElement('div');
    div.innerHTML=`
      <div style="margin-bottom:8px;font-size:11px;color:#888">色調範圍: <label><input type="radio" name="cbtone" value="shadows" checked> 暗部</label> <label><input type="radio" name="cbtone" value="mids"> 中間調</label> <label><input type="radio" name="cbtone" value="highlights"> 亮部</label></div>
      <div class="adj-row"><label>青-紅</label><input type="range" id="cb-r" min="-100" max="100" value="0"><span id="cb-r-val">0</span></div>
      <div class="adj-row"><label>洋紅-綠</label><input type="range" id="cb-g" min="-100" max="100" value="0"><span id="cb-g-val">0</span></div>
      <div class="adj-row"><label>黃-藍</label><input type="range" id="cb-b" min="-100" max="100" value="0"><span id="cb-b-val">0</span></div>`;
    const ranges=['r','g','b'];
    const tones={shadows:{r:0,g:0,b:0},mids:{r:0,g:0,b:0},highlights:{r:0,g:0,b:0}};
    const orig=LayerMgr.active()?.getImageData()??null;
    const getTone=()=>div.querySelector('input[name=cbtone]:checked')?.value||'mids';
    const sync=()=>{
      const t=getTone();
      ranges.forEach(c=>{
        const inp=div.querySelector('#cb-'+c);
        if(inp) inp.value=tones[t][c];
        const span=div.querySelector('#cb-'+c+'-val');
        if(span) span.textContent=tones[t][c];
      });
    };
    div.querySelectorAll('input[name=cbtone]').forEach(r=>r.addEventListener('change',sync));
    ranges.forEach(c=>{
      const inp=div.querySelector('#cb-'+c),span=div.querySelector('#cb-'+c+'-val');
      inp?.addEventListener('input',()=>{
        const t=getTone(); tones[t][c]=+inp.value; if(span)span.textContent=inp.value;
        if(document.getElementById('adj-preview')?.checked) applyPreview();
      });
    });
    const applyPreview=()=>{
      if(orig){ const l=LayerMgr.active(); if(l) l.ctx.putImageData(orig,0,0); }
      Filters.colorBalance(tones.shadows,tones.mids,tones.highlights);
    };
    document.getElementById('adj-title').textContent='色彩平衡';
    document.getElementById('adj-body').innerHTML='';
    document.getElementById('adj-body').appendChild(div);
    this._adjOrigData=orig;
    this._adjApplyFn=applyPreview;
    Filters._noHistory = true;
    this.showDialog('dlg-adj');
  },

  showSimpleSliderDialog(title, label, min, max, defVal, applyFn, isFilter=false) {
    const orig=LayerMgr.active()?.getImageData()??null;
    const dialogId=isFilter?'dlg-filter':'dlg-adj';
    const titleId =isFilter?'flt-title':'adj-title';
    const bodyId  =isFilter?'flt-body':'adj-body';
    const prevId  =isFilter?'flt-preview':'adj-preview';
    document.getElementById(titleId).textContent=title;
    const body=document.getElementById(bodyId);
    body.innerHTML=`<div class="adj-row"><label>${label}</label><input type="range" id="ss-range" min="${min}" max="${max}" value="${defVal}" step="${max<=5?0.5:1}"><input type="number" id="ss-num" min="${min}" max="${max}" value="${defVal}" style="width:70px"></div>`;
    const range=body.querySelector('#ss-range'),num=body.querySelector('#ss-num');
    const preview=()=>{
      if(!document.getElementById(prevId)?.checked) return;
      if(orig){ const l=LayerMgr.active(); if(l) l.ctx.putImageData(orig,0,0); }
      applyFn(+range.value);
    };
    range.addEventListener('input',()=>{ num.value=range.value; preview(); });
    num.addEventListener('change',()=>{ range.value=num.value; preview(); });
    if(isFilter){
      this._fltOrigData=orig;
      this._fltApplyFn=()=>applyFn(+range.value);
    } else {
      this._adjOrigData=orig;
      this._adjApplyFn=()=>applyFn(+range.value);
    }
    Filters._noHistory = true;
    this.showDialog(dialogId);
  },

  showMotionBlurDialog() {
    const orig=LayerMgr.active()?.getImageData()??null;
    document.getElementById('flt-title').textContent='移動模糊';
    const body=document.getElementById('flt-body');
    body.innerHTML=`
      <div class="adj-row"><label>角度</label><input type="range" id="mb-angle" min="0" max="360" value="0"><input type="number" id="mb-angle-n" min="0" max="360" value="0" style="width:56px"></div>
      <div class="adj-row"><label>距離</label><input type="range" id="mb-dist" min="1" max="100" value="10"><input type="number" id="mb-dist-n" min="1" max="100" value="10" style="width:56px"></div>`;
    const preview=()=>{
      if(!document.getElementById('flt-preview')?.checked) return;
      if(orig){ const l=LayerMgr.active(); if(l) l.ctx.putImageData(orig,0,0); }
      Filters.motionBlur(+body.querySelector('#mb-angle').value, +body.querySelector('#mb-dist').value);
    };
    [['mb-angle','mb-angle-n'],['mb-dist','mb-dist-n']].forEach(([rid,nid])=>{
      const r=body.querySelector('#'+rid),n=body.querySelector('#'+nid);
      r?.addEventListener('input',()=>{n.value=r.value;preview();});
      n?.addEventListener('change',()=>{r.value=n.value;preview();});
    });
    this._fltOrigData=orig;
    this._fltApplyFn=()=>Filters.motionBlur(+body.querySelector('#mb-angle').value, +body.querySelector('#mb-dist').value);
    Filters._noHistory = true;
    this.showDialog('dlg-filter');
  },

  showNoiseDialog() {
    const orig=LayerMgr.active()?.getImageData()??null;
    document.getElementById('flt-title').textContent='增加雜訊';
    const body=document.getElementById('flt-body');
    body.innerHTML=`
      <div class="adj-row"><label>數量</label><input type="range" id="ns-amount" min="1" max="200" value="25"><input type="number" id="ns-num" value="25" style="width:56px"></div>
      <div class="form-row"><label><input type="checkbox" id="ns-mono"> 單色</label></div>`;
    const preview=()=>{
      if(!document.getElementById('flt-preview')?.checked) return;
      if(orig){ const l=LayerMgr.active(); if(l) l.ctx.putImageData(orig,0,0); }
      Filters.addNoise(+body.querySelector('#ns-amount').value, body.querySelector('#ns-mono').checked);
    };
    const r=body.querySelector('#ns-amount'),n=body.querySelector('#ns-num');
    r?.addEventListener('input',()=>{n.value=r.value;preview();});
    n?.addEventListener('change',()=>{r.value=n.value;preview();});
    body.querySelector('#ns-mono')?.addEventListener('change',preview);
    this._fltOrigData=orig;
    this._fltApplyFn=()=>Filters.addNoise(+body.querySelector('#ns-amount').value, body.querySelector('#ns-mono').checked);
    Filters._noHistory = true;
    this.showDialog('dlg-filter');
  },

  showUnsharpDialog() {
    const orig=LayerMgr.active()?.getImageData()??null;
    document.getElementById('flt-title').textContent='遮色片銳利化';
    const body=document.getElementById('flt-body');
    body.innerHTML=`
      <div class="adj-row"><label>半徑</label><input type="range" id="us-r" min="0.5" max="50" value="2" step="0.5"><input type="number" id="us-rn" value="2" style="width:56px"></div>
      <div class="adj-row"><label>數量</label><input type="range" id="us-a" min="0" max="500" value="50"><input type="number" id="us-an" value="50" style="width:56px"></div>
      <div class="adj-row"><label>臨界值</label><input type="range" id="us-t" min="0" max="255" value="0"><input type="number" id="us-tn" value="0" style="width:56px"></div>`;
    const preview=()=>{
      if(!document.getElementById('flt-preview')?.checked) return;
      if(orig){ const l=LayerMgr.active(); if(l) l.ctx.putImageData(orig,0,0); }
      Filters.unsharpMask(+body.querySelector('#us-r').value, +body.querySelector('#us-a').value, +body.querySelector('#us-t').value);
    };
    [['us-r','us-rn'],['us-a','us-an'],['us-t','us-tn']].forEach(([rid,nid])=>{
      const r=body.querySelector('#'+rid),n=body.querySelector('#'+nid);
      r?.addEventListener('input',()=>{n.value=r.value;preview();});
      n?.addEventListener('change',()=>{r.value=n.value;preview();});
    });
    this._fltOrigData=orig;
    this._fltApplyFn=()=>Filters.unsharpMask(+body.querySelector('#us-r').value, +body.querySelector('#us-a').value, +body.querySelector('#us-t').value);
    Filters._noHistory = true;
    this.showDialog('dlg-filter');
  },

  showVignetteDialog() {
    const orig=LayerMgr.active()?.getImageData()??null;
    document.getElementById('flt-title').textContent='暗角';
    const body=document.getElementById('flt-body');
    body.innerHTML=`
      <div class="adj-row"><label>強度</label><input type="range" id="vg-s" min="0" max="100" value="50"><input type="number" id="vg-sn" value="50" style="width:56px">%</div>
      <div class="adj-row"><label>半徑</label><input type="range" id="vg-r" min="10" max="150" value="75"><input type="number" id="vg-rn" value="75" style="width:56px">%</div>`;
    const preview=()=>{
      if(!document.getElementById('flt-preview')?.checked) return;
      if(orig){ const l=LayerMgr.active(); if(l) l.ctx.putImageData(orig,0,0); }
      Filters.vignette(+body.querySelector('#vg-s').value/100, +body.querySelector('#vg-r').value/100);
    };
    [['vg-s','vg-sn'],['vg-r','vg-rn']].forEach(([rid,nid])=>{
      const r=body.querySelector('#'+rid),n=body.querySelector('#'+nid);
      r?.addEventListener('input',()=>{n.value=r.value;preview();});
      n?.addEventListener('change',()=>{r.value=n.value;preview();});
    });
    this._fltOrigData=orig;
    this._fltApplyFn=()=>Filters.vignette(+body.querySelector('#vg-s').value/100, +body.querySelector('#vg-r').value/100);
    Filters._noHistory = true;
    this.showDialog('dlg-filter');
  },

  showImgSizeDialog() {
    document.getElementById('is-width').value=App.docWidth;
    document.getElementById('is-height').value=App.docHeight;
    const wInp=document.getElementById('is-width'), hInp=document.getElementById('is-height');
    const ratio=App.docWidth/App.docHeight;
    wInp.addEventListener('input',()=>{ if(document.getElementById('is-constrain').checked) hInp.value=Math.round(wInp.value/ratio); });
    hInp.addEventListener('input',()=>{ if(document.getElementById('is-constrain').checked) wInp.value=Math.round(hInp.value*ratio); });
    this.showDialog('dlg-imgsize');
  },

  showCanvasSizeDialog() {
    document.getElementById('cs-width').value=App.docWidth;
    document.getElementById('cs-height').value=App.docHeight;
    this.showDialog('dlg-canvassize');
  },

  showExportDialog() {
    const fmt=document.getElementById('exp-format')?.value||'png';
    document.getElementById('exp-quality-row').style.display=fmt==='png'?'none':'flex';
    this._updateExportPreview();
    this.showDialog('dlg-export');
  },

  _updateExportPreview() {
    const fmt=document.getElementById('exp-format')?.value||'png';
    const q =parseInt(document.getElementById('exp-quality')?.value||92)/100;
    const comp=Engine.compCanvas;
    const prev=document.getElementById('exp-preview');
    if(!comp||!prev) return;
    // Fit preview within 276×210 while keeping aspect ratio (dialog body ≈306px)
    const maxW=276, maxH=210;
    const ratio=comp.width/comp.height;
    let pw, ph;
    if(ratio > maxW/maxH){ pw=maxW; ph=Math.round(maxW/ratio); }
    else { ph=maxH; pw=Math.round(maxH*ratio); }
    prev.width=pw; prev.height=ph;
    const ctx=prev.getContext('2d');
    ctx.clearRect(0,0,pw,ph);
    ctx.drawImage(comp,0,0,pw,ph);
    // Show estimated size
    comp.toBlob(blob=>{
      if(blob){
        const kb=blob.size/1024;
        const sizeStr=kb>=1024?`${(kb/1024).toFixed(2)} MB`:`${kb.toFixed(1)} KB`;
        document.getElementById('exp-info').textContent=`估計大小: ${sizeStr}`;
      }
    },'image/'+fmt, q);
  },

  /* Context menu */
  showContextMenu(x, y) {
    const menu=document.getElementById('layer-ctx-menu');
    menu.classList.remove('hidden');
    menu.style.left=x+'px';
    menu.style.top=y+'px';
    // 移除舊 listener（避免累積）
    if (this._hideCtxOnClick) {
      document.removeEventListener('mousedown', this._hideCtxOnClick);
    }
    // 用 setTimeout 確保本次右鍵的 mousedown 不會立即觸發
    setTimeout(() => {
      this._hideCtxOnClick = (e) => {
        // 只有點到選單外部才關閉，讓選單項目的 click 能先執行
        if (!menu.contains(e.target)) {
          this.hideContextMenu();
        }
      };
      document.addEventListener('mousedown', this._hideCtxOnClick);
    }, 0);
  },

  hideContextMenu() {
    document.getElementById('layer-ctx-menu').classList.add('hidden');
    if (this._hideCtxOnClick) {
      document.removeEventListener('mousedown', this._hideCtxOnClick);
      this._hideCtxOnClick = null;
    }
  },

  /* Swatches */
  _initColorSwatches() {
    const defaults=['#000000','#ffffff','#ff0000','#00ff00','#0000ff','#ffff00','#ff00ff','#00ffff','#ff8800','#8800ff','#888888','#444444'];
    defaults.forEach(c=>this._addSwatch(c));
  },

  _addSwatch(color) {
    const grid=document.getElementById('swatches-grid');
    const sw=document.createElement('div');
    sw.className='swatch';
    sw.style.background=color;
    sw.title=color;
    sw.addEventListener('click', ()=>App.setFgColor(color));
    sw.addEventListener('contextmenu', e=>{ e.preventDefault(); App.setBgColor(color); });
    grid.appendChild(sw);
  }
};
