'use strict';
const PRINT_LABELS={unprinted:'Unprinted',want:'Want to print',printed:'Printed',retry:'Needs another attempt'};
class Workspace {
  constructor({state,api,post,failure,browser,toast}) {
    Object.assign(this,{state,api,post,failure,browser,toast});this.data={collections:[],watches:[],tags:[]};this.photos=[];this.photoVersion=0;
    const $=id=>document.getElementById(id);
    for(const button of document.querySelectorAll('[data-close]'))button.onclick=()=>$(button.dataset.close).close();
    $('toggleSidebar').onclick=()=>{const open=document.body.classList.toggle('sidebar-open');$('toggleSidebar').setAttribute('aria-expanded',String(open))};
    $('newCollection').onclick=()=>this.newCollection();
    $('collectionKind').onchange=()=>{$('smartRules').hidden=$('collectionKind').value!=='smart'};
    $('collectionForm').onsubmit=event=>this.createCollection(event);
    $('saveOrganization').onclick=()=>this.saveDetails();
    $('addMembership').onclick=()=>this.addMembership();
    $('removeMembership').onclick=()=>this.removeMembership();
    $('newPrint').onclick=()=>{if(!this.state.meta)return;$('printForm').reset();this.photos=[];++this.photoVersion;$('printPhotoPreviews').replaceChildren();$('printError').textContent='';$('printDialog').showModal()};
    $('printPhotos').onchange=()=>this.readPhotos();
    $('printForm').onsubmit=event=>this.savePrint(event);
    $('batchOrganize').onclick=()=>{$('batchOrganizeForm').reset();this.collectionOptions($('batchCollection'));$('batchOrganizeError').textContent='';$('batchOrganizeDialog').showModal()};
    $('batchOrganizeForm').onsubmit=event=>this.batch(event);
    $('watchCurrent').onclick=()=>this.watch();
    $('chooseModelFolder').onclick=async()=>{
      if(!window.meshkeepDesktop){$('pathInput').focus();this.toast('Paste a folder path and choose Go.');return}
      try{const path=await window.meshkeepDesktop.chooseFolder();if(path){this.browser.collectionId='';await this.browser.navigate(path)}}catch(error){this.failure(error)}
    };
    $('sendToSlicer').onclick=event=>this.slicer([this.state.meta?.path].filter(Boolean),event.shiftKey);
    $('batchSlicer').onclick=()=>this.slicer([...this.state.selection]);
    $('findGeometry').onclick=()=>this.compareShapes();
    $('cancelGeometry').onclick=()=>this.shapeAbort?.abort();
    this.timer=setInterval(()=>this.poll(),15000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)this.poll()});
    window.addEventListener('beforeunload',()=>{clearInterval(this.timer);this.shapeAbort?.abort()});
  }
  el(id){return document.getElementById(id)}
  async refresh(){
    this.data=await this.api('/api/workspace');
    this.renderCollections();this.renderWatches();
    const filter=this.el('tagFilter'),selected=filter.value;
    filter.replaceChildren(new Option('All tags',''),...this.data.tags.map(t=>new Option(`${t.tag} (${t.count})`,t.tag)));
    filter.value=selected;
    this.collectionOptions(this.el('memberCollection'));
  }
  async poll(){
    if(document.hidden)return;
    try{
      const previous=JSON.stringify(this.data.watches.map(w=>[w.path,w.changed]));await this.refresh();
      if(previous!==JSON.stringify(this.data.watches.map(w=>[w.path,w.changed])))this.pendingRefresh=true;
      const editing=document.activeElement?.closest('.editor,dialog')||this.state.selection.size>1;
      if(this.pendingRefresh&&this.data.watches.some(w=>w.enabled)&&!this.shapeAbort&&!document.querySelector('dialog[open]')&&!editing){await this.browser.load(this.state.cwd);this.pendingRefresh=false}
    }catch(_){} // polling errors don't interrupt editing
  }
  renderCollections(){
    const list=this.el('collectionList');list.replaceChildren();
    const all=document.createElement('button');all.type='button';all.className='collection-row'+(!this.browser.collectionId?' selected':'');all.textContent='◈  All models in folder';all.onclick=()=>this.chooseCollection(null);list.append(all);
    for(const item of this.data.collections){
      const row=document.createElement('div');row.className='collection-item';
      const button=document.createElement('button');button.type='button';button.className='collection-row'+(String(item.id)===String(this.browser.collectionId)?' selected':'');button.textContent=(item.kind==='smart'?'✦  ':'▤  ')+item.name;button.title=item.root;button.onclick=()=>this.chooseCollection(item);
      const remove=document.createElement('button');remove.type='button';remove.className='remove-small';remove.textContent='×';remove.setAttribute('aria-label','Delete collection '+item.name);
      remove.onclick=async()=>{if(!confirm(`Delete “${item.name}”? Model files will stay in place.`))return;try{await this.post('/api/collection',{action:'delete',id:item.id});if(String(this.browser.collectionId)===String(item.id))await this.chooseCollection(null);await this.refresh()}catch(error){this.failure(error)}};
      row.append(button,remove);list.append(row);
    }
  }
  async chooseCollection(item){
    this.browser.collectionId=item?.id||'';this.browser.offset=0;
    for(const id of ['searchInput','tagFilter','statusFilter','formatFilter'])this.el(id).value='';
    this.el('duplicateFilter').checked=this.el('geometryFilter').checked=false;this.el('scopeSelect').value='library';
    await this.browser.load(item?.root||this.state.cwd);this.renderCollections();this.el('removeMembership').hidden=!item||item.kind!=='manual';
  }
  newCollection(){
    this.el('collectionForm').reset();this.el('smartRules').hidden=true;this.el('collectionError').textContent='';
    this.el('ruleSearch').value=this.el('searchInput').value;this.el('ruleTag').value=this.el('tagFilter').value;this.el('ruleStatus').value=this.el('statusFilter').value;this.el('ruleFormat').value=this.el('formatFilter').value;
    this.el('collectionDialog').showModal();
  }
  async createCollection(event){
    event.preventDefault();const kind=this.el('collectionKind').value;
    try{
      const item=await this.post('/api/collection',{name:this.el('collectionName').value,root:this.state.cwd,kind,rules:kind==='smart'?{search:this.el('ruleSearch').value,tag:this.el('ruleTag').value,status:this.el('ruleStatus').value,designer:this.el('ruleDesigner').value,ext:this.el('ruleFormat').value}:{}});
      this.el('collectionDialog').close();await this.refresh();
      if(kind==='manual'&&this.state.selection.size)await this.post('/api/collection',{action:'add',id:item.id,paths:[...this.state.selection]});
      await this.chooseCollection(item);this.toast('Collection created');
    }catch(error){this.el('collectionError').textContent=error.message}
  }
  collectionOptions(select){
    const value=select.value;select.replaceChildren(new Option('Choose a collection…',''),...this.data.collections.filter(c=>c.kind==='manual').map(c=>new Option(c.name,c.id)));select.value=value;
  }
  async addMembership(){
    if(!this.state.meta||!this.el('memberCollection').value)return;
    try{await this.post('/api/collection',{action:'add',id:Number(this.el('memberCollection').value),paths:[this.state.meta.path]});this.toast('Added to collection');await this.browser.load(this.state.cwd)}catch(error){this.failure(error)}
  }
  async removeMembership(){
    if(!this.state.meta||!this.browser.collectionId)return;
    try{await this.post('/api/collection',{action:'remove',id:this.browser.collectionId,paths:[this.state.meta.path]});await this.browser.load(this.state.cwd);this.toast('Removed from collection')}catch(error){this.failure(error)}
  }
  render(meta){
    const data=meta.organization||{tags:[],status:'unprinted',notes:'',prints:[]};
    this.el('modelTags').value=data.tags.join(', ');this.el('modelStatus').value=data.status;this.el('modelNotes').value=data.notes;
    const selected=this.data.collections.find(c=>String(c.id)===String(this.browser.collectionId));this.el('removeMembership').hidden=!selected||selected.kind!=='manual';
    this.renderHistory(data.prints);this.slicerStatus();
  }
  async reloadDetails(){
    if(!this.state.meta)return;
    const path=this.state.meta.path,data=await this.api('/api/organization?'+new URLSearchParams({path}));
    if(this.state.meta?.path===path){this.state.meta.organization=data;this.render(this.state.meta)}
  }
  async saveDetails(){
    if(!this.state.meta)return;this.el('saveOrganization').disabled=true;
    try{await this.post('/api/annotate',{path:this.state.meta.path,tags:this.el('modelTags').value.split(',').map(t=>t.trim()).filter(Boolean),status:this.el('modelStatus').value,notes:this.el('modelNotes').value});await this.refresh();await this.reloadDetails();await this.browser.load(this.state.cwd);this.toast('Library details saved')}catch(error){this.failure(error)}finally{this.el('saveOrganization').disabled=false}
  }
  renderHistory(entries){
    const list=this.el('printHistory');list.replaceChildren();
    if(!entries.length){const empty=document.createElement('p');empty.className='hint';empty.textContent='Your next print starts here. Log results, settings and photos.';list.append(empty)}
    for(const entry of entries){
      const card=document.createElement('article');card.className='print-entry';
      const title=document.createElement('strong');title.textContent=PRINT_LABELS[entry.outcome]+' · '+new Date(entry.created*1000).toLocaleDateString();card.append(title);
      for(const value of [[entry.printer,entry.material].filter(Boolean).join(' · '),entry.settings,entry.notes])if(value){const p=document.createElement('p');p.textContent=value;card.append(p)}
      const photos=document.createElement('div');photos.className='print-entry-photos';
      for(const id of entry.photos){const button=document.createElement('button');button.type='button';button.className='photo-thumbnail';const image=document.createElement('img');image.src='/api/printPhoto?'+new URLSearchParams({id,t:TOKEN});image.alt='Finished print';image.loading='lazy';button.setAttribute('aria-label','View finished print photo');button.onclick=()=>{this.el('fullPrintPhoto').src=image.src;this.el('photoDialog').showModal()};button.append(image);photos.append(button)}card.append(photos);
      const remove=document.createElement('button');remove.type='button';remove.className='ghost remove-small';remove.textContent='Delete record';remove.onclick=async()=>{if(!confirm('Delete this print record and its photos?'))return;try{await this.post('/api/print',{action:'delete',id:entry.id});await this.reloadDetails()}catch(error){this.failure(error)}};card.append(remove);list.append(card);
    }
  }
  async readPhotos(){
    const files=Array.from(this.el('printPhotos').files),version=++this.photoVersion;this.photos=[];this.el('printPhotoPreviews').replaceChildren();this.el('printError').textContent='';
    if(files.length>3){this.el('printError').textContent='Choose up to three photos.';return}
    this.el('savePrint').disabled=true;
    try{
      const images=[];
      for(const file of files){
        if(file.size>30*1024*1024)throw new Error('Photos must be smaller than 30 MB.');
        const image=await createImageBitmap(file),scale=Math.min(1,960/Math.max(image.width,image.height));
        const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);image.close();images.push(canvas.toDataURL('image/png'));
      }
      if(version!==this.photoVersion)return;this.photos=images;
      for(const src of images){const img=document.createElement('img');img.src=src;img.alt='Photo to attach';this.el('printPhotoPreviews').append(img)}
    }catch(error){if(version===this.photoVersion)this.el('printError').textContent=error.message}finally{if(version===this.photoVersion)this.el('savePrint').disabled=false}
  }
  async savePrint(event){
    event.preventDefault();this.el('savePrint').disabled=true;
    try{
      if(this.el('printPhotos').files.length!==this.photos.length)throw new Error('Wait for the photos to finish loading, or choose them again.');
      await this.post('/api/print',{path:this.state.meta.path,outcome:this.el('printOutcome').value,printer:this.el('printPrinter').value,material:this.el('printMaterial').value,settings:this.el('printSettings').value,notes:this.el('printNotes').value,photos:this.photos});
      this.el('printDialog').close();await this.reloadDetails();await this.browser.load(this.state.cwd);this.toast('Print record saved');
    }catch(error){this.el('printError').textContent=error.message}finally{this.el('savePrint').disabled=false}
  }
  async batch(event){
    event.preventDefault();try{
      const paths=[...this.state.selection],tags=this.el('batchTags').value.split(',').map(s=>s.trim()).filter(Boolean),status=this.el('batchStatus').value;
      if(tags.length||status)await this.post('/api/annotate',{paths,...(tags.length?{tags,addTags:true}:{}),...(status?{status}:{})});
      const id=this.el('batchCollection').value;if(id)await this.post('/api/collection',{action:'add',id:Number(id),paths});
      this.el('batchOrganizeDialog').close();await this.refresh();await this.reloadDetails();await this.browser.load(this.state.cwd);this.toast('Selected models updated');
    }catch(error){this.el('batchOrganizeError').textContent=error.message}
  }
  async watch(){
    try{await this.post('/api/watch',{path:this.state.cwd,enabled:true});await this.refresh();this.toast('Folder watched. Meshkeep checks for changes every 15 seconds.')}catch(error){this.failure(error)}
  }
  renderWatches(){
    const list=this.el('watchList');list.replaceChildren();
    if(!this.data.watches.length){const p=document.createElement('p');p.className='sidebar-empty';p.textContent='Watch a folder to keep new downloads in sync.';list.append(p)}
    for(const watch of this.data.watches){
      const row=document.createElement('div');row.className='watch-row';
      const toggle=document.createElement('input');toggle.type='checkbox';toggle.checked=!!watch.enabled;toggle.setAttribute('aria-label','Watch '+watch.path);toggle.onchange=async()=>{try{await this.post('/api/watch',{path:watch.path,enabled:toggle.checked});await this.refresh()}catch(error){this.failure(error)}};
      const button=document.createElement('button');button.type='button';button.textContent=watch.path.split(/[\\/]/).pop();button.title=watch.path+(watch.error?' · '+watch.error:watch.checked?' · Last checked '+new Date(watch.checked*1000).toLocaleTimeString():' · Waiting for first scan');button.className=watch.error?'watch-error':'';button.onclick=()=>{this.browser.collectionId='';this.el('scopeSelect').value='library';this.browser.navigate(watch.path)};
      const remove=document.createElement('button');remove.type='button';remove.className='remove-small';remove.textContent='×';remove.setAttribute('aria-label','Stop watching '+watch.path);remove.onclick=async()=>{try{await this.post('/api/watch',{path:watch.path,remove:true});await this.refresh()}catch(error){this.failure(error)}};
      row.append(toggle,button,remove);list.append(row);
    }
  }
  async slicerStatus(){
    this.el('slicerStatus').textContent=window.meshkeepDesktop?'Choose your slicer on first use.':'Send to slicer is available in the Meshkeep desktop app.';
    if(window.meshkeepDesktop)try{const result=await window.meshkeepDesktop.slicer();if(result.available)this.el('slicerStatus').textContent='Slicer: '+result.name+' · Shift-click Send to slicer to change'}catch(_){}
  }
  async slicer(paths,choose=false){
    if(!window.meshkeepDesktop){this.toast('Open the Meshkeep desktop app to send models to a slicer.');return}
    try{let target=await window.meshkeepDesktop.slicer();if(choose||!target.available)target=await window.meshkeepDesktop.chooseSlicer();if(target.canceled||!target.available)return;const result=await window.meshkeepDesktop.sendToSlicer(paths);this.toast(`${result.sent} model(s) sent to ${result.name}`);await this.slicerStatus()}catch(error){this.failure(error)}
  }
  async compareShapes(){
    if(this.shapeAbort)return;this.shapeAbort=new AbortController();const signal=this.shapeAbort.signal,root=this.state.cwd;
    this.el('findGeometry').disabled=true;this.el('cancelGeometry').hidden=false;let done=0,failed=0,after='';const failures=[];
    try{
      const {job}=await this.post('/api/scan',{path:root});if(!await follow(job))return;
      const {loadModel,dispose}=await import('/studio.js'),{analyze}=await import('/geometry.js');
      for(;;){
        if(signal.aborted)break;
        const batch=await this.api('/api/geometryCandidates?'+new URLSearchParams({path:root,after}));if(!batch.files.length)break;
        for(const file of batch.files){
          if(signal.aborted)break;after=file.path;let loaded;
          this.el('geometryProgress').textContent=`Comparing geometry · ${done} analysed · ${failed} skipped · ${file.name}`;
          try{loaded=await loadModel(file.path,signal);const analysis=await analyze(loaded.object,{fingerprint:true,signal});await this.post('/api/geometry',{path:file.path,stamp:loaded.stamp,...analysis});done++}
          catch(error){if(error.name==='AbortError')break;failed++;failures.push(file.name+': '+error.message)}
          finally{if(loaded)dispose(loaded.object)}
          await new Promise(resolve=>setTimeout(resolve,20));
        }
      }
      this.el('scopeSelect').value='library';this.el('geometryFilter').checked=true;this.browser.offset=0;await this.browser.load(root);
      this.el('geometryProgress').textContent=`${signal.aborted?'Comparison stopped':'Comparison complete'} · ${done} analysed · ${failed} skipped`;
      this.el('jobErrors').hidden=!failures.length;this.el('jobErrors').textContent=failures.slice(0,50).join('\n');
    }catch(error){if(error.name!=='AbortError')this.failure(error)}finally{this.shapeAbort=null;this.el('findGeometry').disabled=false;this.el('cancelGeometry').hidden=true}
  }
}
