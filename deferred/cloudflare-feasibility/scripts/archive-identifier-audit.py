#!/usr/bin/env python3
"""Local synthetic gzip sensitivity: stable pseudorandom UUIDs, same lengths."""
import argparse, gzip, hashlib, json, pathlib, re, time, uuid
p=argparse.ArgumentParser();p.add_argument('measurement');args=p.parse_args()
root=pathlib.Path(args.measurement).resolve();report=json.loads((root/'report.json').read_text())
if not report.get('syntheticOnly'):raise SystemExit('Synthetic measurements only.')
pattern=re.compile(r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b',re.I)
identities={}
def replace(match):
 original=match.group(0)
 if original not in identities:identities[original]=str(uuid.UUID(bytes=hashlib.sha256(('synthetic-archive-entropy-v1:'+original).encode()).digest()[:16],version=4))
 return identities[original]
started=time.perf_counter();rows=[]
for archive in report['archives']:
 source=root/(archive['month']+'.jsonl.gz');target=root/(archive['month']+'.uuid-sensitivity.jsonl.gz');raw_bytes=0;row_count=0;digest=hashlib.sha256()
 with gzip.open(source,'rt',encoding='utf-8',newline='') as input, target.open('xb') as file:
  with gzip.GzipFile(filename='',fileobj=file,mode='wb',mtime=0,compresslevel=6) as output:
   for line in input:
    transformed=pattern.sub(replace,line).encode();assert len(transformed)==len(line.encode());json.loads(transformed);raw_bytes+=len(transformed);row_count+=1;digest.update(transformed);output.write(transformed)
 assert raw_bytes==archive['jsonlBytes']
 verified=hashlib.sha256();verified_rows=0
 with gzip.open(target,'rb') as input:
  for line in input:verified.update(line);json.loads(line);verified_rows+=1
 assert verified.hexdigest()==digest.hexdigest() and verified_rows==row_count
 rows.append({'month':archive['month'],'jsonlBytes':raw_bytes,'originalGzipBytes':archive['gzipBytes'],'uuidSensitivityGzipBytes':target.stat().st_size,'roundTripVerified':True})
result={'syntheticOnly':True,'measurement':str(root),'method':'Each UUID-shaped identifier replaced everywhere with same-length deterministic pseudorandom UUID; mapping stable across all records and months. Repeated notes and fixture distributions otherwise unchanged.','mappedIdentifiers':len(identities),'jsonlBytes':sum(r['jsonlBytes'] for r in rows),'originalGzipBytes':sum(r['originalGzipBytes'] for r in rows),'uuidSensitivityGzipBytes':sum(r['uuidSensitivityGzipBytes'] for r in rows),'localSeconds':time.perf_counter()-started,'archives':rows,'limitations':['This is an entropy sensitivity test, not a projection from customer data.','Source fixture payload_hash values are UUID strings, not actual 64-character SHA256 values.','Only gzip measured; encryption, retention copies, live operational use and historical latency excluded.']}
(root/'uuid-sensitivity.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ['archives','limitations']},indent=2))
