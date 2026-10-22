/* Static, dependency-free editor. Coordinates and brush sizes are map units.
 * Drawing commands are the source of truth; disposable raster tiles keep the
 * canvas independent of map size, zoom, device pixel ratio and undo history. */
(() => {
  'use strict';

  const WIDTH = 4096, HEIGHT = 2560, TILE = 256, CACHE_LIMIT = 160;
  const SOLID = '#344252', OPEN = '#101820', STORAGE_KEY = 'current-map';
  const $ = (id) => document.getElementById(id);
  const canvas = $('map-canvas'), ctx = canvas.getContext('2d');
  const editor = $('editor'), tileCache = new Map();
  const decoration = document.createElement('canvas');
  decoration.width = decoration.height = TILE;
  const decorationCtx = decoration.getContext('2d');
  let operations = [], redoStack = [], active = null, database = null;
  let ready = false, dirty = false, revision = 0, saveTimer, toastTimer, frame;
  let viewport = { width: 1, height: 1, dpr: 1 };
  let view = { x: WIDTH / 2, y: HEIGHT / 2, scale: 0.3 };
  let settings = { action: 'remove', tool: 'rect', size: 64, smooth: 55, grid: 32,
    showGrid: true, color: '#64b6ac', eraseDecoration: false };
  const pointers = new Map();
  let gesture = null, space = false, hover = null, shift = false;
  const actionLabels = { remove: 'Remover', fill: 'Preencher', decorate: 'Decorar' };
  const toolLabels = { rect: 'Retângulo', square: 'Quadrado', round: 'Redondo', hand: 'Mover' };
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function notify(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500);
  }

  function saveStatus(state, label) {
    $('save-state').dataset.state = state;
    $('save-label').textContent = label;
  }

  function scheduleSave(immediate = false) {
    if (!ready) return;
    dirty = true;
    revision++;
    saveStatus(database ? 'pending' : 'error', database ? 'Salvando…' : 'Sem salvamento local');
    clearTimeout(saveTimer);
    if (immediate) save();
    else saveTimer = setTimeout(save, 300);
  }

  function documentData(includeView = true) {
    const data = { format: 'clouded-level-sketch', version: 1, width: WIDTH, height: HEIGHT,
      name: $('map-name').value, operations, settings: { ...settings } };
    if (includeView) data.view = { ...view };
    return data;
  }

  function save() {
    clearTimeout(saveTimer);
    if (!dirty || !database) return;
    const savedRevision = revision;
    try {
      // IndexedDB clones the document synchronously when put is called, before
      // later pointer events can change the command list.
      const transaction = database.transaction('maps', 'readwrite');
      transaction.objectStore('maps').put(documentData(), STORAGE_KEY);
      transaction.oncomplete = () => {
        if (revision === savedRevision) {
          dirty = false;
          saveStatus('saved', 'Salvo neste navegador');
        }
      };
      transaction.onerror = () => saveFailed();
      transaction.onabort = () => saveFailed();
    } catch { saveFailed(); }
  }

  function saveFailed() {
    saveStatus('error', 'Falha ao salvar · faça backup');
    notify('Não foi possível salvar no navegador. Use Backup para guardar suas alterações.');
  }

  async function openStorage() {
    try {
      database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('clouded-level-sketch', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('maps');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => notify('Feche outras abas do editor para liberar o salvamento.');
      });
      database.onversionchange = () => { database.close(); database = null; saveFailed(); };
      const stored = await new Promise((resolve, reject) => {
        const request = database.transaction('maps').objectStore('maps').get(STORAGE_KEY);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (stored) applyDocument(validateDocument(stored), true);
      else fitMap();
      saveStatus('saved', 'Salvo neste navegador');
    } catch {
      fitMap();
      saveStatus('error', 'Sem salvamento local');
      notify('O salvamento local está indisponível ou o mapa salvo não pôde ser aberto. Você ainda pode desenhar e baixar um backup.');
      // Do not overwrite an unreadable stored map automatically.
      database?.close();
      database = null;
    }
    ready = true;
    syncUI();
    renderSoon();
  }

  function setBounds(op) {
    if (op.tool === 'rect') op.bounds = { x: op.x, y: op.y, right: op.x + op.w, bottom: op.y + op.h };
    else {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of op.points) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
      const pad = op.size + 2;
      op.bounds = { x: minX - pad, y: minY - pad, right: maxX + pad, bottom: maxY + pad };
    }
    return op;
  }

  function intersects(a, b) {
    return a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
  }

  function invalidate(bounds) {
    for (const [key, tile] of tileCache) if (intersects(tile.bounds, bounds)) tileCache.delete(key);
  }

  function paintOperation(context, op) {
    context.globalCompositeOperation = op.action === 'decorate' && op.erase ? 'destination-out' : 'source-over';
    context.fillStyle = context.strokeStyle = op.action === 'remove' ? OPEN : op.action === 'fill' ? SOLID : op.color;
    if (op.tool === 'rect') {
      context.fillRect(op.x, op.y, op.w, op.h);
    } else if (op.tool === 'square') {
      // Snap stamps rather than round line joins: every edge stays on the grid.
      const stamp = (p) => context.fillRect(Math.floor(p.x / op.grid) * op.grid,
        Math.floor(p.y / op.grid) * op.grid, op.size, op.size);
      stamp(op.points[0]);
      for (let i = 1; i < op.points.length; i++) {
        const a = op.points[i - 1], b = op.points[i];
        const steps = Math.max(1, Math.ceil(distance(a, b) / (op.grid / 2)));
        for (let j = 1; j <= steps; j++) stamp({ x: a.x + (b.x - a.x) * j / steps, y: a.y + (b.y - a.y) * j / steps });
      }
    } else {
      const points = op.points;
      context.lineWidth = op.size;
      context.lineCap = context.lineJoin = 'round';
      context.beginPath();
      if (points.length === 1) {
        context.arc(points[0].x, points[0].y, op.size / 2, 0, Math.PI * 2);
        context.fill();
      } else {
        context.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length - 1; i++) {
          context.quadraticCurveTo(points[i].x, points[i].y,
            (points[i].x + points[i + 1].x) / 2, (points[i].y + points[i + 1].y) / 2);
        }
        context.lineTo(points.at(-1).x, points.at(-1).y);
        context.stroke();
      }
    }
    context.globalCompositeOperation = 'source-over';
  }

  function getTile(tx, ty) {
    const key = `${tx},${ty}`;
    if (tileCache.has(key)) {
      const cached = tileCache.get(key);
      tileCache.delete(key); tileCache.set(key, cached);
      return cached.canvas;
    }
    const tile = document.createElement('canvas');
    tile.width = tile.height = TILE;
    const tctx = tile.getContext('2d');
    tctx.fillStyle = SOLID; tctx.fillRect(0, 0, TILE, TILE);
    decorationCtx.setTransform(1, 0, 0, 1, 0, 0);
    decorationCtx.clearRect(0, 0, TILE, TILE);
    const x = tx * TILE, y = ty * TILE;
    tctx.translate(-x, -y); decorationCtx.translate(-x, -y);
    const bounds = { x, y, right: x + TILE, bottom: y + TILE };
    const paint = (op) => {
      if (intersects(bounds, op.bounds)) paintOperation(op.action === 'decorate' ? decorationCtx : tctx, op);
    };
    operations.forEach(paint);
    if (active) paint(active);
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.globalAlpha = 0.34;
    tctx.drawImage(decoration, 0, 0);
    tileCache.set(key, { canvas: tile, bounds });
    if (tileCache.size > CACHE_LIMIT) tileCache.delete(tileCache.keys().next().value);
    return tile;
  }

  function worldToScreen(p) {
    return { x: (p.x - view.x) * view.scale + viewport.width / 2,
      y: (p.y - view.y) * view.scale + viewport.height / 2 };
  }

  function screenToWorld(p) {
    return { x: (p.x - viewport.width / 2) / view.scale + view.x,
      y: (p.y - viewport.height / 2) / view.scale + view.y };
  }

  function localPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function renderSoon() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  function render() {
    frame = null;
    const { width, height, dpr } = viewport;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0c1118'; ctx.fillRect(0, 0, width, height);
    const origin = worldToScreen({ x: 0, y: 0 });
    ctx.save();
    ctx.beginPath(); ctx.rect(origin.x, origin.y, WIDTH * view.scale, HEIGHT * view.scale); ctx.clip();
    const start = screenToWorld({ x: 0, y: 0 }), end = screenToWorld({ x: width, y: height });
    const minX = clamp(Math.floor(start.x / TILE), 0, WIDTH / TILE - 1);
    const maxX = clamp(Math.floor(end.x / TILE), 0, WIDTH / TILE - 1);
    const minY = clamp(Math.floor(start.y / TILE), 0, HEIGHT / TILE - 1);
    const maxY = clamp(Math.floor(end.y / TILE), 0, HEIGHT / TILE - 1);
    for (let ty = minY; ty <= maxY; ty++) for (let tx = minX; tx <= maxX; tx++) {
      const p = worldToScreen({ x: tx * TILE, y: ty * TILE });
      // A subpixel overlap prevents hairline gaps between scaled raster tiles.
      ctx.drawImage(getTile(tx, ty), p.x, p.y, TILE * view.scale + 0.25, TILE * view.scale + 0.25);
    }
    if (settings.showGrid) {
      let step = settings.grid;
      while (step * view.scale < 12) step *= 2;
      ctx.beginPath();
      for (let x = Math.max(0, Math.ceil(start.x / step) * step); x <= Math.min(WIDTH, end.x); x += step) {
        const p = worldToScreen({ x, y: 0 }); ctx.moveTo(p.x, origin.y); ctx.lineTo(p.x, origin.y + HEIGHT * view.scale);
      }
      for (let y = Math.max(0, Math.ceil(start.y / step) * step); y <= Math.min(HEIGHT, end.y); y += step) {
        const p = worldToScreen({ x: 0, y }); ctx.moveTo(origin.x, p.y); ctx.lineTo(origin.x + WIDTH * view.scale, p.y);
      }
      ctx.strokeStyle = '#c2d5e00d'; ctx.lineWidth = 1; ctx.stroke();
    }
    drawCursor();
    ctx.restore();
    ctx.strokeStyle = '#70839466'; ctx.lineWidth = 1;
    ctx.strokeRect(origin.x - 0.5, origin.y - 0.5, WIDTH * view.scale + 1, HEIGHT * view.scale + 1);
    $('zoom-value').textContent = `${Math.round(view.scale * 100)}%`;
    $('zoom-value').setAttribute('aria-label', `Zoom de ${Math.round(view.scale * 100)}%. Clique para 100%.`);
  }

  function drawCursor() {
    if (!hover || settings.tool === 'hand' || gesture || space || settings.tool === 'rect') return;
    const size = effectiveSize() * view.scale;
    ctx.save(); ctx.strokeStyle = settings.action === 'fill' ? '#e3b581' : settings.action === 'decorate' ? settings.color : '#a5ddd0';
    ctx.lineWidth = 1;
    if (settings.tool === 'square') {
      const p = worldToScreen({ x: Math.floor(hover.x / settings.grid) * settings.grid,
        y: Math.floor(hover.y / settings.grid) * settings.grid });
      ctx.strokeRect(p.x, p.y, size, size);
    } else {
      const p = worldToScreen(hover); ctx.beginPath(); ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  function effectiveSize() {
    return settings.tool === 'square' ? Math.ceil(settings.size / settings.grid) * settings.grid : settings.size;
  }

  function resize() {
    const rect = editor.getBoundingClientRect();
    viewport = { width: rect.width, height: rect.height, dpr: Math.min(window.devicePixelRatio || 1, 2) };
    canvas.width = Math.round(rect.width * viewport.dpr);
    canvas.height = Math.round(rect.height * viewport.dpr);
    renderSoon();
  }

  function fitMap() {
    view = { x: WIDTH / 2, y: HEIGHT / 2,
      scale: clamp(Math.min((viewport.width - 56) / WIDTH, (viewport.height - 130) / HEIGHT), 0.03, 1) };
    renderSoon();
  }

  function zoomAt(factor, point = { x: viewport.width / 2, y: viewport.height / 2 }) {
    const before = screenToWorld(point);
    view.scale = clamp(view.scale * factor, 0.03, 5);
    const after = screenToWorld(point);
    view.x += before.x - after.x; view.y += before.y - after.y;
    renderSoon(); scheduleSave();
  }

  function snapRect(point, start, square = false) {
    const grid = settings.grid;
    let x = clamp(Math.round(point.x / grid) * grid, 0, WIDTH);
    let y = clamp(Math.round(point.y / grid) * grid, 0, HEIGHT);
    if (!start) return { x, y };
    if (square) {
      const signX = x < start.x ? -1 : 1, signY = y < start.y ? -1 : 1;
      const side = Math.min(Math.max(Math.abs(x - start.x), Math.abs(y - start.y), grid),
        signX > 0 ? WIDTH - start.x : start.x, signY > 0 ? HEIGHT - start.y : start.y);
      x = start.x + signX * side; y = start.y + signY * side;
    }
    return { x: Math.min(x, start.x), y: Math.min(y, start.y),
      w: Math.max(grid, Math.abs(x - start.x)), h: Math.max(grid, Math.abs(y - start.y)) };
  }

  function beginStroke(point) {
    if (point.x < 0 || point.y < 0 || point.x >= WIDTH || point.y >= HEIGHT) return;
    active = { tool: settings.tool, action: settings.action, size: effectiveSize(), grid: settings.grid,
      color: settings.color, erase: settings.eraseDecoration };
    if (active.tool === 'rect') {
      const start = snapRect(point);
      // At the far edge a minimum-size rectangle must still fit in the map.
      start.x = Math.min(start.x, WIDTH - settings.grid);
      start.y = Math.min(start.y, HEIGHT - settings.grid);
      active.start = start;
      Object.assign(active, snapRect(point, start, shift));
    } else active.points = [{ x: point.x, y: point.y }];
    setBounds(active); invalidate(active.bounds);
    $('empty-hint').hidden = true;
    renderSoon();
  }

  function moveStroke(point, final = false) {
    if (!active) return;
    const p = { x: clamp(point.x, 0, WIDTH - 0.001), y: clamp(point.y, 0, HEIGHT - 0.001) };
    invalidate(active.bounds);
    if (active.tool === 'rect') Object.assign(active, snapRect(p, active.start, shift));
    else {
      const previous = active.points.at(-1);
      if (active.tool === 'round' && !final) {
        // Distance-based filtering is independent of event frequency and zoom.
        const lag = settings.smooth / 95 * Math.min(active.size, 64);
        const alpha = lag === 0 ? 1 : 1 - Math.exp(-distance(previous, p) / Math.max(lag, 1));
        p.x = previous.x + (p.x - previous.x) * alpha;
        p.y = previous.y + (p.y - previous.y) * alpha;
      }
      if (distance(previous, p) >= (final ? 0.01 : 0.65)) active.points.push(p);
    }
    setBounds(active); invalidate(active.bounds); renderSoon();
  }

  function finishStroke(cancel = false) {
    if (!active) return;
    invalidate(active.bounds);
    if (!cancel) {
      delete active.start;
      operations.push(active); redoStack = [];
    }
    active = null;
    syncUI(); renderSoon();
    if (!cancel) scheduleSave(true);
  }

  function startGesture() {
    const points = [...pointers.values()].slice(0, 2);
    if (points.length < 2) return;
    finishStroke(true);
    const center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    gesture = { type: 'pinch', distance: Math.max(1, distance(...points)),
      scale: view.scale, anchor: screenToWorld(center) };
    editor.classList.add('is-panning');
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!ready || (event.pointerType === 'mouse' && ![0, 1].includes(event.button))) return;
    event.preventDefault(); canvas.focus({ preventScroll: true });
    const point = localPoint(event);
    pointers.set(event.pointerId, point); canvas.setPointerCapture(event.pointerId);
    if (pointers.size >= 2) { startGesture(); return; }
    if (space || settings.tool === 'hand' || event.button === 1) {
      gesture = { type: 'pan', start: point, view: { ...view } };
      editor.classList.add('is-panning');
    } else beginStroke(screenToWorld(point));
  });

  canvas.addEventListener('pointermove', (event) => {
    const point = localPoint(event);
    hover = screenToWorld(point);
    $('pointer-position').textContent = `X ${Math.round(hover.x)} · Y ${Math.round(hover.y)} u`;
    if (!pointers.has(event.pointerId)) { renderSoon(); return; }
    pointers.set(event.pointerId, point);
    if (gesture?.type === 'pinch' && pointers.size >= 2) {
      const points = [...pointers.values()].slice(0, 2);
      const center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      view.scale = clamp(gesture.scale * distance(...points) / gesture.distance, 0.03, 5);
      view.x = gesture.anchor.x - (center.x - viewport.width / 2) / view.scale;
      view.y = gesture.anchor.y - (center.y - viewport.height / 2) / view.scale;
    } else if (gesture?.type === 'pan') {
      view.x = gesture.view.x - (point.x - gesture.start.x) / view.scale;
      view.y = gesture.view.y - (point.y - gesture.start.y) / view.scale;
    } else if (!gesture) {
      const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
      for (const sample of events.length ? events : [event]) moveStroke(screenToWorld(localPoint(sample)));
    }
    renderSoon();
  });

  function pointerEnd(event, canceled = false) {
    if (!pointers.has(event.pointerId)) return;
    if (active && !canceled) moveStroke(screenToWorld(localPoint(event)), true);
    if (active) finishStroke(canceled);
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (gesture) {
      if (!pointers.size) { gesture = null; editor.classList.remove('is-panning'); scheduleSave(); }
      else if (pointers.size >= 2) startGesture();
      else if (gesture.type === 'pinch') {
        // The remaining finger can pan, but cannot accidentally start drawing.
        gesture = { type: 'pan', start: [...pointers.values()][0], view: { ...view } };
      }
    }
    if (event.pointerType !== 'mouse') hover = null;
    renderSoon();
  }

  canvas.addEventListener('pointerup', (event) => pointerEnd(event));
  canvas.addEventListener('pointercancel', (event) => pointerEnd(event, true));
  canvas.addEventListener('lostpointercapture', (event) => pointerEnd(event, true));
  canvas.addEventListener('pointerleave', () => { hover = null; renderSoon(); });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault(); if (active || !ready) return;
    zoomAt(Math.exp(clamp(-event.deltaY * (event.deltaMode === 1 ? 0.035 : 0.0015), -0.5, 0.5)), localPoint(event));
  }, { passive: false });

  function syncUI() {
    document.querySelectorAll('[data-action], [data-quick-action]').forEach((button) => {
      const selected = (button.dataset.action || button.dataset.quickAction) === settings.action;
      button.classList.toggle('active', selected); button.setAttribute('aria-pressed', selected);
    });
    document.querySelectorAll('[data-tool], [data-quick-tool]').forEach((button) => {
      const selected = (button.dataset.tool || button.dataset.quickTool) === settings.tool;
      button.classList.toggle('active', selected); button.setAttribute('aria-pressed', selected);
    });
    document.querySelectorAll('[data-color]').forEach((button) => {
      const selected = button.dataset.color === settings.color;
      button.classList.toggle('active', selected); button.setAttribute('aria-pressed', selected);
    });
    $('brush-size').value = settings.size; $('smooth').value = settings.smooth;
    $('grid-size').value = settings.grid; $('show-grid').checked = settings.showGrid;
    $('custom-color').value = settings.color; $('erase-decoration').checked = settings.eraseDecoration;
    $('size-output').textContent = `${effectiveSize()} u`;
    $('smooth-output').textContent = `${settings.smooth}%`;
    $('brush-size').disabled = ['rect', 'hand'].includes(settings.tool);
    $('smooth').disabled = settings.tool !== 'round';
    $('brush-note').textContent = { rect: 'Arraste entre dois pontos da grade.',
      square: 'Tamanho arredondado para passos do snap.', round: 'Mais suavização, menos tremores.', hand: 'Arraste para explorar o mapa.' }[settings.tool];
    $('mode-label').textContent = settings.tool === 'hand' ? 'Mover mapa' : `${settings.action === 'decorate' && settings.eraseDecoration ? 'Apagar decoração' : actionLabels[settings.action]} · ${toolLabels[settings.tool]}`;
    $('mode-dot').style.background = settings.action === 'fill' ? '#e3b581' : settings.action === 'decorate' ? settings.color : '#83c7ba';
    $('undo').disabled = !operations.length; $('redo').disabled = !redoStack.length;
    $('canvas-map-name').textContent = $('map-name').value.trim() || 'Mundo sem nome';
    $('empty-hint').hidden = operations.length > 0 || !!active;
    $('grid-button').setAttribute('aria-pressed', settings.showGrid);
    editor.dataset.tool = settings.tool;
  }

  function changeSetting(key, value) {
    if (active) finishStroke();
    settings[key] = value; syncUI(); renderSoon(); scheduleSave();
  }

  document.querySelectorAll('[data-action], [data-quick-action]').forEach((b) => b.addEventListener('click', () => changeSetting('action', b.dataset.action || b.dataset.quickAction)));
  document.querySelectorAll('[data-tool], [data-quick-tool]').forEach((b) => b.addEventListener('click', () => changeSetting('tool', b.dataset.tool || b.dataset.quickTool)));
  document.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => { settings.eraseDecoration = false; changeSetting('color', b.dataset.color); }));
  $('brush-size').addEventListener('input', (e) => changeSetting('size', Number(e.target.value)));
  $('smooth').addEventListener('input', (e) => changeSetting('smooth', Number(e.target.value)));
  $('grid-size').addEventListener('change', (e) => changeSetting('grid', Number(e.target.value)));
  $('show-grid').addEventListener('change', (e) => changeSetting('showGrid', e.target.checked));
  $('custom-color').addEventListener('input', (e) => changeSetting('color', e.target.value));
  $('erase-decoration').addEventListener('change', (e) => changeSetting('eraseDecoration', e.target.checked));
  $('map-name').addEventListener('input', () => { syncUI(); scheduleSave(); });

  function undo() {
    if (!ready || active || !operations.length) return;
    const op = operations.pop(); redoStack.push(op); invalidate(op.bounds);
    syncUI(); renderSoon(); scheduleSave(true);
  }
  function redo() {
    if (!ready || active || !redoStack.length) return;
    const op = redoStack.pop(); operations.push(op); invalidate(op.bounds);
    syncUI(); renderSoon(); scheduleSave(true);
  }
  $('undo').addEventListener('click', undo); $('redo').addEventListener('click', redo);
  $('zoom-in').addEventListener('click', () => zoomAt(1.25));
  $('zoom-out').addEventListener('click', () => zoomAt(0.8));
  $('zoom-value').addEventListener('click', () => zoomAt(1 / view.scale));
  $('fit-map').addEventListener('click', () => { fitMap(); scheduleSave(); });
  $('grid-button').addEventListener('click', () => changeSetting('showGrid', !settings.showGrid));
  $('toggle-settings').addEventListener('click', () => {
    const open = $('sidebar').classList.toggle('open');
    $('toggle-settings').setAttribute('aria-expanded', open);
    $('toggle-settings').setAttribute('aria-label', open ? 'Fechar ajustes' : 'Abrir ajustes');
  });
  $('help-button').addEventListener('click', () => $('help-dialog').showModal());
  $('sidebar-help').addEventListener('click', () => $('help-dialog').showModal());
  document.querySelectorAll('.dialog-close').forEach((b) => b.addEventListener('click', () => $('help-dialog').close()));

  window.addEventListener('keydown', (event) => {
    if (/INPUT|SELECT|TEXTAREA/.test(event.target.tagName) || event.target.isContentEditable || $('help-dialog').open || !ready) return;
    shift = event.shiftKey;
    const key = event.key.toLowerCase(), mod = event.ctrlKey || event.metaKey;
    if (mod && key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
    if (mod && key === 'y') { event.preventDefault(); redo(); return; }
    if (mod) return;
    if (event.code === 'Space') { event.preventDefault(); space = true; editor.classList.add('is-panning'); return; }
    if (key === 'escape') { finishStroke(true); $('sidebar').classList.remove('open'); $('toggle-settings').setAttribute('aria-expanded', false); }
    if (active) return;
    if (['1', '2', '3'].includes(key)) changeSetting('action', { 1: 'remove', 2: 'fill', 3: 'decorate' }[key]);
    if (['r', 'b', 'c', 'h'].includes(key)) changeSetting('tool', { r: 'rect', b: 'square', c: 'round', h: 'hand' }[key]);
    if (key === 'g') changeSetting('showGrid', !settings.showGrid);
    if (key === 'f') { fitMap(); scheduleSave(); }
    if (key === '[' || key === ']') changeSetting('size', clamp(settings.size + (key === '[' ? -8 : 8), 8, 256));
    if (key === '+' || key === '=') zoomAt(1.25);
    if (key === '-') zoomAt(0.8);
    if (key === '?') $('help-dialog').showModal();
  });
  window.addEventListener('keyup', (e) => { shift = e.shiftKey; if (e.code === 'Space') { space = false; if (!gesture) editor.classList.remove('is-panning'); } });
  window.addEventListener('blur', () => {
    finishStroke(); pointers.clear(); gesture = null; space = false; shift = false;
    editor.classList.remove('is-panning'); save();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { finishStroke(); save(); } });
  window.addEventListener('pagehide', save);

  function download(blob, extension) {
    const link = document.createElement('a'), url = URL.createObjectURL(blob);
    link.href = url;
    link.download = `${($('map-name').value || 'level-sketch').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 80)}.${extension}`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  $('export-json').addEventListener('click', () => {
    if (!ready) return;
    download(new Blob([JSON.stringify(documentData(false))], { type: 'application/json' }), 'json');
    notify('Backup baixado. Abra este arquivo no outro dispositivo para continuar.');
  });

  $('export-png').addEventListener('click', async () => {
    if (!ready || active) return;
    const button = $('export-png'); button.disabled = true; button.textContent = 'Gerando imagem…';
    // Yield so the progress label is visible before rasterizing the full map.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    const output = document.createElement('canvas'); output.width = WIDTH; output.height = HEIGHT;
    try {
      const outputCtx = output.getContext('2d');
      for (let y = 0; y < HEIGHT / TILE; y++) for (let x = 0; x < WIDTH / TILE; x++) outputCtx.drawImage(getTile(x, y), x * TILE, y * TILE);
      const blob = await new Promise((resolve) => output.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('PNG unavailable');
      download(blob, 'png'); notify('Imagem completa exportada, sem grade, em 4096 × 2560 px.');
    } catch { notify('Não foi possível gerar a imagem. Tente novamente ou salve um backup JSON.'); }
    finally { output.width = output.height = 0; button.disabled = false; button.textContent = 'Exportar imagem PNG ↗'; }
  });

  const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  const colorValid = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

  function validateDocument(data) {
    if (!data || data.format !== 'clouded-level-sketch' || data.version !== 1 || data.width !== WIDTH || data.height !== HEIGHT ||
      typeof data.name !== 'string' || data.name.length > 80 || !Array.isArray(data.operations) || data.operations.length > 50000) throw new Error('Formato de mapa incompatível.');
    let totalPoints = 0;
    const validated = data.operations.map((op) => {
      if (!op || !['rect', 'square', 'round'].includes(op.tool) || !['remove', 'fill', 'decorate'].includes(op.action) ||
        !finite(op.size, 1, 512) || ![8, 16, 32, 64, 128].includes(op.grid) || !colorValid(op.color) || typeof op.erase !== 'boolean') throw new Error('O backup contém um pincel inválido.');
      const clean = { tool: op.tool, action: op.action, size: op.size, grid: op.grid, color: op.color, erase: op.erase };
      if (op.tool === 'rect') {
        if (!finite(op.x, 0, WIDTH) || !finite(op.y, 0, HEIGHT) || !finite(op.w, 1, WIDTH) || !finite(op.h, 1, HEIGHT) || op.x + op.w > WIDTH || op.y + op.h > HEIGHT) throw new Error('O backup contém uma área fora do mapa.');
        Object.assign(clean, { x: op.x, y: op.y, w: op.w, h: op.h });
      } else {
        if (!Array.isArray(op.points) || !op.points.length || (totalPoints += op.points.length) > 1000000) throw new Error('O backup contém traços inválidos ou é muito grande.');
        clean.points = op.points.map((p) => {
          if (!p || !finite(p.x, 0, WIDTH) || !finite(p.y, 0, HEIGHT)) throw new Error('O backup contém coordenadas inválidas.');
          return { x: p.x, y: p.y };
        });
      }
      return setBounds(clean);
    });
    const prefs = data.settings || {}, cleanSettings = { ...settings };
    if (['remove', 'fill', 'decorate'].includes(prefs.action)) cleanSettings.action = prefs.action;
    if (['rect', 'square', 'round', 'hand'].includes(prefs.tool)) cleanSettings.tool = prefs.tool;
    if (finite(prefs.size, 8, 256)) cleanSettings.size = Math.round(prefs.size / 8) * 8;
    if (finite(prefs.smooth, 0, 95)) cleanSettings.smooth = prefs.smooth;
    if ([8, 16, 32, 64, 128].includes(prefs.grid)) cleanSettings.grid = prefs.grid;
    if (typeof prefs.showGrid === 'boolean') cleanSettings.showGrid = prefs.showGrid;
    if (typeof prefs.eraseDecoration === 'boolean') cleanSettings.eraseDecoration = prefs.eraseDecoration;
    if (colorValid(prefs.color)) cleanSettings.color = prefs.color;
    const cleanView = data.view && finite(data.view.x, -1000000, 1000000) && finite(data.view.y, -1000000, 1000000) && finite(data.view.scale, 0.03, 5) ? { x: data.view.x, y: data.view.y, scale: data.view.scale } : null;
    return { name: data.name, operations: validated, settings: cleanSettings, view: cleanView };
  }

  function applyDocument(data, restoreView = false) {
    operations = data.operations; redoStack = []; active = null;
    settings = data.settings; $('map-name').value = data.name;
    tileCache.clear();
    if (restoreView && data.view) view = data.view;
    else fitMap();
    syncUI(); renderSoon();
  }

  $('import-json').addEventListener('click', () => { if (ready) $('import-file').click(); });
  $('import-file').addEventListener('change', async (event) => {
    const file = event.target.files[0]; event.target.value = '';
    if (!file) return;
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error('O backup excede o limite de 25 MB.');
      const data = validateDocument(JSON.parse(await file.text()));
      if (operations.length && !window.confirm('Abrir este backup substitui o mapa atual. Já baixou um backup do mapa que deseja guardar?')) return;
      applyDocument(data); scheduleSave(true); notify('Backup aberto. Pode continuar de onde parou.');
    } catch (error) { notify(error instanceof SyntaxError ? 'Este arquivo não é um backup JSON válido.' : error.message); }
  });

  $('new-map').addEventListener('click', () => {
    if (!ready || !window.confirm('Criar um mapa novo substitui o mapa atual por uma superfície sólida. Use Backup antes se quiser guardar o desenho atual. Continuar?')) return;
    operations = []; redoStack = []; tileCache.clear();
    $('map-name').value = 'Mundo sem nome'; fitMap(); syncUI(); scheduleSave(true);
  });

  new ResizeObserver(resize).observe(editor);
  resize();
  openStorage();
})();
