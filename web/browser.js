'use strict';

class LibraryBrowser {
  constructor({state, api, post, follow, failure, openFile, renderSelection, showStudio}) {
    Object.assign(this, {state, api, post, follow, failure, openFile, renderSelection, showStudio});
    this.offset = 0;
    this.serial = 0;
    this.view = localStorage.getItem('mme.view') || 'grid';
    this.treeCache = new Map();
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        this.observer.unobserve(entry.target);
        this.loadPreview(entry.target);
      }
    }, {root: document.getElementById('listScroll'), rootMargin: '100px'});
    this.previewQueue = [];
    this.previewBusy = false;
    this.el('searchInput').oninput = () => {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => { this.offset = 0; this.load(this.state.cwd); }, 180);
    };
    for (const id of ['scopeSelect', 'formatFilter', 'sortSelect', 'sortDirection', 'duplicateFilter', 'tagFilter', 'statusFilter', 'geometryFilter']) {
      this.el(id).onchange = () => {
        if (['duplicateFilter','geometryFilter'].includes(id) && this.el(id).checked) this.el('scopeSelect').value = 'library';
        this.offset = 0; this.load(this.state.cwd);
      };
    }
    this.el('viewModes').onclick = event => {
      const button = event.target.closest('[data-view]');
      if (button) { this.view = button.dataset.view; localStorage.setItem('mme.view', this.view); this.render(); }
    };
    this.el('previousPage').onclick = () => { this.offset = Math.max(0, this.offset - 80); this.load(this.state.cwd); };
    this.el('nextPage').onclick = () => { this.offset += 80; this.load(this.state.cwd); };
    this.el('indexFolder').onclick = () => this.runJob('scan');
    this.el('findDuplicates').onclick = () => this.runJob('duplicates');
    this.el('refreshFolder').onclick = () => { this.treeCache.clear(); this.load(this.state.cwd); };
    this.el('pathForm').onsubmit = event => {
      event.preventDefault(); this.navigate(this.el('pathInput').value.trim());
    };
  }

  el(id) { return document.getElementById(id); }

  async load(path) {
    const serial = ++this.serial;
    const params = new URLSearchParams({path: path || '', search: this.el('searchInput').value,
      scope: this.el('scopeSelect').value, ext: this.el('formatFilter').value,
      sort: this.el('sortSelect').value, desc: this.el('sortDirection').value,
      duplicates: this.el('duplicateFilter').checked ? '1' : '0', tag:this.el('tagFilter').value, status:this.el('statusFilter').value, collection:this.collectionId||'', geometry:this.el('geometryFilter').checked?'1':'0', offset: this.offset, limit: 80});
    this.el('resultsStatus').textContent = 'Loading models…';
    try {
      const data = await this.api('/api/browse?' + params);
      if (serial !== this.serial) return;
      if (this.offset && this.offset >= data.total) { this.offset = 0; return this.load(path); }
      this.state.listing = data; this.state.cwd = data.path;
      this.el('pathInput').value = data.path;
      localStorage.setItem('mme.folder', data.path);
      this.treeCache.set(data.path, data.dirs);
      this.render();
      await this.renderTree(data);
    } catch (err) {
      if (serial === this.serial) { this.el('resultsStatus').textContent = 'Could not load this folder'; this.failure(err); }
    }
  }

  navigate(path) { this.collectionId=''; this.offset = 0; return this.load(path); }

  async runJob(kind) {
    const path = this.state.cwd;
    this.el('indexFolder').disabled = this.el('findDuplicates').disabled = true;
    try {
      const {job} = await this.post('/api/' + kind, {path});
      const result = await this.follow(job);
      if (!result) return;
      if (this.state.cwd !== path) return;
      this.el('scopeSelect').value = 'library';
      if (kind === 'duplicates') this.el('duplicateFilter').checked = true;
      this.offset = 0;
      await this.load(path);
      const summary = kind === 'scan' ? `${result.indexed.toLocaleString()} models indexed` : `${result.duplicateFiles.toLocaleString()} exact duplicate files`;
      this.el('libraryStatus').textContent = summary + (result.errorCount ? ` · ${result.errorCount} unreadable files/folders` : '');
      this.el('jobErrors').hidden = !result.errorCount;
      this.el('jobErrors').textContent = result.errors.join('\n');
    } catch (err) { this.failure(err); }
    finally { this.el('indexFolder').disabled = this.el('findDuplicates').disabled = false; }
  }

  async renderTree(data) {
    const container = this.el('folderTree');
    container.replaceChildren();
    const generation = this.serial;
    const makeNode = (name, path, expanded = false) => {
      const details = document.createElement('details');
      details.open = expanded;
      const summary = document.createElement('summary');
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = name; button.title = path;
      button.className = path === this.state.cwd ? 'tree-current' : '';
      button.onclick = event => { event.preventDefault(); this.navigate(path); };
      summary.append(button); details.append(summary);
      const children = document.createElement('div'); children.className = 'tree-children'; details.append(children);
      let loaded = false;
      const populate = async () => {
        if (loaded) return;
        loaded = true;
        try {
          let dirs = this.treeCache.get(path);
          if (!dirs) {
            const listing = await this.api('/api/list?' + new URLSearchParams({path, dirsOnly: '1'}));
            dirs = listing.dirs; this.treeCache.set(path, dirs);
          }
          if (generation !== this.serial) return;
          children.replaceChildren(...dirs.map(dir => makeNode(dir.name, dir.path)));
          if (!dirs.length) { const empty = document.createElement('span'); empty.className = 'hint'; empty.textContent = 'No subfolders'; children.append(empty); }
        } catch (err) { loaded = false; children.textContent = err.message; }
      };
      details.ontoggle = () => { if (details.open) populate(); };
      if (expanded) populate();
      return details;
    };
    // An ancestor chain keeps deep paths reachable without eagerly loading the home folder.
    for (let i = 0; i < data.crumbs.length - 1; i++) {
      const crumb = data.crumbs[i];
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'tree-ancestor'; button.textContent = '↰ ' + crumb.name;
      button.onclick = () => this.navigate(crumb.path); container.append(button);
    }
    container.append(makeNode(data.crumbs.at(-1)?.name || data.path, data.path, true));
  }

  render() {
    const data = this.state.listing;
    if (!data) return;
    this.observer.disconnect(); this.previewQueue.length = 0;
    const crumbs = this.el('crumbs'); crumbs.replaceChildren();
    data.crumbs.forEach((crumb, i) => {
      if (i) crumbs.append(document.createTextNode(' / '));
      const button = document.createElement('button'); button.type = 'button'; button.textContent = crumb.name;
      button.onclick = () => this.navigate(crumb.path); crumbs.append(button);
    });
    const dirs = this.el('dirs'); dirs.replaceChildren();
    if (data.parent) dirs.append(this.folder('↰ Parent folder', data.parent));
    if (this.view === 'folders') data.dirs.forEach(d => dirs.append(this.folder('▸ ' + d.name, d.path)));
    dirs.hidden = this.view !== 'folders';
    this.el('files').className = 'filelist view-' + this.view;
    this.el('files').replaceChildren(...data.files.map(file => this.file(file)));
    this.el('listEmpty').hidden = data.total > 0;
    this.el('listEmpty').textContent = this.el('scopeSelect').value === 'library' && !data.indexed
      ? 'This folder has no indexed models. Choose “Index folder” to include its subfolders.'
      : 'No models match this search and filters.';
    this.el('resultsStatus').textContent = `${data.total.toLocaleString()} model${data.total === 1 ? '' : 's'}`;
    this.el('libraryStatus').textContent = this.el('scopeSelect').value === 'library'
      ? `${data.indexed.toLocaleString()} indexed · ${data.duplicateGroups} duplicate groups · Index folder to refresh` : 'Browsing files on disk';
    this.el('pageStatus').textContent = data.total ? `${this.offset + 1}–${Math.min(this.offset + 80, data.total)} of ${data.total.toLocaleString()}` : '0 results';
    this.el('previousPage').disabled = this.offset === 0;
    this.el('nextPage').disabled = this.offset + 80 >= data.total;
    for (const button of this.el('viewModes').querySelectorAll('button')) {
      const active = button.dataset.view === this.view;
      button.setAttribute('aria-pressed', String(active));
    }
    this.renderSelection();
    if(typeof workspace!=='undefined')workspace.renderCollections();
  }

  folder(name, path) {
    const li = document.createElement('li'); const button = document.createElement('button');
    button.className = 'row'; button.type = 'button'; button.textContent = name;
    button.onclick = () => this.navigate(path); li.append(button); return li;
  }

  file(file) {
    const li = document.createElement('li'); li.className = 'filerow';
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = this.state.selection.has(file.path);
    box.setAttribute('aria-label', 'Select ' + file.name);
    box.onchange = () => {
      if (box.checked) this.state.selection.add(file.path); else this.state.selection.delete(file.path);
      this.renderSelection();
    };
    const button = document.createElement('button'); button.type = 'button';
    button.className = 'row model-card' + (this.state.meta?.path === file.path ? ' active' : '');
    button.dataset.path = file.path;
    button.onclick = async () => {
      await this.openFile(file.path);
      if (this.view === 'preview' && this.state.meta?.path === file.path) this.showStudio(this.state.meta);
    };
    if (!['list', 'folders'].includes(this.view)) {
      const figure = document.createElement('div'); figure.className = 'model-image';
      const placeholder = document.createElement('span'); placeholder.className = 'model-placeholder'; placeholder.textContent = file.ext.slice(1).toUpperCase();
      const img = document.createElement('img'); img.alt = ''; img.hidden = true;
      figure.append(placeholder, img); figure.dataset.path = file.path; figure.dataset.size = file.size;
      button.append(figure); this.observer.observe(figure);
    }
    const info = document.createElement('span'); info.className = 'card-info';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = file.name; name.title = file.path;
    const detail = document.createElement('span'); detail.className = 'card-detail';
    detail.textContent = file.designer || file.title || file.folder?.split(/[\\/]/).pop() || file.ext.slice(1).toUpperCase();
    const stats = document.createElement('span'); stats.className = 'meta';
    stats.textContent = `${file.sizeText} · ${new Date(file.mtime * 1000).toLocaleDateString()}`;
    info.append(name, detail, stats);
    const status=document.createElement('span');status.className='print-status status-'+(file.status||'unprinted');status.textContent=PRINT_LABELS[file.status||'unprinted'];info.append(status);
    if(file.tags?.length){const tags=document.createElement('span');tags.className='card-tags';tags.textContent=file.tags.slice(0,4).map(t=>'#'+t).join(' ');info.append(tags)}
    if(file.geometryCount>1){const shape=document.createElement('span');shape.className='geometry-badge';shape.textContent=file.geometryCount+' matching meshes';info.append(shape)}
    if (file.duplicateCount > 1) {
      const duplicate = document.createElement('span'); duplicate.className = 'duplicate-badge';
      duplicate.textContent = `${file.duplicateCount} identical files`; duplicate.title = 'SHA-256: ' + file.hash; info.append(duplicate);
    }
    if (file.error) { const warning = document.createElement('span'); warning.className = 'card-warning'; warning.textContent = 'Metadata unavailable'; warning.title = file.error; info.append(warning); }
    if (file.hasBackup) { const flag = document.createElement('span'); flag.className = 'bakflag'; flag.textContent = '.bak'; info.append(flag); }
    button.append(info); li.append(box, button); return li;
  }

  async loadPreview(figure) {
    const path = figure.dataset.path;
    try {
      const response = await fetch('/api/preview?' + new URLSearchParams({path}), {headers: {'X-Auth': TOKEN}});
      if (!response.ok) throw new Error('No cached preview');
      const url = URL.createObjectURL(await response.blob());
      if (!figure.isConnected) { URL.revokeObjectURL(url); return; }
      const img = figure.querySelector('img');
      img.onload = img.onerror = () => URL.revokeObjectURL(url);
      img.src = url; img.hidden = false; figure.querySelector('span').hidden = true;
    } catch (_) {
      if (figure.isConnected && Number(figure.dataset.size) <= 16 * 1024 * 1024) {
        this.previewQueue.push(figure); this.pumpPreviews();
      } else if (figure.isConnected) figure.title = 'Open in the 3D studio to preview this larger model';
    }
  }

  async pumpPreviews() {
    if (this.previewBusy) return;
    this.previewBusy = true;
    try {
      while (this.previewQueue.length) {
        const figure = this.previewQueue.shift();
        if (!figure.isConnected) continue;
        await new Promise(resolve => setTimeout(resolve, 60));
        if (!this.el('studioDialog').open && !(typeof workspace!=='undefined' && workspace.shapeAbort)) {
          try {
            const studio = await import('/studio.js');
            const png = await studio.thumbnail(figure.dataset.path);
            if (figure.isConnected) {
              const img = figure.querySelector('img'); img.src = png; img.hidden = false; figure.querySelector('span').hidden = true;
            }
          } catch (err) { if (figure.isConnected) figure.title = err.message; }
        } else { this.previewQueue.unshift(figure); await new Promise(resolve => setTimeout(resolve, 500)); }
      }
    } finally { this.previewBusy = false; }
  }
}
