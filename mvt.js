/* Minimal bounded MVT 2.x reader, implemented from the public protobuf specification.
   No raster fallback, third-party library, telemetry or persistent dataset export. */
(function (root) {
  'use strict';
  const MAX_BYTES=2*1024*1024, MAX_POINTS=16000, MAX_ROADS=1500;
  class Reader {
    constructor(bytes) { this.b=bytes; this.p=0; this.end=bytes.length; }
    uint() {
      let n=0, scale=1;
      for(let i=0;i<10;i++) {
        if(this.p>=this.end)throw Error('PBF truncado');
        const b=this.b[this.p++]; n+=(b&127)*scale;
        if(!(b&128)){if(!Number.isSafeInteger(n))throw Error('Entero PBF fuera de rango');return n;}
        scale*=128;
      }
      throw Error('Varint PBF inválido');
    }
    block() { const n=this.uint(), start=this.p; if(n>this.end-start)throw Error('Longitud PBF inválida');this.p+=n;return this.b.subarray(start,this.p); }
    text() { return new TextDecoder('utf-8',{fatal:true}).decode(this.block()); }
    skip(wire) {
      if(wire===0) {for(let i=0;i<10;i++){if(this.p>=this.end)throw Error('PBF truncado');if(!(this.b[this.p++]&128))return;}throw Error('Varint inválido');}
      if(wire===2){this.block();return;}
      const n=wire===1?8:wire===5?4:0;
      if(!n||this.p+n>this.end)throw Error('Wire PBF inválido');
      this.p+=n;
    }
  }
  function packed(bytes) { const r=new Reader(bytes),out=[];while(r.p<r.end){if(out.length>100000)throw Error('PBF excesivo');out.push(r.uint());}return out; }
  function value(bytes) {
    const r=new Reader(bytes);
    while(r.p<r.end){const t=r.uint(),f=Math.floor(t/8),w=t%8;if(f===1&&w===2)return r.text();if(f===7&&w===0)return !!r.uint();r.skip(w);}
    return null;
  }
  function geometry(commands,extent,budget) {
    let i=0,x=0,y=0,path=null;const lines=[];
    while(i<commands.length) {
      const cmd=commands[i++],id=cmd%8,count=Math.floor(cmd/8);
      if(!count||(id!==1&&id!==2)||count>MAX_POINTS)throw Error('Geometría MVT inválida');
      if(id===1&&count!==1)throw Error('MoveTo de línea inválido');
      if(i+count*2>commands.length)throw Error('Geometría truncada');
      if(id===2&&!path)throw Error('LineTo sin MoveTo');
      for(let n=0;n<count;n++){
        const dx=commands[i++],dy=commands[i++];
        x+=dx%2?-(dx+1)/2:dx/2; y+=dy%2?-(dy+1)/2:dy/2;
        if(Math.abs(x)>extent*4||Math.abs(y)>extent*4)throw Error('Coordenada MVT fuera de rango');
        if(++budget.points>MAX_POINTS)throw Error('Tesela demasiado compleja');
        if(id===1){if(path&&path.length>1)lines.push(path);path=[];}
        path.push([x,y]);
      }
    }
    if(path&&path.length>1)lines.push(path);
    return lines;
  }
  const classes=new Set(['motorway','trunk','primary','secondary','tertiary','minor','service','path','track']);
  function layer(bytes,budget) {
    const r=new Reader(bytes),features=[],keys=[],values=[];
    let name='',version=1,extent=4096;
    while(r.p<r.end) {
      const tag=r.uint(),f=Math.floor(tag/8),w=tag%8;
      if(f===1&&w===2)name=r.text();
      else if(f===15&&w===0)version=r.uint();
      else if(f===5&&w===0)extent=r.uint();
      else if(f===2&&w===2){if(features.length>=30000)throw Error('Demasiadas entidades');features.push(r.block());}
      else if(f===3&&w===2)keys.push(r.text());
      else if(f===4&&w===2)values.push(value(r.block()));
      else r.skip(w);
    }
    if(name!=='transportation')return [];
    if(version!==2||extent<256||extent>65536)throw Error('Versión/extent MVT no soportados');
    const roads=[];
    for(const bytes of features) {
      const f=new Reader(bytes);let type=0,tags=[],commands=[];
      while(f.p<f.end){
        const tag=f.uint(),field=Math.floor(tag/8),wire=tag%8;
        if(field===3&&wire===0)type=f.uint();
        else if(field===2&&wire===2)tags=packed(f.block());
        else if(field===4&&wire===2)commands=packed(f.block());
        else f.skip(wire);
      }
      if(type!==2)continue;
      if(tags.length%2)throw Error('Tags MVT impares');
      const props={};
      for(let i=0;i<tags.length;i+=2){if(tags[i]>=keys.length||tags[i+1]>=values.length)throw Error('Índice MVT inválido');props[keys[tags[i]]]=values[tags[i+1]];}
      if(!classes.has(props.class)||props.brunnel==='tunnel'||props.indoor===1||props.indoor===true)continue;
      for(const points of geometry(commands,extent,budget)){
        if(roads.length>=MAX_ROADS)throw Error('Demasiadas calles');
        roads.push({kind:props.class,points,extent});
      }
    }
    return roads;
  }
  function decode(input) {
    const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
    if(!bytes.length)return [];
    if(bytes.length>MAX_BYTES)throw Error('Tesela demasiado grande');
    const r=new Reader(bytes),roads=[],budget={points:0};let layers=0;
    while(r.p<r.end){const tag=r.uint(),field=Math.floor(tag/8),wire=tag%8;if(field===3&&wire===2){if(++layers>100)throw Error('Demasiadas capas');roads.push(...layer(r.block(),budget));}else r.skip(wire);}
    if(!layers)throw Error('Respuesta no es una tesela MVT');
    return roads;
  }
  function tileAt(lat,lon,z) {
    const n=2**z,phi=Math.max(-85.05112878,Math.min(85.05112878,lat))*Math.PI/180;
    return [((Math.floor((lon+180)/360*n)%n)+n)%n, Math.max(0,Math.min(n-1,Math.floor((1-Math.asinh(Math.tan(phi))/Math.PI)/2*n))),z];
  }
  function lonLat(x,y,z) { const n=2**z;return [x/n*360-180,Math.atan(Math.sinh(Math.PI*(1-2*y/n)))*180/Math.PI]; }
  function geographic(roads,tile) {
    return roads.map(road=>({kind:road.kind,points:road.points.map(p=>lonLat(tile[0]+p[0]/road.extent,tile[1]+p[1]/road.extent,tile[2]))}));
  }
  function sectors(lat,lon,z,radius=160) {
    const dlat=radius/110574,dlon=radius/(111320*Math.max(.01,Math.cos(lat*Math.PI/180)));
    const center=tileAt(lat,lon,z),wanted=[],n=2**z;
    // Test wrapped neighbours against the requested small geographic window.
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const x=(center[0]+dx+n)%n,y=center[1]+dy;if(y<0||y>=n)continue;
      const west=lonLat(x,y,z),east=lonLat(x+1,y+1,z);
      const unwrap=l=>lon+(((l-lon+540)%360)-180);
      if(unwrap(east[0])>=lon-dlon&&unwrap(west[0])<=lon+dlon&&west[1]>=lat-dlat&&east[1]<=lat+dlat)wanted.push([x,y,z]);
    }
    return wanted;
  }
  root.MedievalVector={decode,geographic,tileAt,lonLat,sectors,MAX_BYTES};
})(globalThis);
