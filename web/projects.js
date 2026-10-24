'use strict';
class Projects {
  constructor(workspace) {
    this.workspace=workspace;
    const $=id=>document.getElementById(id);this.el=$;
    $('newProject').onclick=()=>{$('projectCreateForm').reset();$('projectCreateError').textContent='';$('projectSelectionHint').textContent=`${workspace.state.selection.size} selected model(s) will be added. You can add more later.`;$('projectCreateDialog').showModal()};
    $('projectCreateForm').onsubmit=async event=>{
      event.preventDefault();
      await this.run($('projectCreateError'),async()=>{
        const item=await workspace.post('/api/project',{name:$('newProjectName').value,root:workspace.state.cwd,paths:[...workspace.state.selection]});
        $('projectCreateDialog').close();this.show(item);await workspace.refresh();
      });
    };
    $('projectDetailsForm').onsubmit=event=>{event.preventDefault();this.change({action:'update',name:$('projectName').value,notes:$('projectNotes').value})};
    $('projectAddSelected').onclick=()=>this.change({action:'add',paths:[...workspace.state.selection]});
    $('projectDelete').onclick=()=>{
      if(confirm('Delete this project and its progress? Model files and print history will stay in place.'))this.change({action:'delete'});
    };
  }
  async run(error,fn){
    if(this.busy)return;
    this.busy=true;error.textContent='';
    try{await fn()}catch(e){error.textContent=e.message}finally{this.busy=false}
  }
  render(items){
    const list=this.el('projectList');list.replaceChildren();
    if(!items.length){const hint=document.createElement('p');hint.className='hint';hint.textContent='Group parts and track a complete build.';list.append(hint)}
    for(const item of items){
      const button=document.createElement('button');button.type='button';button.className='collection-row';button.textContent=`${item.name} · ${item.completed}/${item.required} printed`;
      button.onclick=async()=>{try{this.show(await this.workspace.api('/api/project?id='+item.id))}catch(e){this.workspace.failure(e)}};list.append(button);
    }
  }
  async change(body,error=this.el('projectError')){
    await this.run(error,async()=>{
      const item=await this.workspace.post('/api/project',{...body,id:this.current.id});
      if(body.action==='delete')this.el('projectDialog').close();else this.show(item);
      await this.workspace.refresh();
    });
  }
  show(item){
    this.current=item;this.el('projectTitle').textContent=item.name;
    this.el('projectName').value=item.name;this.el('projectNotes').value=item.notes;this.el('projectError').textContent='';
    const assembled=item.parts.filter(p=>p.status==='assembled').length;
    this.el('projectSummary').textContent=item.required?`${item.completed} of ${item.required} copies printed · ${assembled} of ${item.parts.length} parts assembled`:'No parts yet. Close this panel, select models, then reopen the project to add them.';
    const progress=this.el('projectProgress');progress.max=item.required||1;progress.value=item.completed;
    this.el('projectRoot').textContent='Models from '+item.root;
    this.el('projectAddSelected').disabled=!this.workspace.state.selection.size;
    this.el('projectAddSelected').textContent=`Add selected models (${this.workspace.state.selection.size})`;
    const list=this.el('projectParts');list.replaceChildren();
    for(const part of item.parts)list.append(this.partForm(part));
    if(!this.el('projectDialog').open)this.el('projectDialog').showModal();
  }
  partForm(part){
    const form=document.createElement('form');form.className='project-part';form.setAttribute('aria-label',part.name);
    const path=document.createElement('p');path.className=part.missing?'form-error':'hint';path.textContent=(part.missing?'Missing model — progress retained: ':'')+part.path;form.append(path);
    const fields={};
    const field=(key,title,type,value)=>{
      const label=document.createElement('label');label.textContent=title;
      const input=document.createElement(type==='textarea'?'textarea':type==='select'?'select':'input');
      if(input.tagName==='INPUT')input.type=type;
      input.name=key;input.value=value;label.append(input);form.append(label);fields[key]=input;return input;
    };
    field('name','Part name','text',part.name).maxLength=200;fields.name.required=true;
    for(const [key,title] of [['required','Copies needed'],['completed','Copies printed']]){
      const input=field(key,title,'number',part[key]);input.min=key==='required'?1:0;input.max=10000;input.step=1;input.required=true;
    }
    const status=field('status','Status','select','');
    for(const [value,label] of [['pending','To print'],['printing','Printing'],['retry','Needs another attempt'],['printed','Printed'],['assembled','Assembled']])status.add(new Option(label,value));
    status.value=part.status;
    status.onchange=()=>{if(['printed','assembled'].includes(status.value))fields.completed.value=fields.required.value};
    field('notes','Part notes','textarea',part.notes).maxLength=10000;
    const actions=document.createElement('div');actions.className='toolbar-row';
    const save=document.createElement('button');save.type='submit';save.textContent='Save part';save.className='primary';
    const remove=document.createElement('button');remove.type='button';remove.textContent='Remove part';
    const error=document.createElement('p');error.className='form-error';error.setAttribute('role','alert');
    remove.onclick=()=>{if(confirm(`Remove “${part.name}” and its project progress?`))this.change({action:'remove',part_id:part.id},error)};
    form.onsubmit=event=>{event.preventDefault();this.change({action:'part',part_id:part.id,...Object.fromEntries(Object.entries(fields).map(([key,input])=>[key,['required','completed'].includes(key)?Number(input.value):input.value]))},error)};
    actions.append(save,remove);form.append(actions,error);return form;
  }
}
