import json, base64, struct, urllib.request, sys
RPC="https://api.mainnet-beta.solana.com"
B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58(b):
    n=int.from_bytes(b,'big'); s=''
    while n: n,r=divmod(n,58); s=B58[r]+s
    return '1'*(len(b)-len(b.lstrip(b'\0')))+s
def rpc(m,p):
    req=urllib.request.Request(RPC,data=json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p}).encode(),headers={"Content-Type":"application/json"})
    return json.load(urllib.request.urlopen(req))['result']
def acct(pk):
    r=rpc("getAccountInfo",[pk,{"encoding":"base64"}])['value']
    return base64.b64decode(r['data'][0]), r['owner']
d,o=acct(sys.argv[1]); print('owner',o,'len',len(d),'disc',list(d[:8]))
act=struct.unpack_from('<i',d,76)[0]; step=struct.unpack_from('<H',d,80)[0]
print('active_id',act,'bin_step',step,'status',d[82])
print('token_x',b58(d[88:120]),'token_y',b58(d[120:152]))
print('reserve_x',b58(d[152:184]),'reserve_y',b58(d[184:216]),'oracle',b58(d[552:584]))
print('flags x/y',d[880],d[881])
# price check: (1+step/1e4)^active * 10^(dx-dy)
mx,_=acct(b58(d[88:120])); my,_=acct(b58(d[120:152]))
dx,dy=mx[44],my[44]
print('decimals',dx,dy,'price y per x =',(1+step/1e4)**act*10**(dx-dy))
# bin array containing active bin
idx=act//70 if act>=0 else -((-act-1)//70)-1
import hashlib
