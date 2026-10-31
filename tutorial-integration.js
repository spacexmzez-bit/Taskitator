/* Tutorial entry points for the existing spotlight component. */
(() => {
  'use strict';
  const steps = {
    account: [
      {selector:'#pageViewHeading',title:'Today’s Focus',text:'This is where you can see the tasks you need to work on.'},
      {selector:'#openRootAddModalBtn',title:'Create a task',text:'Use this button to add a task, choose its date and add subtasks.'},
      {selector:'#openDrawerBtn',title:'Explore Taskitator',text:'Open the menu to find projects, the calendar, Universe and Settings.'},
      {selector:'#breakStatusPill',title:'Plan breaks',text:'Use this control to plan and view your daily breaks.'},
      {selector:'#syncStatusDot',title:'Sync',text:'Check sync status here. Your account keeps your workspace available across devices.'},
      {selector:'#openCopilotFabBtn',title:'Copilot',text:'Ask Copilot for help with your tasks after setting up an AI provider in Settings.'}
    ],
    pro: [
      {selector:'#pro-settings-container',title:'Taskitator Pro',text:'Your Pro status and available hosted credits appear here.'},
      {selector:'#pro-settings-container',title:'Review evidence together',text:'Batch review lets you submit shared evidence for multiple eligible tasks.'},
      {selector:'#pro-settings-container',title:'Study tools',text:'Pro adds study plans, Smart Study and consecutive subtask numbering.'},
      {selector:'#pro-settings-container',title:'Universe',text:'Create a Universe to organize shared work with other members.'}
    ]
  };
  const owner = () => window.TaskitatorAuth?.userId || '';
  function state(){try{return JSON.parse(localStorage.getItem('taskitator_settings')||'{}');}catch{return {};}}
  function done(key){return !!state().tutorial_progress?.[key];}
  function mark(key,result){const settings=state();settings.tutorial_progress={...(settings.tutorial_progress||{}),[key]:result};localStorage.setItem('taskitator_settings',JSON.stringify(settings));window.SyncEngine?.scheduleAutoPush();}
  function start(key,list=steps[key]){if(!owner()||!list||!window.TaskitatorSpotlight)return false; const expected=owner();return window.TaskitatorSpotlight.start({steps:list,onFinish:result=>{if(owner()===expected)mark(key,result);}});}
  function attempt(fn,n=0){if(fn()||n>=20)return;setTimeout(()=>attempt(fn,n+1),500);}
  function universe(g){const role=g.role, list=[
    {selector:'.uni-brand',title:'Your Universe',text:'This is your shared workspace. Your role determines the actions available to you.'},
    {selector:'.uni-tabs',title:'Move around',text:'Use these tabs for your dashboard, projects, statistics and settings.'},
    {selector:'#uni-pane-dashboard',title:'Your work',text:'Your dashboard shows work assigned to you and its review status.'},
    {selector:'.uni-sync',title:'Refresh',text:'Use this button to refresh the Universe.'}
  ];if(['owner','admin'].includes(role))list.push({selector:'.uni-tabs',title:'Manage work',text:'Use Controls to manage the people and labels available to your role.'});return list;}
  window.TaskitatorTutorials={start,openUniverse(g){if(!g?.id)return;const key='universe:'+g.id;const replay=document.createElement('button');replay.type='button';replay.className='icon-btn';replay.textContent='Replay Universe tutorial';replay.addEventListener('click',()=>start(key,universe(g)));document.querySelector('#uni-pane-settings')?.append(replay);if(!done(key))setTimeout(()=>attempt(()=>start(key,universe(g))),1000);},proActivated(){setTimeout(()=>attempt(()=>start('pro')),300);}};
  function init(){const account=document.getElementById('replayAccountTutorial'),pro=document.getElementById('replayProTutorial');if(account)account.onclick=()=>{sessionStorage.setItem('taskitator_tutorial_replay',owner());location.href='index.html';};if(pro)pro.onclick=()=>start('pro');
    const pending=sessionStorage.getItem('taskitator_new_tutorial');const replay=sessionStorage.getItem('taskitator_tutorial_replay');if(location.pathname.endsWith('index.html')||location.pathname.endsWith('/')){if(replay===owner()){sessionStorage.removeItem('taskitator_tutorial_replay');setTimeout(()=>attempt(()=>start('account')),500);}else if(pending===owner()&&!done('account')){setTimeout(()=>attempt(()=>{const ok=start('account');if(ok)sessionStorage.removeItem('taskitator_new_tutorial');return ok;}),500);}}
  }
  window.addEventListener('taskitator-auth-ready',init);
})();
