'use strict';
/* ═══════════════════════════════════════════════════════
   filters.js  —  Image Adjustments + Pixel Filters
   ═══════════════════════════════════════════════════════ */

const Filters = {

  /* ── helpers ── */
  _getActive() {
    const l = LayerMgr.active();
    if (!l || l.locked) return null;
    return l;
  },

  _noHistory: false,

  _withHistory(label, fn) {
    if (!this._noHistory) Hist.snapshot(label);
    const l = this._getActive();
    if (!l) return;
    const W = l.canvas.width, H = l.canvas.height;
    const id = l.ctx.getImageData(0, 0, W, H);
    fn(id.data, W, H);
    l.ctx.putImageData(id, 0, 0);
    Engine.composite();
  },

  /* ══════════════════════════════════════
     ADJUSTMENTS
     ══════════════════════════════════════ */

  /** Brightness (-255…255) and Contrast (-255…255) */
  brightnessContrast(br, ct) {
    this._withHistory('亮度/對比', d => {
      const f = (259*(ct+255))/(255*(259-ct));
      for (let i = 0; i < d.length; i += 4) {
        d[i]   = clamp(f*(d[i]  +br-128)+128);
        d[i+1] = clamp(f*(d[i+1]+br-128)+128);
        d[i+2] = clamp(f*(d[i+2]+br-128)+128);
      }
    });
  },

  /** Hue (-180…180), Saturation (-100…100), Lightness (-100…100) */
  hueSatLightness(h, s, l) {
    this._withHistory('色相/飽和度', d => {
      for (let i = 0; i < d.length; i += 4) {
        const r=d[i]/255, g=d[i+1]/255, b=d[i+2]/255;
        let {h:hh,s:ss,v:vv}=rgbToHsv(r*255,g*255,b*255);
        hh = ((hh + h) % 360 + 360) % 360;
        ss = clamp(ss + s, 0, 100);
        vv = clamp(vv + l, 0, 100);
        const {r:nr,g:ng,b:nb}=hsvToRgb(hh,ss,vv);
        d[i]=nr; d[i+1]=ng; d[i+2]=nb;
      }
    });
  },

  /** Invert */
  invert() {
    this._withHistory('負片', d => {
      for (let i=0; i<d.length; i+=4) {
        d[i]=255-d[i]; d[i+1]=255-d[i+1]; d[i+2]=255-d[i+2];
      }
    });
  },

  /** Desaturate */
  desaturate() {
    this._withHistory('去色', d => {
      for (let i=0; i<d.length; i+=4) {
        const g=Math.round(0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]);
        d[i]=d[i+1]=d[i+2]=g;
      }
    });
  },

  /** Levels  (black, mid-gamma, white for input; outBlack, outWhite for output) */
  levels(inBlack=0, inGamma=1, inWhite=255, outBlack=0, outWhite=255) {
    this._withHistory('色階', d => {
      const table = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        let v = (clamp(i, inBlack, inWhite) - inBlack) / (inWhite - inBlack || 1);
        v = Math.pow(v, 1/inGamma);
        table[i] = Math.round(lerp(outBlack, outWhite, v));
      }
      for (let i=0; i<d.length; i+=4) {
        d[i]=table[d[i]]; d[i+1]=table[d[i+1]]; d[i+2]=table[d[i+2]];
      }
    });
  },

  /** Curves via lookup table (points array [{x,y}] 0-255) */
  curves(points) {
    if (!points || points.length < 2) return;
    this._withHistory('曲線', d => {
      const table = this._buildCurveLut(points);
      for (let i=0; i<d.length; i+=4) {
        d[i]=table[d[i]]; d[i+1]=table[d[i+1]]; d[i+2]=table[d[i+2]];
      }
    });
  },

  _buildCurveLut(points) {
    const sorted = [...points].sort((a,b)=>a.x-b.x);
    const lut = new Uint8Array(256);
    for (let x=0; x<256; x++) {
      let i=0;
      while (i<sorted.length-2 && sorted[i+1].x<=x) i++;
      const p1=sorted[i], p2=sorted[i+1];
      const t=(x-p1.x)/(p2.x-p1.x||1);
      lut[x] = Math.round(clamp(lerp(p1.y,p2.y,t),0,255));
    }
    return lut;
  },

  /** Color Balance shadows/mids/highlights each = {r,g,b} -100..100 */
  colorBalance(shadows, mids, highlights) {
    this._withHistory('色彩平衡', d => {
      for (let i=0; i<d.length; i+=4) {
        const lum=(d[i]*0.299+d[i+1]*0.587+d[i+2]*0.114)/255;
        const sw=Math.max(0,(0.5-lum)*2);
        const hw=Math.max(0,(lum-0.5)*2);
        const mw=1-sw-hw;
        d[i]  =clamp(d[i]  +shadows.r*sw*2.55+mids.r*mw*2.55+highlights.r*hw*2.55);
        d[i+1]=clamp(d[i+1]+shadows.g*sw*2.55+mids.g*mw*2.55+highlights.g*hw*2.55);
        d[i+2]=clamp(d[i+2]+shadows.b*sw*2.55+mids.b*mw*2.55+highlights.b*hw*2.55);
      }
    });
  },

  /** Threshold */
  threshold(value=128) {
    this._withHistory('臨界值', d => {
      for (let i=0; i<d.length; i+=4) {
        const g=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];
        const v=g>=value?255:0;
        d[i]=d[i+1]=d[i+2]=v;
      }
    });
  },

  /** Posterize */
  posterize(levels=4) {
    this._withHistory('海報化', d => {
      const step=255/Math.max(levels-1,1);
      for (let i=0; i<d.length; i+=4) {
        d[i]  =Math.round(Math.round(d[i]  /step)*step);
        d[i+1]=Math.round(Math.round(d[i+1]/step)*step);
        d[i+2]=Math.round(Math.round(d[i+2]/step)*step);
      }
    });
  },

  /* ══════════════════════════════════════
     PIXEL FILTERS
     ══════════════════════════════════════ */

  /** Gaussian Blur */
  gaussianBlur(radius) {
    const l=this._getActive(); if(!l) return;
    Hist.snapshot('高斯模糊');
    const W=l.canvas.width, H=l.canvas.height;
    const src=l.ctx.getImageData(0,0,W,H);
    const dst=l.ctx.createImageData(W,H);
    const kernel=this._gaussKernel(radius);
    this._convolveH(src.data,dst.data,W,H,kernel);
    const tmp=new Uint8ClampedArray(dst.data);
    this._convolveV(tmp,dst.data,W,H,kernel);
    l.ctx.putImageData(dst,0,0);
    Engine.composite();
  },

  _gaussKernel(r) {
    const size=Math.round(r)*2+1;
    const k=[], sigma=r/3||1;
    let sum=0;
    for(let i=0;i<size;i++){
      const x=i-Math.round(r);
      k[i]=Math.exp(-(x*x)/(2*sigma*sigma));
      sum+=k[i];
    }
    return k.map(v=>v/sum);
  },

  _convolveH(src,dst,W,H,k){
    const r=Math.floor(k.length/2);
    for(let y=0;y<H;y++){
      for(let x=0;x<W;x++){
        let rr=0,gg=0,bb=0,aa=0;
        for(let ki=0;ki<k.length;ki++){
          const sx=clamp(x+ki-r,0,W-1);
          const i=(y*W+sx)*4;
          rr+=src[i]*k[ki]; gg+=src[i+1]*k[ki]; bb+=src[i+2]*k[ki]; aa+=src[i+3]*k[ki];
        }
        const di=(y*W+x)*4;
        dst[di]=rr; dst[di+1]=gg; dst[di+2]=bb; dst[di+3]=aa;
      }
    }
  },

  _convolveV(src,dst,W,H,k){
    const r=Math.floor(k.length/2);
    for(let y=0;y<H;y++){
      for(let x=0;x<W;x++){
        let rr=0,gg=0,bb=0,aa=0;
        for(let ki=0;ki<k.length;ki++){
          const sy=clamp(y+ki-r,0,H-1);
          const i=(sy*W+x)*4;
          rr+=src[i]*k[ki]; gg+=src[i+1]*k[ki]; bb+=src[i+2]*k[ki]; aa+=src[i+3]*k[ki];
        }
        const di=(y*W+x)*4;
        dst[di]=rr; dst[di+1]=gg; dst[di+2]=bb; dst[di+3]=aa;
      }
    }
  },

  /** Box Blur */
  boxBlur(radius) {
    const l=this._getActive(); if(!l) return;
    Hist.snapshot('方塊模糊');
    const W=l.canvas.width, H=l.canvas.height;
    const src=l.ctx.getImageData(0,0,W,H);
    const dst=new ImageData(W,H);
    const r=Math.round(radius);
    const size=(2*r+1)*(2*r+1);
    const s=src.data, d=dst.data;
    for(let y=0;y<H;y++){
      for(let x=0;x<W;x++){
        let rr=0,gg=0,bb=0,aa=0,n=0;
        for(let dy=-r;dy<=r;dy++)
          for(let dx=-r;dx<=r;dx++){
            const sx=clamp(x+dx,0,W-1),sy=clamp(y+dy,0,H-1);
            const i=(sy*W+sx)*4;
            rr+=s[i];gg+=s[i+1];bb+=s[i+2];aa+=s[i+3];n++;
          }
        const di=(y*W+x)*4;
        d[di]=rr/n; d[di+1]=gg/n; d[di+2]=bb/n; d[di+3]=aa/n;
      }
    }
    l.ctx.putImageData(dst,0,0);
    Engine.composite();
  },

  /** Sharpen */
  sharpen(amount=0.5) {
    const l=this._getActive(); if(!l) return;
    Hist.snapshot('銳利化');
    const W=l.canvas.width, H=l.canvas.height;
    const src=l.ctx.getImageData(0,0,W,H);
    const dst=new ImageData(W,H);
    const s=src.data, d=dst.data;
    const k=[0,-amount,0,-amount,1+4*amount,-amount,0,-amount,0];
    for(let y=0;y<H;y++)
      for(let x=0;x<W;x++){
        let rr=0,gg=0,bb=0;
        const neighbors=[
          [x,y-1],[x-1,y],[x,y],[x+1,y],[x,y+1],
          [x-1,y-1],[x+1,y-1],[x-1,y+1],[x+1,y+1]
        ];
        const kk=[0,-amount,1+4*amount,-amount,0,-amount,0,-amount,0];
        // 3x3 convolution
        let w=0;
        for(let ky=-1;ky<=1;ky++)
          for(let kx=-1;kx<=1;kx++){
            const sx=clamp(x+kx,0,W-1),sy=clamp(y+ky,0,H-1);
            const si=(sy*W+sx)*4;
            const kv=(ky===0&&kx===0)?1+4*amount:(kx===0||ky===0)?-amount:0;
            rr+=s[si]*kv; gg+=s[si+1]*kv; bb+=s[si+2]*kv;
          }
        const di=(y*W+x)*4;
        d[di]=clamp(rr); d[di+1]=clamp(gg); d[di+2]=clamp(bb); d[di+3]=s[di+3];
      }
    l.ctx.putImageData(dst,0,0);
    Engine.composite();
  },

  /** Unsharp Mask */
  unsharpMask(radius=2, amount=50, threshold=0) {
    const l=this._getActive(); if(!l) return;
    Hist.snapshot('遮色片銳利化');
    const W=l.canvas.width, H=l.canvas.height;
    const orig=l.ctx.getImageData(0,0,W,H);

    // blur a copy
    const blurCanvas=document.createElement('canvas');
    blurCanvas.width=W; blurCanvas.height=H;
    const bc=blurCanvas.getContext('2d');
    bc.putImageData(orig,0,0);
    // Apply gaussian to blurCanvas
    const blurData=bc.getImageData(0,0,W,H);
    const k=this._gaussKernel(radius);
    const tmp=new Uint8ClampedArray(blurData.data.length);
    this._convolveH(blurData.data,tmp,W,H,k);
    const blurFinal=new Uint8ClampedArray(tmp.length);
    this._convolveV(tmp,blurFinal,W,H,k);

    const o=orig.data, f=amount/100;
    for(let i=0;i<o.length;i+=4){
      for(let c=0;c<3;c++){
        const diff=o[i+c]-blurFinal[i+c];
        if(Math.abs(diff)>=threshold)
          o[i+c]=clamp(o[i+c]+diff*f);
      }
    }
    l.ctx.putImageData(orig,0,0);
    Engine.composite();
  },

  /** Add Noise */
  addNoise(amount=25, monochromatic=false) {
    this._withHistory('增加雜訊', d => {
      for(let i=0;i<d.length;i+=4){
        if(monochromatic){
          const n=(Math.random()-0.5)*amount*2;
          d[i]=clamp(d[i]+n); d[i+1]=clamp(d[i+1]+n); d[i+2]=clamp(d[i+2]+n);
        } else {
          d[i]=clamp(d[i]+(Math.random()-0.5)*amount*2);
          d[i+1]=clamp(d[i+1]+(Math.random()-0.5)*amount*2);
          d[i+2]=clamp(d[i+2]+(Math.random()-0.5)*amount*2);
        }
      }
    });
  },

  /** Median filter (noise reduction) */
  medianFilter(radius=1) {
    const l=this._getActive(); if(!l) return;
    Hist.snapshot('中位數');
    const W=l.canvas.width, H=l.canvas.height;
    const src=l.ctx.getImageData(0,0,W,H);
    const dst=new ImageData(W,H);
    const s=src.data, d=dst.data;
    const r=radius;
    for(let y=0;y<H;y++)
      for(let x=0;x<W;x++){
        const rs=[],gs=[],bs=[];
        for(let dy=-r;dy<=r;dy++)
          for(let dx=-r;dx<=r;dx++){
            const sx=clamp(x+dx,0,W-1),sy=clamp(y+dy,0,H-1);
            const i=(sy*W+sx)*4;
            rs.push(s[i]);gs.push(s[i+1]);bs.push(s[i+2]);
          }
        rs.sort((a,b)=>a-b);gs.sort((a,b)=>a-b);bs.sort((a,b)=>a-b);
        const mid=Math.floor(rs.length/2);
        const di=(y*W+x)*4;
        d[di]=rs[mid];d[di+1]=gs[mid];d[di+2]=bs[mid];d[di+3]=s[di+3];
      }
    l.ctx.putImageData(dst,0,0);
    Engine.composite();
  },

  /** Motion Blur */
  motionBlur(angle=0, distance=10) {
    const l=this._getActive(); if(!l) return;
    Hist.snapshot('移動模糊');
    const W=l.canvas.width, H=l.canvas.height;
    const src=l.ctx.getImageData(0,0,W,H);
    const dst=new ImageData(W,H);
    const s=src.data, d=dst.data;
    const rad=angle*Math.PI/180;
    const cos=Math.cos(rad), sin=Math.sin(rad);
    const steps=Math.max(1,Math.round(distance));
    for(let y=0;y<H;y++)
      for(let x=0;x<W;x++){
        let rr=0,gg=0,bb=0,aa=0,n=0;
        for(let i=0;i<steps;i++){
          const t=i/steps-0.5;
          const sx=clamp(Math.round(x+t*distance*cos),0,W-1);
          const sy=clamp(Math.round(y+t*distance*sin),0,H-1);
          const idx=(sy*W+sx)*4;
          rr+=s[idx];gg+=s[idx+1];bb+=s[idx+2];aa+=s[idx+3];n++;
        }
        const di=(y*W+x)*4;
        d[di]=rr/n;d[di+1]=gg/n;d[di+2]=bb/n;d[di+3]=aa/n;
      }
    l.ctx.putImageData(dst,0,0);
    Engine.composite();
  },

  /** Pixelate */
  pixelate(size=10) {
    const l=this._getActive(); if(!l) return;
    Hist.snapshot('像素化');
    const W=l.canvas.width, H=l.canvas.height;
    const src=l.ctx.getImageData(0,0,W,H);
    const d=src.data;
    const s=Math.max(1,Math.round(size));
    for(let y=0;y<H;y+=s)
      for(let x=0;x<W;x+=s){
        const i=(y*W+x)*4;
        const r=d[i],g=d[i+1],b=d[i+2],a=d[i+3];
        for(let dy=0;dy<s&&y+dy<H;dy++)
          for(let dx=0;dx<s&&x+dx<W;dx++){
            const j=((y+dy)*W+(x+dx))*4;
            d[j]=r;d[j+1]=g;d[j+2]=b;d[j+3]=a;
          }
      }
    l.ctx.putImageData(src,0,0);
    Engine.composite();
  },

  /** Emboss */
  emboss() {
    this._withHistory('浮雕', (d,W,H) => {
      const src=new Uint8ClampedArray(d);
      for(let y=0;y<H;y++)
        for(let x=0;x<W;x++){
          const di=(y*W+x)*4;
          const pi=((y>0?y-1:0)*W+(x>0?x-1:0))*4;
          d[di]=clamp(128+(src[di]-src[pi]));
          d[di+1]=clamp(128+(src[di+1]-src[pi+1]));
          d[di+2]=clamp(128+(src[di+2]-src[pi+2]));
        }
    });
  },

  /** Vignette */
  vignette(strength=0.5, radius=0.75) {
    const l=this._getActive(); if(!l) return;
    Hist.snapshot('暗角');
    const W=l.canvas.width, H=l.canvas.height;
    // draw radial gradient on top with multiply
    l.ctx.save();
    const grad=l.ctx.createRadialGradient(W/2,H/2,0,W/2,H/2,Math.max(W,H)*radius);
    grad.addColorStop(0,'rgba(0,0,0,0)');
    grad.addColorStop(1,`rgba(0,0,0,${strength})`);
    l.ctx.globalCompositeOperation='multiply';
    l.ctx.fillStyle=grad;
    l.ctx.fillRect(0,0,W,H);
    l.ctx.restore();
    Engine.composite();
  },

  /** Glitch art */
  glitch(amount=20) {
    this._withHistory('故障藝術', (d,W,H) => {
      for(let i=0;i<amount;i++){
        const y=Math.floor(Math.random()*H);
        const h=Math.floor(Math.random()*20)+1;
        const dx=Math.floor((Math.random()-0.5)*amount*4);
        for(let dy=0;dy<h&&y+dy<H;dy++){
          const row=new Uint8Array(W*4);
          for(let x=0;x<W;x++){
            const sx=clamp(x+dx,0,W-1);
            const si=((y+dy)*W+sx)*4;
            const di=((y+dy)*W+x)*4;
            row[x*4]=d[si];row[x*4+1]=d[si+1];row[x*4+2]=d[si+2];row[x*4+3]=d[si+3];
          }
          for(let x=0;x<W;x++){
            const di=((y+dy)*W+x)*4;
            d[di]=row[x*4];d[di+1]=row[x*4+1];d[di+2]=row[x*4+2];d[di+3]=row[x*4+3];
          }
        }
      }
      // color channel shift
      const shift=Math.floor(amount*0.3);
      for(let i=0;i<d.length-shift*4;i+=4){
        d[i]=d[i+shift*4]||d[i];  // red channel shift
      }
    });
  },

  /** Radial Blur */
  radialBlur(amount=10) {
    const l=this._getActive(); if(!l) return;
    Hist.snapshot('放射模糊');
    const W=l.canvas.width, H=l.canvas.height;
    const src=l.ctx.getImageData(0,0,W,H);
    const dst=new ImageData(W,H);
    const s=src.data, d=dst.data;
    const cx=W/2, cy=H/2;
    const steps=Math.max(2,Math.round(amount));
    for(let y=0;y<H;y++)
      for(let x=0;x<W;x++){
        let rr=0,gg=0,bb=0,aa=0;
        for(let i=0;i<steps;i++){
          const t=1-i/steps*amount*0.01;
          const sx=clamp(Math.round(cx+(x-cx)*t),0,W-1);
          const sy=clamp(Math.round(cy+(y-cy)*t),0,H-1);
          const idx=(sy*W+sx)*4;
          rr+=s[idx];gg+=s[idx+1];bb+=s[idx+2];aa+=s[idx+3];
        }
        const di=(y*W+x)*4;
        d[di]=rr/steps;d[di+1]=gg/steps;d[di+2]=bb/steps;d[di+3]=aa/steps;
      }
    l.ctx.putImageData(dst,0,0);
    Engine.composite();
  }
};
