'use strict';
/* ═══════════════════════════════════════════════════════
   app.js  —  Main App · FileManager · Keyboard · Init
   ═══════════════════════════════════════════════════════ */

/* History instance — must be declared before App uses it */
const Hist = new History();

/* ═══════════════════════════════════════════
   Global App State
   ═══════════════════════════════════════════ */
const App = {
	docWidth: 800,
	docHeight: 600,
	zoom: 1.0,
	fgColor: '#000000',
	bgColor: '#ffffff',
	layers: [],
	activeLayerIndex: 0,
	_cursorX: undefined,
	_cursorY: undefined,
	_clipboard: null,

	brush: {
		size: 20,
		opacity: 100,
		hardness: 80,
		spacing: 0.2
	},
	stamp: {
		size: 20,
		opacity: 100,
		hardness: 80,
		brushShape: 'circle'
	},
	fill: {
		tolerance: 32
	},
	gradient: {
		type: 'linear'
	},
	selection: {
		mode: 'new',
		tolerance: 32,
		contiguous: true
	},

	setFgColor(hex) {
		this.fgColor = hex;
		document.getElementById('fg-swatch').style.background = hex;
		document.getElementById('st-color') && (document.getElementById('st-color').textContent = '前景: ' + hex);
		if (ColorPicker._target === 'fg') {
			ColorPicker.setHex(hex);
		}
	},

	setBgColor(hex) {
		this.bgColor = hex;
		document.getElementById('bg-swatch').style.background = hex;
	},

	newDocument(w, h, bg = 'white') {
		this.docWidth = w;
		this.docHeight = h;
		this.layers = [];
		this.activeLayerIndex = 0;
		Selection.init();
		Engine.resize(w, h);
		const l = new Layer('背景', w, h);
		if (bg === 'white') l.fill('#ffffff');
		else if (bg === 'black') l.fill('#000000');
		this.layers = [l];
		Hist.stack = [];
		Hist.index = -1;
		Hist.snapshot('新建文件');
		Engine.composite();
		UI.refreshLayerPanel();
		UI.refreshHistory();
		document.getElementById('st-size').textContent = `${w}×${h}`;
		document.title = 'PENPEN 0.2';
		// Set canvas container size
		const container = document.getElementById('canvas-container');
		container.style.width = w + 'px';
		container.style.height = h + 'px';
		setTimeout(() => ZoomPan.zoomFit(), 50);
		document.getElementById('welcome-screen').classList.add('hidden');
	},

	cropDocument(x, y, w, h) {
		this.docWidth = w;
		this.docHeight = h;
		this.layers.forEach(l => {
			const tmp = document.createElement('canvas');
			tmp.width = w;
			tmp.height = h;
			const tc = tmp.getContext('2d');
			tc.drawImage(l.canvas, l.x - x, l.y - y);
			l.canvas.width = w;
			l.canvas.height = h;
			l.ctx = l.canvas.getContext('2d');
			l.ctx.drawImage(tmp, 0, 0);
			l.x = 0;
			l.y = 0;
		});
		Selection.init();
		Engine.resize(w, h);
		Engine.composite();
		UI.refreshLayerPanel();
		document.getElementById('st-size').textContent = `${w}×${h}`;
	},

	resizeDocument(w, h, method = 'bilinear') {
		Hist.snapshot('影像尺寸');
		const scaleX = w / this.docWidth,
			scaleY = h / this.docHeight;
		this.layers.forEach(l => {
			l.resize(Math.round(l.canvas.width * scaleX), Math.round(l.canvas.height * scaleY), method);
			l.x = Math.round(l.x * scaleX);
			l.y = Math.round(l.y * scaleY);
		});
		this.docWidth = w;
		this.docHeight = h;
		Selection.init();
		Engine.resize(w, h);
		Engine.composite();
		UI.refreshLayerPanel();
		document.getElementById('st-size').textContent = `${w}×${h}`;
	},

	canvasResize(newW, newH, ax = 0, ay = 0) {
		Hist.snapshot('畫布尺寸');
		const dx = Math.round((newW - this.docWidth) * ax);
		const dy = Math.round((newH - this.docHeight) * ay);
		this.layers.forEach(l => {
			const tmp = document.createElement('canvas');
			tmp.width = newW;
			tmp.height = newH;
			const tc = tmp.getContext('2d');
			tc.drawImage(l.canvas, dx + l.x, dy + l.y);
			l.canvas.width = newW;
			l.canvas.height = newH;
			l.ctx = l.canvas.getContext('2d');
			l.ctx.drawImage(tmp, 0, 0);
			l.x = 0;
			l.y = 0;
		});
		this.docWidth = newW;
		this.docHeight = newH;
		Selection.init();
		Engine.resize(newW, newH);
		Engine.composite();
		UI.refreshLayerPanel();
		document.getElementById('st-size').textContent = `${newW}×${newH}`;
	},

	rotateDocument(deg) {
		Hist.snapshot(`旋轉 ${deg}°`);
		const rad = deg * Math.PI / 180;
		const cos = Math.abs(Math.cos(rad)),
			sin = Math.abs(Math.sin(rad));
		const newW = Math.round(this.docWidth * cos + this.docHeight * sin);
		const newH = Math.round(this.docWidth * sin + this.docHeight * cos);
		this.layers.forEach(l => {
			const tmp = document.createElement('canvas');
			tmp.width = newW;
			tmp.height = newH;
			const tc = tmp.getContext('2d');
			tc.translate(newW / 2, newH / 2);
			tc.rotate(rad);
			tc.drawImage(l.canvas, -l.canvas.width / 2, -l.canvas.height / 2);
			l.canvas.width = newW;
			l.canvas.height = newH;
			l.ctx = l.canvas.getContext('2d');
			l.ctx.drawImage(tmp, 0, 0);
			l.x = 0;
			l.y = 0;
		});
		this.docWidth = newW;
		this.docHeight = newH;
		Selection.init();
		Engine.resize(newW, newH);
		Engine.composite();
		UI.refreshLayerPanel();
		document.getElementById('st-size').textContent = `${newW}×${newH}`;
	},

	flipDocument(dir) {
		Hist.snapshot(dir === 'h' ? '水平翻轉' : '垂直翻轉');
		this.layers.forEach(l => {
			const tmp = document.createElement('canvas');
			tmp.width = l.canvas.width;
			tmp.height = l.canvas.height;
			const tc = tmp.getContext('2d');
			tc.translate(dir === 'h' ? l.canvas.width : 0, dir === 'v' ? l.canvas.height : 0);
			tc.scale(dir === 'h' ? -1 : 1, dir === 'v' ? -1 : 1);
			tc.drawImage(l.canvas, 0, 0);
			l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
			l.ctx.drawImage(tmp, 0, 0);
		});
		Engine.composite();
		UI.refreshLayerPanel();
	},

	fillFg() {
		const l = LayerMgr.active();
		if (!l || l.locked) return;
		Hist.snapshot('填滿前景色');
		l.ctx.save();
		l.ctx.globalCompositeOperation = 'source-over';
		l.ctx.fillStyle = this.fgColor;
		if (!Selection.empty()) {
			const W = this.docWidth,
				H = this.docHeight;
			const mc = document.createElement('canvas');
			mc.width = W;
			mc.height = H;
			const mctx = mc.getContext('2d');
			const id = mctx.createImageData(W, H);
			for (let i = 0; i < Selection.mask.length; i++) {
				id.data[i * 4] = 255;
				id.data[i * 4 + 1] = 255;
				id.data[i * 4 + 2] = 255;
				id.data[i * 4 + 3] = Selection.mask[i];
			}
			mctx.putImageData(id, 0, 0);
			const tmp = document.createElement('canvas');
			tmp.width = W;
			tmp.height = H;
			const tctx = tmp.getContext('2d');
			tctx.fillStyle = this.fgColor;
			tctx.fillRect(0, 0, W, H);
			tctx.globalCompositeOperation = 'destination-in';
			tctx.drawImage(mc, 0, 0);
			l.ctx.drawImage(tmp, 0, 0);
		} else {
			l.ctx.fillRect(0, 0, this.docWidth, this.docHeight);
		}
		l.ctx.restore();
		Engine.composite();
	},

	fillBg() {
		const l = LayerMgr.active();
		if (!l || l.locked) return;
		Hist.snapshot('填滿背景色');
		const tmp = this.fgColor;
		this.fgColor = this.bgColor;
		this.fillFg();
		this.fgColor = tmp;
	},

	copySelection() {
		const l = LayerMgr.active();
		if (!l) return;
		const bb = Selection.getBounds();
		if (!bb) {
			// copy whole layer
			this._clipboard = {
				canvas: document.createElement('canvas'),
				x: 0,
				y: 0
			};
			this._clipboard.canvas.width = l.canvas.width;
			this._clipboard.canvas.height = l.canvas.height;
			this._clipboard.canvas.getContext('2d').drawImage(l.canvas, 0, 0);
		} else {
			this._clipboard = {
				canvas: document.createElement('canvas'),
				x: bb.x,
				y: bb.y
			};
			this._clipboard.canvas.width = bb.w;
			this._clipboard.canvas.height = bb.h;
			const cc = this._clipboard.canvas.getContext('2d');
			// Apply mask
			cc.drawImage(l.canvas, -bb.x, -bb.y);
			if (!Selection.empty()) {
				const mc = document.createElement('canvas');
				mc.width = bb.w;
				mc.height = bb.h;
				const mctx = mc.getContext('2d');
				const id = mctx.createImageData(bb.w, bb.h);
				for (let y = 0; y < bb.h; y++)
					for (let x = 0; x < bb.w; x++) {
						const i = ((bb.y + y) * this.docWidth + (bb.x + x));
						id.data[(y * bb.w + x) * 4] = 255;
						id.data[(y * bb.w + x) * 4 + 1] = 255;
						id.data[(y * bb.w + x) * 4 + 2] = 255;
						id.data[(y * bb.w + x) * 4 + 3] = Selection.mask[i];
					}
				mctx.putImageData(id, 0, 0);
				cc.globalCompositeOperation = 'destination-in';
				cc.drawImage(mc, 0, 0);
			}
		}
	},

	cut() {
		this.copySelection();
		const l = LayerMgr.active();
		if (!l || l.locked) return;
		Hist.snapshot('剪下');
		if (Selection.empty()) {
			l.clear();
		} else {
			const bb = Selection.getBounds();
			if (!bb) return;
			// Erase selection area
			const W = this.docWidth,
				H = this.docHeight;
			const mc = document.createElement('canvas');
			mc.width = W;
			mc.height = H;
			const mctx = mc.getContext('2d');
			const id = mctx.createImageData(W, H);
			for (let i = 0; i < Selection.mask.length; i++) {
				id.data[i * 4] = 255;
				id.data[i * 4 + 1] = 255;
				id.data[i * 4 + 2] = 255;
				id.data[i * 4 + 3] = Selection.mask[i];
			}
			mctx.putImageData(id, 0, 0);
			l.ctx.save();
			l.ctx.globalCompositeOperation = 'destination-out';
			l.ctx.drawImage(mc, 0, 0);
			l.ctx.restore();
		}
		Engine.composite();
	},

	paste() {
		if (!this._clipboard) return;
		Hist.snapshot('貼上');
		const newLayer = new Layer('貼上的圖層', this._clipboard.canvas.width, this._clipboard.canvas.height);
		newLayer.ctx.drawImage(this._clipboard.canvas, 0, 0);
		newLayer.x = this._clipboard.x;
		newLayer.y = this._clipboard.y;
		this.layers.splice(this.activeLayerIndex + 1, 0, newLayer);
		this.activeLayerIndex++;
		Engine.composite();
		UI.refreshLayerPanel();
	}
};

