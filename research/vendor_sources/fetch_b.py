from urllib.request import Request,urlopen
from html.parser import HTMLParser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
class P(HTMLParser):
 def __init__(self): super().__init__(); self.parts=[]; self.links=[]; self.skip=0
 def handle_starttag(self,t,a):
  if t in ['script','style','noscript']: self.skip+=1
  if t=='a':
   for k,v in a:
    if k=='href': self.links.append(v)
 def handle_endtag(self,t):
  if t in ['script','style','noscript']: self.skip=max(0,self.skip-1)
 def handle_data(self,d):
  if not self.skip and d.strip(): self.parts.append(d.strip())
def go(x):
 name,url=x
 try:
  r=urlopen(Request(url,headers={'User-Agent':'Mozilla/5.0'}),timeout=40); h=r.read().decode('utf-8','replace'); p=P();p.feed(h)
  Path(f'research/vendor_sources/{name}.txt').write_text('URL: '+r.url+'\n\n'+'\n'.join(p.parts)+'\n\nLINKS\n'+'\n'.join(sorted(set(p.links))))
  return name,r.status,r.url,len(h)
 except Exception as e:return name,str(e)
if __name__=='__main__':
 targets=[
 ('playground_attendance','https://www.tryplayground.com/solutions/attendance'),
 ('playground_api','https://www.tryplayground.com/solutions/api'),
 ('famly_attendance','https://www.famly.co/us/platform/enrollment-attendance'),
 ('famly_pricing','https://www.famly.co/us/pricing'),
 ('famly_api','https://docs.famly.co/'),
 ('dailyconnect_attendance','https://en.dailyconnect.com/sign-in-attendance-tracking'),
 ('dailyconnect_pricing','https://en.dailyconnect.com/pricing'),
 ('jumbula_business','https://jumbula.com/jb-business-app/'),
 ('jumbula_pricing','https://jumbula.com/pricing/'),
 ('ezchildtrack_features','https://www.ezchildtrack.com/features.html'),
 ]
 with ThreadPoolExecutor(max_workers=6) as ex:
  for r in ex.map(go,targets):print(r)
