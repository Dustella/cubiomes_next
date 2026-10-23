// WGSL support for the shared Cubiomes layered rules. Seed math is exact u64
// represented as little-endian u32 pairs. Ocean Perlin uses compensated f32
// pairs and integer lattice coordinates, avoiding large-coordinate f32 loss.
export const LEGACY_SHADER_BASE = /* wgsl */ `
struct LayerMeta {
  op:i32, mc:i32, a:i32, b:i32,
  x:i32, z:i32, w:i32, h:i32,
  offset:i32, pad:i32, st:vec2<u32>, ss:vec2<u32>, pad2:vec2<u32>,
}
struct Params { node:i32, pad0:i32, pad1:i32, pad2:i32 }
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> layers:array<LayerMeta>;
@group(0) @binding(2) var<storage,read_write> data:array<i32>;
@group(0) @binding(3) var<storage,read> noiseData:array<u32>;
fn add64(a:vec2<u32>,b:vec2<u32>)->vec2<u32> {
  let lo=a.x+b.x; return vec2<u32>(lo,a.y+b.y+select(0u,1u,lo<a.x));
}
fn mul64(a:vec2<u32>,b:vec2<u32>)->vec2<u32> {
  let a0=a.x&65535u; let a1=a.x>>16u;
  let b0=b.x&65535u; let b1=b.x>>16u;
  let w0=a0*b0; let t=a1*b0+(w0>>16u);
  let w1=a0*b1+(t&65535u);
  let hi=a1*b1+(t>>16u)+(w1>>16u);
  return vec2<u32>((w1<<16u)|(w0&65535u),hi+a.x*b.y+a.y*b.x);
}
fn signed64(x:i32)->vec2<u32> { return vec2<u32>(u32(x),select(0u,4294967295u,x<0)); }
fn rngStep(s:vec2<u32>,salt:vec2<u32>)->vec2<u32> {
  return add64(mul64(s,add64(mul64(s,vec2<u32>(1284865837u,1481765933u)),vec2<u32>(4150755663u,335903614u))),salt);
}
fn chunk(ss:vec2<u32>,x:i32,z:i32)->vec2<u32> {
  var s=add64(ss,signed64(x)); s=rngStep(s,signed64(z)); s=rngStep(s,signed64(x)); return rngStep(s,signed64(z));
}
fn first(s:vec2<u32>,m:i32)->i32 {
  var r=(bitcast<i32>(s.y)>>24)%m;
  r=(r*256+i32((s.y>>16u)&255u))%m;
  r=(r*256+i32((s.y>>8u)&255u))%m;
  r=(r*256+i32(s.y&255u))%m;
  r=(r*256+i32(s.x>>24u))%m;
  return select(r,r+m,r<0);
}
fn bit(s:vec2<u32>,mask:i32)->i32 { return i32(s.x>>24u)&mask; }
fn sample(index:i32,x:i32,z:i32)->i32 {
  if(index<0){return 0;}
  let l=layers[u32(index)];
  return data[u32(l.offset+x-l.x+(z-l.z)*l.w)];
}
// Error-free addition and Dekker product, with operands kept as fractions.
fn dd(a:f32)->vec2<f32>{return vec2<f32>(a,0.0);}
fn ddAdd(a:vec2<f32>,b:vec2<f32>)->vec2<f32>{
  let s=a.x+b.x; let v=s-a.x;
  let e=(a.x-(s-v))+(b.x-v)+a.y+b.y;
  let h=s+e; return vec2<f32>(h,e-(h-s));
}
fn ddNeg(a:vec2<f32>)->vec2<f32>{return -a;}
fn ddMul(a:vec2<f32>,b:vec2<f32>)->vec2<f32>{
  let ca=4097.0*a.x; let ah=ca-(ca-a.x); let al=a.x-ah;
  let cb=4097.0*b.x; let bh=cb-(cb-b.x); let bl=b.x-bh;
  let p=a.x*b.x;
  let e=((ah*bh-p)+ah*bl+al*bh)+al*bl+a.x*b.y+a.y*b.x;
  let h=p+e; return vec2<f32>(h,e-(h-p));
}
fn ddLerp(t:vec2<f32>,a:vec2<f32>,b:vec2<f32>)->vec2<f32>{return ddAdd(a,ddMul(t,ddAdd(b,ddNeg(a))));}
fn fade(t:vec2<f32>)->vec2<f32>{
  return ddMul(ddMul(ddMul(t,t),t),ddAdd(ddMul(t,ddAdd(ddMul(t,dd(6.0)),dd(-15.0))),dd(10.0)));
}
fn gradient(hash:u32,x:vec2<f32>,y:vec2<f32>,z:vec2<f32>)->vec2<f32>{
  switch(hash&15u){
    case 0u,12u:{return ddAdd(x,y);} case 1u:{return ddAdd(ddNeg(x),y);}
    case 2u:{return ddAdd(x,ddNeg(y));} case 3u:{return ddNeg(ddAdd(x,y));}
    case 4u:{return ddAdd(x,z);} case 5u:{return ddAdd(ddNeg(x),z);}
    case 6u:{return ddAdd(x,ddNeg(z));} case 7u:{return ddNeg(ddAdd(x,z));}
    case 8u:{return ddAdd(y,z);} case 9u,13u:{return ddAdd(ddNeg(y),z);}
    case 10u:{return ddAdd(y,ddNeg(z));} case 11u,15u:{return ddNeg(ddAdd(y,z));}
    default:{return ddAdd(ddNeg(x),y);}
  }
}
fn perm(x:i32)->u32{return noiseData[u32(x&255)];}
fn lattice(ix:i32,iy:i32,iz:i32,x:vec2<f32>,y:vec2<f32>,z:vec2<f32>)->vec2<f32>{
  let a=i32(perm(ix))+iy; let b=i32(perm(ix+1))+iy;
  let aa=i32(perm(a))+iz; let ab=i32(perm(a+1))+iz;
  let ba=i32(perm(b))+iz; let bb=i32(perm(b+1))+iz;
  let xm=ddAdd(x,dd(-1.0)); let ym=ddAdd(y,dd(-1.0)); let zm=ddAdd(z,dd(-1.0));
  let sx=fade(x); let sy=fade(y); let sz=fade(z);
  return ddLerp(sz,
    ddLerp(sy,ddLerp(sx,gradient(perm(aa),x,y,z),gradient(perm(ba),xm,y,z)),ddLerp(sx,gradient(perm(ab),x,ym,z),gradient(perm(bb),xm,ym,z))),
    ddLerp(sy,ddLerp(sx,gradient(perm(aa+1),x,y,zm),gradient(perm(ba+1),xm,y,zm)),ddLerp(sx,gradient(perm(ab+1),x,ym,zm),gradient(perm(bb+1),xm,ym,zm))));
}
fn oceanTemp(x:i32,z:i32)->i32 {
  // The final nine words are floor(offset), fractional high and fractional low.
  var ix=(x>>3)+i32(noiseData[256u]);
  var iy=(z>>3)+i32(noiseData[259u]);
  let iz=i32(noiseData[262u]);
  var fx=ddAdd(dd(f32(x&7)*0.125),vec2<f32>(bitcast<f32>(noiseData[257u]),bitcast<f32>(noiseData[258u])));
  var fy=ddAdd(dd(f32(z&7)*0.125),vec2<f32>(bitcast<f32>(noiseData[260u]),bitcast<f32>(noiseData[261u])));
  let fz=vec2<f32>(bitcast<f32>(noiseData[263u]),bitcast<f32>(noiseData[264u]));
  if(fx.x>1.0||(fx.x==1.0&&fx.y>=0.0)){ix++;fx=ddAdd(fx,dd(-1.0));}
  if(fy.x>1.0||(fy.x==1.0&&fy.y>=0.0)){iy++;fy=ddAdd(fy,dd(-1.0));}
  let n=lattice(ix,iy,iz,fx,fy,fz);
  let a=ddAdd(n,vec2<f32>(-0.4,0.000000005960464477539063));
  if(a.x>0.0||(a.x==0.0&&a.y>0.0)){return 44;}
  let b=ddAdd(n,vec2<f32>(-0.2,0.0000000029802322387695313));
  if(b.x>0.0||(b.x==0.0&&b.y>0.0)){return 45;}
  let c=ddAdd(n,vec2<f32>(0.4,-0.000000005960464477539063));
  if(c.x<0.0||(c.x==0.0&&c.y<0.0)){return 10;}
  let d=ddAdd(n,vec2<f32>(0.2,-0.0000000029802322387695313));
  if(d.x<0.0||(d.x==0.0&&d.y<0.0)){return 46;}
  return 0;
}
`;