/* ═══════════════════════════════════════════
   File Manager
   ═══════════════════════════════════════════ */
const FileManager = {

	savePNG() {
		if (!App.docWidth) return;
		const url = Engine.compCanvas.toDataURL('image/png');
		const a = document.createElement('a');
		a.href = url;
		a.download = 'webpainter-' + Date.now() + '.png';
		a.click();
	},

	exportFile() {
		const fmt = document.getElementById('exp-format').value;
		const qual = parseInt(document.getElementById('exp-quality').value) / 100;
		const mime = 'image/' + fmt;
		Engine.compCanvas.toBlob(blob => {
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = 'webpainter-export-' + Date.now() + '.' + (fmt === 'jpeg' ? 'jpg' : fmt);
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 5000);
		}, mime, qual);
	},

	_placeMode: false, // true = 置入（保留現有畫布）；false = 開啟（重設畫布尺寸）

	openFile(file) {
		const reader = new FileReader();
		reader.onload = e => {
			const img = new Image();
			img.onload = () => {
				const baseName = file.name.replace(/\.[^/.]+$/, '') || '背景';

				// 無論是否已有文件，皆以影像尺寸建立新畫布
				App.newDocument(img.width, img.height, 'transparent');

				// 直接將影像畫到 newDocument 建立的背景圖層，不額外新增圖層
				const layer = LayerMgr.active();
				layer.name = baseName;
				layer.ctx.drawImage(img, 0, 0);

				// 更新最新 history entry 的 label 和 snapshot（使其包含影像資料）
				if (Hist.stack.length > 0) {
					const entry = Hist.stack[Hist.index];
					entry.label = '開啟: ' + baseName;
					if (entry.snap[0]) entry.snap[0].dataURL = layer.canvas.toDataURL();
				}

				Engine.composite();
				UI.refreshLayerPanel();
				UI.refreshHistory();
				document.title = 'PENPEN — ' + baseName;
			};
			img.src = e.target.result;
		};
		reader.readAsDataURL(file);
	},

	placeImage(file) {
		const reader = new FileReader();
		reader.onload = e => {
			const img = new Image();
			img.onload = () => {
				const l = new Layer(file.name, img.width, img.height);
				l.ctx.drawImage(img, 0, 0);
				// Center on canvas
				l.x = Math.round((App.docWidth - img.width) / 2);
				l.y = Math.round((App.docHeight - img.height) / 2);
				App.layers.splice(App.activeLayerIndex + 1, 0, l);
				App.activeLayerIndex++;
				Hist.snapshot('置入: ' + file.name);
				Engine.composite();
				UI.refreshLayerPanel();
			};
			img.src = e.target.result;
		};
		reader.readAsDataURL(file);
	},

	/* ── 儲存專案 (.pp) ── */
	saveProject() {
		if (!App.docWidth || App.layers.length === 0) {
			alert('尚未建立任何文件');
			return;
		}

		// 序列化每個圖層（含像素資料）
		const layersData = App.layers.map(l => ({
			id: l.id,
			name: l.name,
			visible: l.visible,
			locked: l.locked,
			opacity: l.opacity,
			blendMode: l.blendMode,
			x: l.x,
			y: l.y,
			width: l.canvas.width,
			height: l.canvas.height,
			dataURL: l.canvas.toDataURL('image/png'), // 無損儲存像素
			type: l.type || 'image',
			textData: l.textData ? { ...l.textData } : null
		}));

		const project = {
			version: 1,
			appName: 'PENPEN',
			savedAt: new Date().toISOString(),
			docWidth: App.docWidth,
			docHeight: App.docHeight,
			activeLayerIndex: App.activeLayerIndex,
			fgColor: App.fgColor,
			bgColor: App.bgColor,
			zoom: App.zoom,
			layers: layersData
		};

		const json = JSON.stringify(project);
		const blob = new Blob([json], {
			type: 'application/json'
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'project-' + Date.now() + '.pp';
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 5000);
	},

	/* ── 開啟專案 (.pp) ── */
	loadProject(file) {
		const reader = new FileReader();
		reader.onload = e => {
			let project;
			try {
				project = JSON.parse(e.target.result);
			} catch {
				alert('無法解析專案檔，請確認格式是否正確 (.pp)');
				return;
			}
			if (project.appName !== 'PENPEN' || !project.version) {
				alert('不支援的檔案格式');
				return;
			}
			this._restoreProject(project);
		};
		reader.readAsText(file);
	},

	_restoreProject(project) {
		// 重設畫布尺寸
		App.docWidth = project.docWidth;
		App.docHeight = project.docHeight;
		App.layers = [];
		Selection.init();
		Engine.resize(project.docWidth, project.docHeight);

		// 依序還原圖層（保持索引順序）
		const ordered = new Array(project.layers.length);
		const promises = project.layers.map((ld, i) => new Promise(resolve => {
			const layer = new Layer(ld.name, ld.width || project.docWidth, ld.height || project.docHeight);
			layer.id = ld.id;
			layer.visible = ld.visible;
			layer.locked = ld.locked;
			layer.opacity = ld.opacity;
			layer.blendMode = ld.blendMode;
			layer.x = ld.x || 0;
			layer.y = ld.y || 0;
			layer.type     = ld.type || 'image';
			layer.textData = ld.textData ? { ...ld.textData } : null;

			if (layer.type === 'text' && layer.textData) {
				// Re-render text from textData (preserves editability)
				layer.renderText();
				ordered[i] = layer;
				resolve();
			} else {
				const img = new Image();
				img.onload = () => {
					layer.ctx.drawImage(img, 0, 0);
					ordered[i] = layer;
					resolve();
				};
				img.onerror = () => {
					ordered[i] = layer;
					resolve();
				};
				img.src = ld.dataURL;
			}
		}));

		Promise.all(promises).then(() => {
			App.layers = ordered;
			App.activeLayerIndex = Math.min(
				Math.max(0, project.activeLayerIndex),
				App.layers.length - 1
			);

			// 還原顏色設定
			App.setFgColor(project.fgColor || '#000000');
			App.setBgColor(project.bgColor || '#ffffff');

			// 重設歷史（新增一筆「開啟專案」紀錄）
			Hist.stack = [];
			Hist.index = -1;
			Hist.snapshot('開啟專案');

			// 更新 UI
			Engine.composite();
			UI.refreshLayerPanel();
			UI.refreshHistory();
			UI.updateLayerControls();
			document.getElementById('st-size').textContent = `${project.docWidth}×${project.docHeight}`;
			document.title = 'PENPEN';
			document.getElementById('welcome-screen').classList.add('hidden');

			// 還原縮放（或 Fit）
			if (project.zoom) ZoomPan.setZoom(project.zoom);
			else setTimeout(() => ZoomPan.zoomFit(), 50);
		});
	}
};

