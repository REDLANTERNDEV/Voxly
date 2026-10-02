// Disposable UI fixtures. No real accounts, credentials, sessions, or native authority.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {TextRoomScreen} from '../../src/features/chat/TextRoomScreen.js';
import {WorkspaceRail} from '../../src/components/shell/WorkspaceRail.js';
import {SettingsDialog} from '../../src/components/shell/SettingsDialog.js';
import {LanguageSwitch} from '../../src/components/ui/Primitives.js';
import {OpenInDesktop} from '../../src/components/OpenInDesktop.js';
import {DesktopBrowserSignIn} from '../../src/features/auth/DesktopBrowserSignIn.js';
import {LandingPage} from '../../src/features/auth/AuthScreens.js';
import {translate} from '../../src/lib/i18n.js';
import '../../src/styles.css';
import '../../src/visual-refresh.css';
const desktop=!location.search.includes('browser');
// Windows reaches Arial in the shared font stack; exercise it on other hosts too.
if(location.search.includes('windows')){
  document.documentElement.style.setProperty('--font-body', 'Arial, sans-serif');
  document.documentElement.style.setProperty('--font-display', 'Arial, sans-serif');
}
const snapshot={preferences:{installations:[],defaultInstallationId:null,openOnStartup:false,muteShortcut:'Control+Shift+KeyM',deafenShortcut:'Control+Shift+KeyD',pushToTalkShortcut:null,pushToMuteShortcut:null,microphoneMode:'openMic',pushToTalkReleaseDelayMs:0},registeredMuteShortcut:'Control+Shift+KeyM',registeredDeafenShortcut:'Control+Shift+KeyD',registeredPushToTalkShortcut:null,registeredPushToMuteShortcut:null};
window.desktopOperations=[];
if(desktop){window.__VOXLY_DESKTOP_V1__={version:1};window.__VOXLY_DESKTOP_SETTINGS_V1__={version:1,async apply(o){if(o.kind==='resetShortcut'){o={kind:'shortcut',action:o.action,binding:({mute:'Control+Shift+KeyM',deafen:'Control+Shift+KeyD'})[o.action]??null};}if(o.kind==='shortcut'){snapshot.preferences[o.action+'Shortcut']=o.binding;snapshot['registered'+o.action[0].toUpperCase()+o.action.slice(1)+'Shortcut']=o.binding;}if(o.kind==='microphone')snapshot.preferences.microphoneMode=o.mode;if(o.kind==='delay')snapshot.preferences.pushToTalkReleaseDelayMs=o.milliseconds;window.desktopOperations.push(o);const log=document.getElementById("desktop-operation-log");if(log)log.textContent=JSON.stringify(window.desktopOperations);return structuredClone(snapshot);}};}
const id='12345678-1234-1234-1234-123456789abc';
window.fetch=async(input,options)=>{const path=String(input);let result={};
if(path.endsWith('/api/devices'))result={devices:[]};
if(path.includes('/recovery'))result={present:true};
if(path.includes('/deletion'))result={request:null};
if(path.endsWith('/desktop-launches')&&options?.method==='POST')result={id,account:'Mira'};
if(path.includes('/desktop-launches/')&&!path.endsWith('/cancel'))result={authorizationId:id};
if(path.endsWith('/desktop-authorizations')&&options?.method==='POST')result={id,secret:'disposable-fixture',confirmation:'482917',expiresInSeconds:90};
if(path.includes('/desktop-authorizations/')&&!path.endsWith('/decision')&&!path.endsWith('/cancel'))result={confirmation:'482917',label:'Voxly desktop',origin:'https://chat.example.com',expiresAt:new Date(Date.now()+90000).toISOString(),status:'pending'};
return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});};
function Qa(){const [language,setLanguage]=useState(location.search.includes('tr')?'tr':'en');const [section,setSection]=useState(null);const [sounds,setSounds]=useState({enabled:true,volume:70,voice:true,message:true,connection:true});const t=(key,values)=>translate(language,key,values);
const model={t,language,theme:'dark',timeFormat:'auto',user:{id:'fixture',role:'member',nickname:'Mira'},audioDevices:{inputs:[],outputs:[],selectedInputId:'',selectedOutputId:'',loading:false,error:'',errorOccurrences:0,errorRevision:0,unavailableSelections:[],outputSelectionSupported:true,refresh:async()=>{},selectInput:()=>{},selectOutput:async()=>{}},audioLevels:{input:100,output:100},noiseSuppression:true,noiseSuppressionSupported:true,notificationSounds:sounds,microphoneTestActive:false,microphoneTestError:'',microphoneTestErrorOccurrences:0,microphoneTestErrorRevision:0,onCloseAudioSettings:()=>{},onInputVolumeChange:()=>{},onOutputVolumeChange:()=>{},onNoiseSuppressionChange:()=>{},onNotificationSoundsChange:p=>setSounds(s=>({...s,...p})),onToggleMicrophoneTest:async()=>{},onLanguageChange:setLanguage,onThemeChange:()=>{},onTimeFormatChange:()=>{},externalPreviews:{youtube:true,twitter:true,vimeo:true,spotify:true},onExternalPreviewChange:()=>{}};
if(location.search.includes('landing'))return <LandingPage language={language} analytics={null} t={t} onLanguageChange={setLanguage} onNavigate={()=>{}}/>;
if(location.search.includes('chat'))return <div style={{height:'100dvh'}}><TextRoomScreen {...model} currentRoom={{id:'fixture-room',name:'general'}} rooms={{text:[],voice:[]}} roomHistory={{}} activeServerId='fixture-server' messages={[]} outbox={[]} onNavigate={()=>{}} onSendMessage={()=>{}} onRetrySend={()=>{}} onDiscardSend={()=>{}} onUpdateMessage={async()=>{}} onDeleteMessage={async()=>{}} onSuppressEmbed={async()=>{}} /></div>;
return <div style={{padding:24}}><details><summary>Fixture operation log</summary><output id="desktop-operation-log">[]</output></details><WorkspaceRail t={t} activeServerId="fixture-server" servers={[{id:"fixture-server",name:"Community"}]} rooms={{text:[],voice:[]}} roomHistory={{}} onNavigate={()=>{}} onSelectServer={async()=>{}} onOpenSettings={()=>setSection("account")} onCloseDrawer={()=>{}}/><LanguageSwitch language={language} t={t} onLanguageChange={setLanguage}/><div style={{display:'flex',gap:16,marginTop:20}}>{['account','shortcuts','audio','notifications'].map(key=><button key={key} className="btn" onClick={()=>setSection(key)}>{key}</button>)}<OpenInDesktop t={t} authenticated/></div>{location.search.includes('signin')?<DesktopBrowserSignIn t={t} onLinked={()=>{}}/>:null}{location.search.includes('composer')?<div style={{height:420,marginTop:20}}><TextRoomScreen {...model} currentRoom={{id:'fixture-room',name:'general'}} rooms={{text:[],voice:[]}} roomHistory={{}} activeServerId='fixture-server' messages={[]} outbox={[]} onNavigate={()=>{}} onSendMessage={()=>{}} onRetrySend={()=>{}} onDiscardSend={()=>{}} onUpdateMessage={async()=>{}} onDeleteMessage={async()=>{}} onSuppressEmbed={async()=>{}} /></div>:null}{section?<SettingsDialog key={section} {...model} initialSection={section} onClose={()=>setSection(null)}/>:null}</div>;}
document.documentElement.dataset.theme=location.search.includes('light')?'light':'dark';createRoot(document.getElementById('root')).render(<Qa/>);
