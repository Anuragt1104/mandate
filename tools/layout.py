#!/usr/bin/env python3
"""Compute byte offsets of bytemuck/repr(C) accounts from an Anchor IDL.
Offsets include the 8-byte discriminator. Alignment follows SBF (u128/i128 align 8)."""
import json, sys
PRIM = {'u8':(1,1),'i8':(1,1),'bool':(1,1),'u16':(2,2),'i16':(2,2),'u32':(4,4),'i32':(4,4),
        'u64':(8,8),'i64':(8,8),'u128':(16,8),'i128':(16,8),'pubkey':(32,1),'f64':(8,8)}
def load(path):
    idl=json.load(open(path)); return idl, {t['name']:t for t in idl['types']}
def size_align(ty, types):
    if isinstance(ty,str): return PRIM[ty]
    if 'array' in ty:
        s,a=size_align(ty['array'][0],types); return s*ty['array'][1], a
    if 'defined' in ty:
        t=types[ty['defined']['name']]; return struct_layout(t,types)[1:]
    raise ValueError(ty)
def struct_layout(t, types):
    off=0; maxa=1; fields=[]; padded=False
    for f in t['type']['fields']:
        s,a=size_align(f['type'],types)
        if off % a: padded=True; off += a - off % a
        fields.append((f['name'],off,s,f['type'])); off+=s; maxa=max(maxa,a)
    if off % maxa: padded=True; off += maxa - off % maxa
    return fields, off, maxa
def show(path, name, want=None):
    idl,types=load(path); t=types[name]
    fields,size,_=struct_layout(t,types)
    print(f"# {name}: size {size} (+8 disc = {size+8})")
    for n,o,s,ty in fields:
        if want is None or n in want: print(f"  {n:34s} off {o+8:6d} size {s}")
if __name__=='__main__':
    show(sys.argv[1], sys.argv[2], set(sys.argv[3].split(',')) if len(sys.argv)>3 else None)