/* ═══════════════════════════════════════════
   Keyboard Shortcuts (Photoshop-compatible)
   ═══════════════════════════════════════════ */
function initKeyboard() {
	document.addEventListener('keydown', e => {
		const tag = document.activeElement.tagName.toLowerCase();
		if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

		const ctrl = e.ctrlKey || e.metaKey;
		const shift = e.shiftKey;
		const alt = e.altKey;

		// ── Tool shortcuts ──
		if (!ctrl && !shift && !alt) {
			switch (e.key.toUpperCase()) {
				case 'V':
					ToolMgr.activate('move');
					e.preventDefault();
					break;
				case 'M':
					ToolMgr.activate('select-rect');
					e.preventDefault();
					break;
				case 'L':
					ToolMgr.activate('lasso');
					e.preventDefault();
					break;
				case 'C':
					ToolMgr.activate('crop');
					e.preventDefault();
					break;
				case 'B':
					ToolMgr.activate('brush');
					e.preventDefault();
					break;
				case 'P':
					ToolMgr.activate('pencil');
					e.preventDefault();
					break;
				case 'E':
					ToolMgr.activate('eraser');
					e.preventDefault();
					break;
				case 'G':
					ToolMgr.activate('gradient');
					e.preventDefault();
					break;
				case 'T':
					ToolMgr.activate('text');
					e.preventDefault();
					break;
				case 'I':
					ToolMgr.activate('eyedropper');
					e.preventDefault();
					break;
				case 'S':
					ToolMgr.activate('clone-stamp');
					e.preventDefault();
					break;
				case 'H':
					ToolMgr.activate('hand');
					e.preventDefault();
					break;
				case 'Z':
					ToolMgr.activate('zoom-tool');
					e.preventDefault();
					break;
				case 'X':
					{
						const t = App.fgColor;App.setFgColor(App.bgColor);App.setBgColor(t);e.preventDefault();
						break;
					}
				case 'D':
					App.setFgColor('#000000');
					App.setBgColor('#ffffff');
					e.preventDefault();
					break;
				case '[':
					App.brush.size = Math.max(1, App.brush.size - 5);
					UI.updateToolOptions(ToolMgr.name);
					e.preventDefault();
					break;
				case ']':
					App.brush.size = Math.min(500, App.brush.size + 5);
					UI.updateToolOptions(ToolMgr.name);
					e.preventDefault();
					break;
				case 'DELETE':
				case 'BACKSPACE':
					App.fillBg();
					e.preventDefault();
					break;
			}
		}

		if (ctrl && !shift && !alt) {
			switch (e.key.toLowerCase()) {
				case 'z':
					Hist.undo();
					e.preventDefault();
					break;
				case 'y':
					Hist.redo();
					e.preventDefault();
					break;
				case 'n':
					UI.showDialog('dlg-new');
					e.preventDefault();
					break;
				case 'o':
					document.getElementById('file-input').click();
					e.preventDefault();
					break;
				case 's':
					FileManager.savePNG();
					e.preventDefault();
					break;
				case 'a':
					Selection.selectAll();
					e.preventDefault();
					break;
				case 'd':
					Selection.deselect();
					e.preventDefault();
					break;
				case 'c':
					App.copySelection();
					e.preventDefault();
					break;
				case 'x':
					App.cut();
					e.preventDefault();
					break;
				case 'v':
					App.paste();
					e.preventDefault();
					break;
				case 'i':
					Selection.invert();
					e.preventDefault();
					break;
				case 'u':
					UI.showAdjDialog('色相/飽和度', UI._buildHSDialog(), (p) => Filters.hueSatLightness(p.hue, p.sat, p.light));
					e.preventDefault();
					break;
				case 'l':
					UI.showLevelsDialog();
					e.preventDefault();
					break;
				case 'm':
					UI.showCurvesDialog();
					e.preventDefault();
					break;
				case 'e':
					LayerMgr.mergeDown();
					e.preventDefault();
					break;
				case '+':
				case '=':
					ZoomPan.zoomIn();
					e.preventDefault();
					break;
				case '-':
					ZoomPan.zoomOut();
					e.preventDefault();
					break;
				case '0':
					ZoomPan.zoomFit();
					e.preventDefault();
					break;
				case '1':
					ZoomPan.zoom100();
					e.preventDefault();
					break;
				case 'r':
					Engine.toggleRulers();
					e.preventDefault();
					break;
				case "'":
					Engine.toggleGrid();
					e.preventDefault();
					break;
			}
		}

		if (ctrl && shift && !alt) {
			switch (e.key.toLowerCase()) {
				case 'n':
					LayerMgr.add();
					e.preventDefault();
					break;
				case 's':
					FileManager.saveProject();
					e.preventDefault();
					break;
				case 'e':
					UI.showExportDialog();
					e.preventDefault();
					break;
				case 'u':
					Filters.desaturate();
					e.preventDefault();
					break;
				case 'i':
					Selection.invert();
					e.preventDefault();
					break;
			}
		}

		if (!ctrl && shift && !alt) {
			switch (e.key) {
				case 'Delete':
					App.fillFg();
					e.preventDefault();
					break;
			}
		}

		// Space = hand tool (temp)
		if (e.code === 'Space' && !ctrl && !shift) {
			if (ToolMgr.name !== 'hand') {
				ToolMgr._prevTool = ToolMgr.name;
				ToolMgr.activate('hand');
			}
			e.preventDefault();
		}

		// Pass to current tool
		if (ToolMgr.current && ToolMgr.current.onKeyDown) {
			ToolMgr.current.onKeyDown(e);
		}
	});

	document.addEventListener('keyup', e => {
		if (e.code === 'Space' && ToolMgr._prevTool) {
			ToolMgr.activate(ToolMgr._prevTool);
			ToolMgr._prevTool = null;
		}
	});
}

