import { RepCounter } from './src/repCounter/RepCounter.ts';
import { shoulderPressConfig } from './src/config/exerciseConfigs.ts';

// minimal angle synth
function tripletFor(deg){const r=deg*Math.PI/180,bx=0.5,by=0.5,l=0.2;return{a:[bx,by-l],b:[bx,by],c:[bx+l*Math.sin(r),by-l*Math.cos(r)]};}
const JM={left_elbow:[11,13,15],right_elbow:[12,14,16],left_shoulder:[13,11,23],right_shoulder:[14,12,24]};
function frame(cfg,deg,id){const k=Array.from({length:33},(_,i)=>({index:i,x:.5,y:.5,z:0,confidence:0}));for(const j of cfg.joints){const idx=JM[j];if(!idx)continue;const {a,b,c}=tripletFor(deg);const[ai,bi,ci]=idx;k[ai]={index:ai,x:a[0],y:a[1],z:0,confidence:.9};k[bi]={index:bi,x:b[0],y:b[1],z:0,confidence:.9};k[ci]={index:ci,x:c[0],y:c[1],z:0,confidence:.9};}return{type:'keypoints',frameId:id,timestampMs:id*33,keypoints:k};}

const c=new RepCounter(shoulderPressConfig);
const cfg=shoulderPressConfig;
const sMid=(cfg.startThreshold.min+cfg.startThreshold.max)/2;
const iMid=(cfg.inflectionThreshold.min+cfg.inflectionThreshold.max)/2;
const cMid=(cfg.completeThreshold.min+cfg.completeThreshold.max)/2;
console.log('mids start/infl/comp:', sMid,iMid,cMid);
let id=1;
const hold=(deg,n)=>{for(let i=0;i<n;i++){c.update(frame(cfg,deg,id++));}console.log('after hold',deg,'state=',c.getState(),'reps=',c.getRepCount());};
hold(sMid,4); hold(iMid,4); hold(cMid,4); hold(sMid,4);
console.log('FINAL reps=',c.getRepCount());
