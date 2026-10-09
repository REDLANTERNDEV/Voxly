// Disposable browser fixture for menu geometry and real, synthetic screen RTP.
import React,{useState,useEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {ContextMenu} from '../../src/components/ContextMenu.js';
import {MenuSubmenu} from '../../src/components/MenuSubmenu.js';
import {configureScreenTrack} from '../../src/lib/voiceMedia.js';
import {ScreenQualityController} from '../../src/lib/screenQualityController.js';
import {ScreenConnectionWarning,RecoveringScreenVideo} from '../../src/features/voice/VoicePresentation.js';
import {ScreenRecoveryOwner} from '../../src/lib/screenRecovery.js';
import {translate} from '../../src/lib/i18n.js';
import '../../src/styles.css';
import '../../src/visual-refresh.css';
function RecoveryFixture() {
  const [stream,setStream]=useState(null),[status,setStatus]=useState('connecting'),[selected,setSelected]=useState(false),[language,setLanguage]=useState('en');
  const now=useRef(0),owner=useRef(null),current=useRef(null),paint=useRef(null);
  useEffect(()=>{
    owner.current=new ScreenRecoveryOwner(async()=>{},states=>setStatus(states.fixture??'connecting'),()=>now.current);
    window.screenRecoveryFixture={
      start(color='#ff0000') {
        const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
        const ctx=canvas.getContext('2d');const draw=()=>{ctx.fillStyle=color;ctx.fillRect(0,0,1280,720);};draw();
        clearInterval(paint.current);paint.current=setInterval(draw,33);
        const next=canvas.captureStream(30);current.current=next;
        owner.current.sync([{publisherId:'fixture',peer:{},receiver:{track:next.getVideoTracks()[0],getStats:async()=>new Map()}}]);
        setSelected(true);setStream(next);
      },
      disconnect() { current.current?.getTracks().forEach(track=>track.stop());setStream(null);owner.current.sync([{publisherId:'fixture',peer:{},receiver:null}]); },
      async tick(time) { now.current=time;await owner.current.sample(); },
      unwatch() { owner.current.sync([]);setSelected(false);setStream(null);current.current?.getTracks().forEach(track=>track.stop());clearInterval(paint.current); },
      language(value) { setLanguage(value); },
      status() { return owner.current.status('fixture'); }
    };
    return()=>{owner.current.dispose();current.current?.getTracks().forEach(track=>track.stop());clearInterval(paint.current);delete window.screenRecoveryFixture;};
  },[]);
  return <div id="recovery-fixture" style={{position:'relative',width:640,height:360,background:'#111'}}>
    {selected?<RecoveringScreenVideo stream={stream} connectionStatus={status} onPlaybackReady={track=>owner.current.notePlayback('fixture',track)} t={key=>translate(language,key)}/>:null}
  </div>;
}
function Fixture(){
  const [menu,setMenu]=useState(null),[selected,setSelected]=useState('');
  return <main style={{height:'100vh'}} onContextMenu={event=>{event.preventDefault();setMenu({key:'fixture',position:{x:event.clientX,y:event.clientY},trigger:null});}}>
    <button onClick={event=>setMenu({key:'fixture',position:{x:20,y:20},trigger:event.currentTarget})}>Open menu</button><output>{selected}</output>
    <button onClick={()=>document.documentElement.requestFullscreen()}>Fullscreen</button>
    <React.StrictMode><RecoveryFixture/></React.StrictMode>
    <ScreenConnectionWarning t={(key,values)=>translate('en',key,values)}/>
    {menu?<ContextMenu descriptor={menu} label='Actions' onClose={()=>setMenu(null)}>
      <MenuSubmenu label='Move to' items={Array.from({length:30},(_,i)=>({id:String(i),label:`Voice room ${i+1}`}))} onSelect={id=>{setSelected(id);setMenu(null);}}/>
    </ContextMenu>:null}
  </main>;
}
window.screenBenchmark=async(seconds=60, lateViewer=false, controlledCongestion=false)=>{
  const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
  const ctx=canvas.getContext('2d');let frame=0;
  const paint=setInterval(()=>{
    frame++;ctx.fillStyle='#20282c';ctx.fillRect(0,0,1280,720);
    for(let i=0;i<40;i++){ctx.fillStyle=`hsl(${(i*47+frame*5)%360} 80% 55%)`;ctx.fillRect((i*79+frame*9)%1280,(i*41+frame*3)%720,80,50);}
    ctx.fillStyle='white';ctx.font='36px monospace';ctx.fillText('Screen quality: moving content and readable text',32,360);
  },33);
  const stream=canvas.captureStream(30),track=stream.getVideoTracks()[0];configureScreenTrack(track);
  const peers=[],videos=[],controllers=[],results=[];
  if(lateViewer)await new Promise(resolve=>setTimeout(resolve,3000));
  const start=performance.now();
  try {
    for(const mode of ['native','adaptive']){
      const senderPeer=new RTCPeerConnection(),receiverPeer=new RTCPeerConnection();peers.push(senderPeer,receiverPeer);
      senderPeer.onicecandidate=event=>{if(event.candidate)void receiverPeer.addIceCandidate(event.candidate);};
      receiverPeer.onicecandidate=event=>{if(event.candidate)void senderPeer.addIceCandidate(event.candidate);};
      const video=document.createElement('video');video.muted=true;video.autoplay=true;document.body.append(video);videos.push(video);
      receiverPeer.ontrack=event=>{video.srcObject=new MediaStream([event.track]);void video.play();};
      const sender=senderPeer.addTrack(track,stream);
      const params=sender.getParameters();params.degradationPreference='maintain-framerate';if(params.encodings.length)await sender.setParameters(params);
      // Synthetic reports exercise profile transitions; this does not emulate Wi-Fi packets.
      if(mode==='adaptive'&&controlledCongestion){
        const nativeStats=sender.getStats.bind(sender),created=performance.now();
        sender.getStats=async()=>{
          const report=await nativeStats(),entries=new Map();const congested=performance.now()-created<6000;
          report.forEach(entry=>entries.set(entry.id,{...entry}));
          for(const entry of entries.values()){
            if(entry.type==='outbound-rtp'&&entry.kind==='video'){entry.remoteId='fixture-remote';entry.qualityLimitationReason='none';}
            if(entry.type==='candidate-pair'){entry.availableOutgoingBitrate=congested?400000:4000000;entry.currentRoundTripTime=.05;}
          }
          entries.set('fixture-remote',{id:'fixture-remote',type:'remote-inbound-rtp',fractionLost:congested?.2:0,roundTripTime:.05});
          return entries;
        };
      }
      if(mode==='adaptive'){const controller=new ScreenQualityController(sender,track,()=>senderPeer.connectionState!=='closed',senderPeer);controllers.push(controller);controller.start();}
      await senderPeer.setLocalDescription(await senderPeer.createOffer());await receiverPeer.setRemoteDescription(senderPeer.localDescription);
      await receiverPeer.setLocalDescription(await receiverPeer.createAnswer());await senderPeer.setRemoteDescription(receiverPeer.localDescription);
      results.push({mode,samples:[],sender,video,peer:senderPeer,receiverPeer});
    }
    for(let second=0;second<seconds;second++){
      await new Promise(resolve=>setTimeout(resolve,1000));
      for(const result of results){
        const report=[];(await result.sender.getStats()).forEach(entry=>report.push(entry));
        const outbound=report.find(entry=>entry.type==='outbound-rtp'&&entry.kind==='video');
        const pair=report.find(entry=>entry.type==='candidate-pair'&&entry.nominated&&entry.state==='succeeded');
        let decodedFrames=0;(await result.receiverPeer.getStats()).forEach(entry=>{if(entry.type==='inbound-rtp'&&entry.kind==='video')decodedFrames=entry.framesDecoded??0;});
        result.samples.push({decodedFrames,atMs:Math.round(performance.now()-start),receivedWidth:result.video.videoWidth,receivedHeight:result.video.videoHeight,sentWidth:outbound?.frameWidth,sentHeight:outbound?.frameHeight,fps:outbound?.framesPerSecond,bytesSent:outbound?.bytesSent,availableBitrate:pair?.availableOutgoingBitrate,limitation:outbound?.qualityLimitationReason,profile:result.sender.getParameters().encodings[0]?.scaleResolutionDownBy});
      }
    }
    return results.map(({mode,samples})=>({mode,samples,first720pMs:samples.find(sample=>sample.receivedHeight>=720)?.atMs??null}));
  } finally {clearInterval(paint);controllers.forEach(controller=>controller.dispose());track.stop();peers.forEach(peer=>peer.close());videos.forEach(video=>video.remove());}
};
createRoot(document.getElementById('root')).render(<Fixture/>);