/* ═══════════════════════════════════════════
   Pointer Event Handling
   ═══════════════════════════════════════════ */
function initPointerEvents() {
	const ov = document.getElementById('overlay-canvas');

	const getCoords = e => {
		const {
			x,
			y
		} = Engine.screenToCanvas(e.clientX, e.clientY);
		return {
			x,
			y
		};
	};

	ov.addEventListener('pointerdown', e => {
		ov.setPointerCapture(e.pointerId);
		const {
			x,
			y
		} = getCoords(e);
		App._cursorX = x;
		App._cursorY = y;
		if (ToolMgr.current && ToolMgr.current.onPointerDown)
			ToolMgr.current.onPointerDown(e, x, y);
	});

	ov.addEventListener('pointermove', e => {
		const {
			x,
			y
		} = getCoords(e);
		App._cursorX = x;
		App._cursorY = y;
		document.getElementById('st-cursor').textContent = `${Math.round(x)}, ${Math.round(y)}`;
		if (ToolMgr.current && ToolMgr.current.onPointerMove)
			ToolMgr.current.onPointerMove(e, x, y);
		// 即使未按下滑鼠，也要重繪 overlay 以更新筆刷圓形游標
		if (!e.buttons) Engine.drawOverlay();
		Ruler.draw();
	});

	ov.addEventListener('pointerup', e => {
		const {
			x,
			y
		} = getCoords(e);
		if (ToolMgr.current && ToolMgr.current.onPointerUp)
			ToolMgr.current.onPointerUp(e, x, y);
		UI.refreshLayerPanel();
		UI.updateLayerControls();
	});

	ov.addEventListener('pointerleave', e => {
		App._cursorX = undefined;
		App._cursorY = undefined;
		if (ToolMgr.current && ToolMgr.current.drawOverlay) Engine.drawOverlay();
	});

	// Wheel zoom
	ov.addEventListener('wheel', e => {
		e.preventDefault();
		if (e.deltaY < 0) ZoomPan.zoomIn(e.clientX, e.clientY);
		else ZoomPan.zoomOut(e.clientX, e.clientY);
	}, {
		passive: false
	});

	// Scroll = pan
	document.getElementById('canvas-scroll-area').addEventListener('scroll', () => Ruler.draw());

	// Touch pinch-zoom
	let lastDist = 0;
	ov.addEventListener('touchstart', e => {
		if (e.touches.length === 2) lastDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
	}, {
		passive: true
	});
	ov.addEventListener('touchmove', e => {
		if (e.touches.length === 2) {
			const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
			if (lastDist > 0) ZoomPan.setZoom(App.zoom * (d / lastDist));
			lastDist = d;
		}
	}, {
		passive: true
	});
}

