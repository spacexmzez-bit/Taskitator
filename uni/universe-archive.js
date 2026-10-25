// Deliberately supports only this app's flat, uncompressed ZIP format.
// No decompression means archive expansion, nesting and path traversal are rejected.
(() => {
 const LIMIT=100*1048576,utf=new TextEncoder();
 const crc=b=>{let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=c&1?(c>>>1)^0xedb88320:c>>>1;}return (c^0xffffffff)>>>0;};
 const safe=n=>/^[A-Za-z0-9_-]{1,100}\.bin$/.test(n);
 function zip(files){let offset=0;const parts=[],central=[];
  for(const [name,data]of files){if(!safe(name))throw Error('Invalid archive filename.');const n=utf.encode(name),h=new Uint8Array(30+n.length),v=new DataView(h.buffer),c=crc(data);v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint32(14,c,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,n.length,true);h.set(n,30);parts.push(h,data);
   const dir=new Uint8Array(46+n.length),d=new DataView(dir.buffer);d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint32(16,c,true);d.setUint32(20,data.length,true);d.setUint32(24,data.length,true);d.setUint16(28,n.length,true);d.setUint32(42,offset,true);dir.set(n,46);central.push(dir);offset+=h.length+data.length;
  }const size=central.reduce((n,b)=>n+b.length,0),end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,files.size,true);v.setUint16(10,files.size,true);v.setUint32(12,size,true);v.setUint32(16,offset,true);return new Blob([...parts,...central,end],{type:'application/zip'});
 }
 function unzip(bytes){if(bytes.length>LIMIT+1048576||bytes.length<22)throw Error('Archive is too large or incomplete.');const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),end=bytes.length-22;
  if(v.getUint32(end,true)!==0x06054b50||v.getUint16(end+4,true)||v.getUint16(end+6,true)||v.getUint16(end+20,true))throw Error('Unsupported ZIP format. Use the ZIP exported by Taskitator.');
  const count=v.getUint16(end+10,true),size=v.getUint32(end+12,true),start=v.getUint32(end+16,true);if(count>1000||v.getUint16(end+8,true)!==count||start+size!==end)throw Error('Invalid archive directory.');
  let at=start,total=0,last=0;const out=new Map();for(let i=0;i<count;i++){
   if(at+46>end||v.getUint32(at,true)!==0x02014b50)throw Error('Invalid ZIP entry.');const len=v.getUint16(at+28,true),extra=v.getUint16(at+30,true),comment=v.getUint16(at+32,true),n=new TextDecoder('utf-8',{fatal:true}).decode(bytes.slice(at+46,at+46+len)),offset=v.getUint32(at+42,true),compressed=v.getUint32(at+20,true),plain=v.getUint32(at+24,true),checksum=v.getUint32(at+16,true);
   if(!safe(n)||out.has(n)||extra||comment||v.getUint16(at+8,true)||v.getUint16(at+10,true)||compressed!==plain||plain>5*1048576||offset!==last||offset+30+len+plain>start)throw Error('Unsafe, compressed, nested or duplicate archive entry.');
   if(v.getUint32(offset,true)!==0x04034b50||v.getUint16(offset+6,true)||v.getUint16(offset+8,true)||v.getUint16(offset+26,true)!==len||v.getUint16(offset+28,true)||v.getUint32(offset+18,true)!==plain||v.getUint32(offset+22,true)!==plain||v.getUint32(offset+14,true)!==checksum||new TextDecoder().decode(bytes.slice(offset+30,offset+30+len))!==n)throw Error('ZIP headers disagree.');
   const data=bytes.slice(offset+30+len,offset+30+len+plain);total+=plain;if(total>LIMIT||crc(data)!==checksum)throw Error('Archive integrity or size check failed.');out.set(n,data);last=offset+30+len+plain;at+=46+len;
  }if(at!==end||last!==start)throw Error('Unexpected archive content.');return out;
 }
 const hash=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),n=>n.toString(16).padStart(2,'0')).join('');
 const base64=b=>{let s='';for(let i=0;i<b.length;i+=8192)s+=String.fromCharCode(...b.subarray(i,i+8192));return btoa(s);};
 const decode=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
 window.UniverseArchive={zip,unzip,hash,base64,decode};
})();
