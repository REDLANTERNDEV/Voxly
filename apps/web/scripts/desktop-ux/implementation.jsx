// Disposable state and media only; these fixtures never use a real capture or Account.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {VoiceRoomScreen} from '../../src/features/voice/VoiceRoomScreen.js';
import {InviteScreen} from '../../src/features/auth/InviteScreen.js';
import {OwnerClaimScreen,AccessClaimScreen} from '../../src/features/auth/ClaimScreens.js';
import {LinkDeviceScreen} from '../../src/features/auth/LinkDeviceScreen.js';
import {RecoverScreen} from '../../src/features/auth/RecoverScreen.js';
import {DesktopBrowserApproval} from '../../src/features/auth/DesktopBrowserSignIn.js';
import {createInitialVoiceControls} from '../../src/lib/voiceControls.js';
import {translate} from '../../src/lib/i18n.js';
import '../../src/styles.css';
import '../../src/visual-refresh.css';
const params=new URLSearchParams(location.search);
const user={id:'self',nickname:'Mira',role:'member',bannedAt:null};
const room={id:'voice',serverId:'fixture',kind:'voice',categoryId:null,name:'Lobby',isAfk:false,position:0};
const member={user:{userId:'publisher',nickname:'Alex',role:'member'},media:{mic:true,camera:false,screen:true,speaking:true,deafened:false},moderation:{muted:false,deafened:false},mediaInstanceId:'publisher'};
window.fetch=async(input,options)=>{
  if(params.get('state')==='loading')return new Promise(()=>{});
  const path=String(input);
  let result={error:'invalid_token'},status=400;
  if(path.includes('/preview')){result={serverName:'Community',expiresAt:null,remainingUses:5};status=200;}
  if(path.includes('/desktop-authorizations')){result={confirmation:'482917',label:'Voxly desktop',origin:'https://chat.example.com',expiresAt:new Date(Date.now()+90000).toISOString(),status:'pending'};status=200;}
  return new Response(JSON.stringify(result),{status,headers:{'content-type':'application/json'}});
};
function Check(){
  const [language,setLanguage]=useState(params.get('lang')==='tr'?'tr':'en');
  const [joined,setJoined]=useState(false),[targets,setTargets]=useState([]),[pending,setPending]=useState(null),[live,setLive]=useState(true);
  const [stream]=useState(()=>{
    const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
    const paint=canvas.getContext('2d');paint.fillStyle='#25292e';paint.fillRect(0,0,1280,720);paint.fillStyle='#e5e7eb';paint.font='48px sans-serif';paint.fillText('Disposable screen source',80,360);
    const media=canvas.captureStream(1);const audio=new AudioContext();const destination=audio.createMediaStreamDestination();destination.stream.getAudioTracks().forEach(track=>media.addTrack(track));return media;
  });
  const t=(key,values)=>translate(language,key,values);
  const entry={language,t,onLanguageChange:setLanguage,turnstileSiteKey:null};
  const screen=params.get('screen')??'voice';
  if(screen==='invite')return <InviteScreen {...entry} initialToken='fixture-token-without-any-authority' existingUser={false} currentUser={null} timeFormat='auto' onAccepted={()=>{}}/>;
  if(screen==='owner-claim')return <OwnerClaimScreen {...entry} token={params.get('state')==='loading'?'fixture':''} onClaimed={()=>{}}/>;
  if(screen==='access-claim')return <AccessClaimScreen {...entry} token={params.get('state')==='loading'?'fixture':''} onClaimed={()=>{}} onNavigate={()=>{}}/>;
  if(screen==='link')return <LinkDeviceScreen {...entry} onLinked={()=>{}}/>;
  if(screen==='recover')return <RecoverScreen {...entry} onRecovered={()=>{}}/>;
  if(screen==='approval')return <DesktopBrowserApproval {...entry} id='12345678-1234-1234-1234-123456789abc' user={user} authState='ready'/>;
  const members=[{...member,media:{...member.media,screen:live}},...(joined?[{...member,user:{userId:'self',nickname:'Mira',role:'member'},media:{...member.media,screen:false,speaking:false}}]:[])];
  return <div style={{height:'100dvh',display:'grid',gridTemplateRows:'auto 1fr'}}><div style={{padding:12,display:'flex',gap:12}}><button className='btn' onClick={()=>setLive(false)}>End source</button><button className='btn' onClick={()=>{setJoined(false);setTargets([]);setPending(null);}}>Leave room</button><output>{joined?'Joined':'Outside'} · subscriptions: {targets.length}</output></div><VoiceRoomScreen user={user} currentNickname='Mira' currentRoom={room} route={{name:'voice',roomId:room.id,serverId:room.serverId}} activeServerId={room.serverId} rooms={{text:[],voice:[room]}} socketState='live' activeVoiceRoomId={joined?room.id:null} controls={createInitialVoiceControls()} visualTargets={targets} voiceSnapshots={{voice:{roomId:room.id,viewerInVoiceRoom:joined,members}}} musicQueues={{}} remoteStreams={joined&&live?[{userId:'publisher',kind:'screen',stream}]:[]} peerConnectionStates={{publisher:'connected'}} localPreviews={[]} memberVolumes={{}} screenVolumes={{}} roomHistory={{}} pendingLiveWatch={pending} audioLevels={{input:100,output:100}} t={t} onNavigate={()=>{}} onJoinVoice={async()=>{if(params.has('failJoin'))return false;setJoined(true);return true;}} onWatchLive={setPending} onLiveWatchHandled={()=>setPending(null)} onRequestVoiceSnapshot={()=>{}} onSetVisualSubscriptions={async next=>{setTargets(next);return {ok:true,targets:next};}} onMemberVolumeChange={()=>{}} onScreenVolumeChange={()=>{}} onMusicControl={async()=>({ok:false,error:'no_music_bot'})}/></div>;
}
document.documentElement.dataset.theme=params.get('theme')??'dark';
createRoot(document.getElementById('root')).render(<Check/>);