/* ═══════════════════════════════════════════
   File drag & drop
   ═══════════════════════════════════════════ */
function initDragDrop() {
	const area = document.getElementById('canvas-scroll-area');
	area.addEventListener('dragover', e => {
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
	});
	area.addEventListener('drop', e => {
		e.preventDefault();
		const file = e.dataTransfer.files[0];
		if (!file) return;
		if (file.name.endsWith('.pp')) {
			FileManager.loadProject(file); // 拖放 .pp → 開啟專案
		} else if (file.type.startsWith('image/')) {
			if (!App.docWidth || App.layers.length === 0)
				FileManager.openFile(file); // 尚無文件 → 開啟（設定畫布尺寸）
			else
				FileManager.placeImage(file); // 已有文件 → 置入新圖層
		}
	});

	document.getElementById('file-input').addEventListener('change', e => {
		const file = e.target.files[0];
		if (!file) return;
		if (FileManager._placeMode) {
			FileManager._placeMode = false;
			FileManager.placeImage(file); // 置入：保留現有畫布
		} else {
			FileManager.openFile(file); // 開啟：畫布自動對齊影像尺寸
		}
		e.target.value = '';
	});
}

/* ═══════════════════════════════════════════
   PWA Service Worker
   ═══════════════════════════════════════════ */
