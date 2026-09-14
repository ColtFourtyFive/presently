import urllib.request,urllib.parse,concurrent.futures,re,pathlib,json,sys
from html.parser import HTMLParser
class Parser(HTMLParser):
 def __init__(self): super().__init__();self.text=[];self.links=[];self.skip=0
 def handle_starttag(self,t,attrs):
  d=dict(attrs)
  if t in ['script','style']:self.skip+=1
  if t=='a' and 'href' in d:self.links.append(d['href'])
 def handle_endtag(self,t):
  if t in ['script','style']:self.skip=max(0,self.skip-1)
 def handle_data(self,d):
  if not self.skip and d.strip():self.text.append(d.strip())
p=pathlib.Path('research/vendor_raw');p.mkdir(exist_ok=True)
def run(url):
 try:
  req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'})
  r=urllib.request.urlopen(req,timeout=35);raw=r.read().decode('utf-8','replace');s=Parser();s.feed(raw);txt='\n'.join(s.text);name=re.sub('[^a-zA-Z0-9.-]+','_',urllib.parse.urlparse(url).netloc.replace('www.','')+urllib.parse.urlparse(url).path).strip('_');(p/(name+'.txt')).write_text(txt);(p/(name+'.links.txt')).write_text('\n'.join(sorted(set(s.links)))); excerpts=[]
  for m in re.finditer(r'attendance|check.in|check.out|offline|export|retention|retain|back.up|\$[0-9]|API|security|encryption',txt,re.I):
   excerpt=txt[max(0,m.start()-100):m.end()+330]
   if excerpts and excerpt in excerpts[-1]:continue
   excerpts.append(excerpt)
  return {'url':url,'final':r.url,'file':str(p/(name+'.txt')),'excerpts':excerpts[:35],'links':[x for x in sorted(set(s.links)) if re.search('check|attend|pric|security|privacy',str(x),re.I)][:20]}
 except Exception as e:return {'url':url,'error':str(e)}
for out in concurrent.futures.ThreadPoolExecutor().map(run,sys.argv[1:]):print(json.dumps(out))
