/** Isolated local preview only. This module is never in the deployed Worker build. */
import { createServer } from 'node:http';
import { readFile,stat } from 'node:fs/promises';
import { resolve,extname } from 'node:path';
import { createRuntime, testAudience, testIssuer } from '../tests/runtime';

const app=await createRuntime({bindings:{APP_ENV:'production',CENTER_ID:'test-center',APP_VERSION:'local-preview',ACCESS_ISSUER:testIssuer,ACCESS_AUD:testAudience,BOOTSTRAP_OWNER_EMAIL:'owner@example.test'}});
const token=await app.signer.token();
const port=Number(process.env.CLOUDFLARE_LOCAL_PORT||8791);
const origin=`http://127.0.0.1:${port}`;
const assetRoot=resolve('dist/client');
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'};
const server=createServer(async(req,res)=>{
  try{
    if(req.headers.host!==`127.0.0.1:${port}`){res.writeHead(421);res.end();return;}
    const url=new URL(req.url||'/',origin);
    if(url.pathname.startsWith('/api/')){
      if(req.headers.origin&&req.headers.origin!==origin){res.writeHead(403);res.end();return;}
      const chunks:Buffer[]=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>1024*1024){res.writeHead(413);res.end();return;}chunks.push(chunk);}
      const headers=new Headers();for(const [key,value] of Object.entries(req.headers)){if(value&& !['host','cf-access-jwt-assertion','origin','content-length'].includes(key))headers.set(key,Array.isArray(value)?value.join(','):value);}
      if(url.pathname.startsWith('/api/admin/'))headers.set('Cf-Access-Jwt-Assertion',token);
      if(req.headers.origin)headers.set('origin','https://crm.example.test');
      const response=await app.runtime.dispatchFetch(`https://crm.example.test${url.pathname}${url.search}`,{method:req.method,headers:Object.fromEntries(headers),...(['GET','HEAD'].includes(req.method||'GET')?{}:{body:Buffer.concat(chunks)})});
      res.statusCode=response.status;for(const [key,value] of response.headers)if(key!=='set-cookie')res.setHeader(key,value);
      const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('set-cookie',cookies.map(c=>c.replace(/;\s*Secure/gi,'')));
      res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    if(url.pathname.startsWith('/__isolated')){res.writeHead(404);res.end();return;}
    let path=resolve(assetRoot,`.${decodeURIComponent(url.pathname)}`);if(!path.startsWith(`${assetRoot}/`))path=resolve(assetRoot,'index.html');
    try{if(!(await stat(path)).isFile())path=resolve(assetRoot,'index.html');}catch{path=resolve(assetRoot,'index.html');}
    res.setHeader('Content-Type',mime[extname(path)]||'application/octet-stream');res.setHeader('Cache-Control','no-store');res.end(await readFile(path));
  }catch{res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'LOCAL_PREVIEW_ERROR',message:'The isolated local preview could not complete this request.'}}));}
});
server.listen(port,'127.0.0.1',()=>console.log(`Isolated local Cloudflare preview: ${origin}/admin\nSigned synthetic Access identity; temporary empty D1. Not a live Cloudflare login. No Railway data is used.`));
async function stop(){server.close();await app.close();process.exit(0);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