function initPWA() {
	if ('serviceWorker' in navigator) {
		navigator.serviceWorker.register('sw.js').catch(() => {});
	}
}

/* ═══════════════════════════════════════════
   Panel Manager
   ═══════════════════════════════════════════ */
const PanelMgr = {
	syncMenu() {
		document.querySelectorAll('.panel-toggle-item').forEach(item => {
			const panel = document.getElementById(item.dataset.panel);
			const closed = panel && panel.classList.contains('panel-closed');
			item.classList.toggle('panel-is-closed', !!closed);
		});
	},
	toggle(panelId) {
		const panel = document.getElementById(panelId);
		if (panel) panel.classList.toggle('panel-closed');
		this.syncMenu();
	},
	show(panelId) {
		const panel = document.getElementById(panelId);
		if (panel) panel.classList.remove('panel-closed');
		this.syncMenu();
	}
};

function initPanelManager() {
	// Close buttons inside each panel header
	document.querySelectorAll('.panel-close-btn').forEach(btn => {
		btn.addEventListener('click', () => {
			btn.closest('.panel').classList.add('panel-closed');
			PanelMgr.syncMenu();
		});
	});

	// Panel toggle items in 面板 menu
	document.querySelectorAll('.panel-toggle-item').forEach(item => {
		item.addEventListener('click', () => PanelMgr.toggle(item.dataset.panel));
	});

	// Initial checkmark sync (all panels open at start)
	PanelMgr.syncMenu();
}

