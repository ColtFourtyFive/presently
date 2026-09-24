const encoder = new TextEncoder();

export function parseCsv(csv:string):{headers:string[];rows:string[][]}{
  if(encoder.encode(csv).length>512*1024)throw new Error('CSV must be no larger than 512 KB.');
  csv=csv.replace(/^\uFEFF/,'');if(csv.includes('\u0000'))throw new Error('CSV contains unsupported NUL characters.');
  const rows:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
  const pushCell=()=>{if(cell.length>2000)throw new Error('A CSV field exceeds 2,000 characters.');row.push(cell);cell='';closed=false;if(row.length>40)throw new Error('CSV supports at most 40 columns.');};
  const pushRow=()=>{pushCell();if(row.some(v=>v.trim()))rows.push(row);row=[];if(rows.length>501)throw new Error('Import at most 500 rows per file.');};
  for(let i=0;i<csv.length;i++){
    const ch=csv[i];if(quoted){if(ch==='"'){if(csv[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=ch;continue;}
    if(ch==='"'){if(cell||closed)throw new Error('Malformed CSV quoting.');quoted=true;}
    else if(ch===',')pushCell();else if(ch==='\n'||ch==='\r'){if(ch==='\r'&&csv[i+1]==='\n')i++;pushRow();}
    else {if(closed)throw new Error('Unexpected text after a quoted CSV field.');cell+=ch;}
  }
  if(quoted)throw new Error('CSV has an unclosed quoted field.');if(cell||row.length||closed)pushRow();
  const headers=rows.shift()?.map(h=>h.trim())||[];if(!headers.length||!rows.length)throw new Error('CSV needs a header and at least one data row.');
  if(headers.some(h=>!h)||new Set(headers.map(h=>h.toLowerCase())).size!==headers.length)throw new Error('CSV headers must be nonempty and unique.');
  if(rows.some(r=>r.length!==headers.length))throw new Error('Each CSV row must have the same number of columns as the header.');return {headers,rows};
}
