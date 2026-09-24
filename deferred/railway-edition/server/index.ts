import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import { createDatabase } from './db.js';
import { initializeDatabase } from './seed.js';
import { createApp } from './app.js';

const db=await createDatabase();
await initializeDatabase(db);
const app=createApp({db});
if(process.env.NODE_ENV==='production') {
  const clientDir=path.resolve('dist/client');
  app.use(express.static(clientDir,{index:false,maxAge:'1h'}));
  app.get('/{*path}',(_req,res)=>res.sendFile(path.join(clientDir,'index.html')));
}else{
  const {createServer}=await import('vite');
  const vite=await createServer({server:{middlewareMode:true},appType:'spa'});
  app.use(vite.middlewares);
}
const port=Number(process.env.PORT||3000);
const host=process.env.HOST||(process.env.RAILWAY_ENVIRONMENT_ID?'0.0.0.0':'127.0.0.1');
const server=app.listen(port,host,()=>console.log(`Kumon CRM listening on ${host}:${port} (${db.kind})`));
let closing=false;
const shutdown=()=>{if(closing)return;closing=true;server.close(()=>void db.close().then(()=>process.exit(0)));setTimeout(()=>process.exit(1),10000).unref();};
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
