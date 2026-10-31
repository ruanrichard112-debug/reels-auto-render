import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { mkdir, rm, writeFile, readFile, stat } from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';

const app = express();
app.use(cors({origin:true}));
app.use(express.json({limit:'1mb'}));
const upload = multer({dest:path.join(os.tmpdir(),'reels-auto-uploads'), limits:{fileSize: 300*1024*1024}});
const jobs = new Map();
const outDir = path.join(os.tmpdir(),'reels-auto-output');
await mkdir(outDir,{recursive:true});
let running = false;
const queue = [];

function run(cmd,args){
  return new Promise((resolve,reject)=>{
    const p=spawn(cmd,args);
    let err='';
    p.stderr.on('data',d=>{err+=d.toString(); if(err.length>20000) err=err.slice(-20000)});
    p.on('error',reject);
    p.on('close',code=>code===0?resolve():reject(new Error(err||`ffmpeg exited ${code}`)));
  });
}

function profile(mode){
  if(mode==='quality') return {preset:'medium',crf:'19'};
  if(mode==='fast') return {preset:'veryfast',crf:'23'};
  if(mode==='turbo') return {preset:'ultrafast',crf:'27'};
  return {preset:'ultrafast',crf:'30'};
}

async function processJob(job){
  job.status='rendering'; job.progress=10;
  const {videoPath,overlayPath,outputPath,meta}=job;
  const W=Number(meta.canvasW||1080), H=Number(meta.canvasH||1920);
  const x=Number(meta.x||62), y=Number(meta.y||700), w=Number(meta.w||956), h=Number(meta.h||956);
  const fit=meta.fit||'auto';
  let prep='';
  if(fit==='contain') prep=`scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`;
  else {
    const ay=fit==='top'?'0':fit==='center'?'(ih-oh)/2':'(ih-oh)*0.22';
    prep=`scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(iw-ow)/2:${ay}`;
  }
  const p=profile(meta.mode);
  const filter=`[0:v]${prep},fps=30[vid];color=c=white:s=${W}x${H}:r=30[base];[base][vid]overlay=${x}:${y}:eof_action=pass[tmp];[tmp][1:v]overlay=0:0:format=auto[outv]`;
  const args=['-y','-i',videoPath,'-loop','1','-i',overlayPath,'-filter_complex',filter,'-map','[outv]','-map','0:a?','-c:v','libx264','-preset',p.preset,'-crf',p.crf,'-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart',outputPath];
  await run('ffmpeg',args);
  job.progress=100; job.status='done'; job.url=`/files/${path.basename(outputPath)}`;
  setTimeout(async()=>{
    jobs.delete(job.id);
    for(const pth of [videoPath,overlayPath,outputPath]) await rm(pth,{force:true}).catch(()=>{});
  },2*60*60*1000);
}

async function pump(){
  if(running) return; running=true;
  while(queue.length){
    const id=queue.shift(), job=jobs.get(id); if(!job) continue;
    try{ await processJob(job); }
    catch(e){ job.status='error'; job.error=(e?.message||String(e)).slice(-4000); }
  }
  running=false;
}

app.get('/health',(req,res)=>res.json({ok:true,queue:queue.length,running}));
app.post('/jobs', upload.fields([{name:'video',maxCount:1},{name:'overlay',maxCount:1}]), async (req,res)=>{
  try{
    const video=req.files?.video?.[0], overlay=req.files?.overlay?.[0];
    if(!video||!overlay) return res.status(400).json({error:'video e overlay são obrigatórios'});
    const id=randomUUID();
    const outputPath=path.join(outDir,`${id}.mp4`);
    const meta=req.body||{};
    const job={id,status:'queued',progress:0,videoPath:video.path,overlayPath:overlay.path,outputPath,meta,error:null,url:null};
    jobs.set(id,job); queue.push(id); pump();
    res.status(202).json({id,status:'queued'});
  }catch(e){res.status(500).json({error:e.message||String(e)})}
});
app.get('/jobs/:id',(req,res)=>{
  const j=jobs.get(req.params.id); if(!j) return res.status(404).json({error:'job não encontrado'});
  res.json({id:j.id,status:j.status,progress:j.progress,url:j.url,error:j.error});
});
app.get('/files/:name',async(req,res)=>{
  const safe=path.basename(req.params.name); const p=path.join(outDir,safe);
  try{await stat(p); res.setHeader('Content-Type','video/mp4'); res.setHeader('Content-Disposition',`attachment; filename="${safe}"`); createReadStream(p).pipe(res)}catch{res.status(404).json({error:'arquivo não encontrado'})}
});
const port=process.env.PORT||10000;
app.listen(port,()=>console.log(`render server listening on ${port}`));
