// Disposable browser fixture for menu geometry and real, synthetic screen RTP.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ContextMenu} from '../../src/components/ContextMenu.js';
import {MenuSubmenu} from '../../src/components/MenuSubmenu.js';
import {ScreenQualityController} from '../../src/lib/screenQualityController.js';
import {ScreenConnectionWarning} from '../../src/features/voice/VoicePresentation.js';
import {translate} from '../../src/lib/i18n.js';
import '../../src/styles.css';
import '../../src/visual-refresh.css';
function Fixture(){
  const [menu,setMenu]=useState(null),[selected,setSelected]=useState('');
  return <main style={{height:'100vh'}} onContextMenu={event=>{event.preventDefault();setMenu({key:'fixture',position:{x:event.clientX,y:event.clientY},trigger:null});}}>
    <button onClick={event=>setMenu({key:'fixture',position:{x:20,y:20},trigger:event.currentTarget})}>Open menu</button><output>{selected}</output>
    <button onClick={()=>document.documentElement.requestFullscreen()}>Fullscreen</button>
    <ScreenConnectionWarning t={(key,values)=>translate('en',key,values)}/>
    {menu?<ContextMenu descriptor={menu} label='Actions' onClose={()=>setMenu(null)}>
      <MenuSubmenu label='Move to' items={Array.from({length:30},(_,i)=>({id:String(i),label:`Voice room ${i+1}`}))} onSelect={id=>{setSelected(id);setMenu(null);}}/>
    </ContextMenu>:null}
  </main>;
}
window.screenBenchmark=async(seconds=60)=>{
  const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
  const ctx=canvas.getContext('2d');let frame=0;
  const paint=setInterval(()=>{
    frame++;ctx.fillStyle='#20282c';ctx.fillRect(0,0,1280,720);
    for(let i=0;i<40;i++){ctx.fillStyle=`hsl(${(i*47+frame*5)%360} 80% 55%)`;ctx.fillRect((i*79+frame*9)%1280,(i*41+frame*3)%720,80,50);}
    ctx.fillStyle='white';ctx.font='36px monospace';ctx.fillText('Screen quality: moving content and readable text',32,360);
  },33);
  const stream=canvas.captureStream(30),track=stream.getVideoTracks()[0];track.contentHint='motion';
  const peers=[],videos=[],controllers=[],results=[];
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
      if(mode==='adaptive'){const controller=new ScreenQualityController(sender,track,()=>senderPeer.connectionState!=='closed',senderPeer);controllers.push(controller);controller.start();}
      await senderPeer.setLocalDescription(await senderPeer.createOffer());await receiverPeer.setRemoteDescription(senderPeer.localDescription);
      await receiverPeer.setLocalDescription(await receiverPeer.createAnswer());await senderPeer.setRemoteDescription(receiverPeer.localDescription);
      results.push({mode,samples:[],sender,video,peer:senderPeer});
    }
    for(let second=0;second<seconds;second++){
      await new Promise(resolve=>setTimeout(resolve,1000));
      for(const result of results){
        const report=[];(await result.sender.getStats()).forEach(entry=>report.push(entry));
        const outbound=report.find(entry=>entry.type==='outbound-rtp'&&entry.kind==='video');
        const pair=report.find(entry=>entry.type==='candidate-pair'&&entry.nominated&&entry.state==='succeeded');
        result.samples.push({atMs:Math.round(performance.now()-start),receivedWidth:result.video.videoWidth,receivedHeight:result.video.videoHeight,sentWidth:outbound?.frameWidth,sentHeight:outbound?.frameHeight,fps:outbound?.framesPerSecond,bytesSent:outbound?.bytesSent,availableBitrate:pair?.availableOutgoingBitrate,limitation:outbound?.qualityLimitationReason,profile:result.sender.getParameters().encodings[0]?.scaleResolutionDownBy});
      }
    }
    return results.map(({mode,samples})=>({mode,samples,first720pMs:samples.find(sample=>sample.receivedHeight>=720)?.atMs??null}));
  } finally {clearInterval(paint);controllers.forEach(controller=>controller.dispose());track.stop();peers.forEach(peer=>peer.close());videos.forEach(video=>video.remove());}
};
createRoot(document.getElementById('root')).render(<Fixture/>);