/* ═══════════════════════════════════════════
   Panel collapse
   ═══════════════════════════════════════════ */
function initPanelCollapse() {
	document.querySelectorAll('.panel-header').forEach(h => {
		h.addEventListener('click', e => {
			// Ignore clicks on buttons or the actions container
			if (e.target.closest('button') || e.target.closest('.panel-header-actions')) return;
			h.closest('.panel').classList.toggle('collapsed');
		});
	});
}

/* ═══════════════════════════════════════════
   Resize observer (canvas wrapper)
   ═══════════════════════════════════════════ */
function initResizeObserver() {
	const sa = document.getElementById('canvas-scroll-area');
	const ro = new ResizeObserver(() => Ruler.draw());
	ro.observe(sa);
}

/* ═══════════════════════════════════════════
   Initialization
   ═══════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', () => {
	// Canvas setup
	const mainCanvas = document.getElementById('main-canvas');
	const overlayCanvas = document.getElementById('overlay-canvas');

	Engine.init(mainCanvas, overlayCanvas);

	// Register tools
	registerTools();

	// Init UI
	ColorPicker.init();
	UI.init();

	// Events
	initPointerEvents();
	initKeyboard();
	initDragDrop();
	initPanelCollapse();
	initPanelManager();
	initResizeObserver();
	initPWA();

	// Set initial colors
	App.setFgColor('#000000');
	App.setBgColor('#ffffff');

	// Sync version and changelog from changelog.js
	if (typeof CHANGELOG !== 'undefined' && CHANGELOG.length > 0) {
		const latest = CHANGELOG[0];
		const aboutVer = document.querySelector('.about-version');
		if (aboutVer) aboutVer.textContent = '版本 ' + latest.version;
		const wlcVer = document.querySelector('.wlc-version');
		if (wlcVer) wlcVer.textContent = 'v' + latest.version;
		const clHeader = document.querySelector('.about-cl-header');
		if (clHeader) clHeader.textContent = `v${latest.version}  （${latest.date}）`;
		const clList = document.querySelector('.about-cl-list');
		if (clList && latest.changes && latest.changes.length) {
			clList.innerHTML = latest.changes.map(c => `<li>${c}</li>`).join('');
		}
	}

	// Welcome screen buttons
	document.getElementById('wlc-new').addEventListener('click', () => UI.showDialog('dlg-new'));
	document.getElementById('wlc-open').addEventListener('click', () => document.getElementById('file-input').click());
	document.getElementById('wlc-project').addEventListener('click', () => document.getElementById('wpp-input').click());

	// Activate move tool
	ToolMgr.activate('brush');

	// Make canvas container have the document size
	const container = document.getElementById('canvas-container');
	// Canvas size will be set when document is created
});

/* (Hist declared at top of file) */