import pathlib, hashlib, zipfile, json, sqlite3
root=pathlib.Path.cwd()
final=root/'dist'/'天河AI数字员工平台-精简交付包-20260814'
checks=final/'checksums.sha256'
files=[p for p in final.rglob('*') if p.is_file() and p!=checks]
lines=[]
for p in sorted(files,key=lambda x:x.relative_to(final).as_posix()):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda:f.read(4*1024*1024),b''):h.update(chunk)
    lines.append(f'{h.hexdigest().upper()} *{p.relative_to(final).as_posix()}')
checks.write_text('\n'.join(lines)+'\n',encoding='utf-8-sig')
zip_path=root/'dist'/'天河AI数字员工平台-精简交付包-20260814.zip'
if zip_path.exists(): zip_path.unlink()
with zipfile.ZipFile(zip_path,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9,allowZip64=True) as z:
    for p in sorted([p for p in final.rglob('*') if p.is_file()],key=lambda x:x.relative_to(final.parent).as_posix()):
        z.write(p,p.relative_to(final.parent).as_posix())
with zipfile.ZipFile(zip_path) as z:
    bad=z.testzip(); names=z.namelist()
def sha(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda:f.read(4*1024*1024),b''):h.update(chunk)
    return h.hexdigest().upper()
installer=final/'01_安装包'/'Tianhe-AI-Digital-Employee-Setup-0.1.0.exe'
db=final/'03_数据库迁移'/'天河AI数字员工平台-业务数据库-20260814.db'
con=sqlite3.connect(f'file:{db}?mode=ro',uri=True)
integrity=[r[0] for r in con.execute('PRAGMA integrity_check')]
table_count=con.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchone()[0]
con.close()
summary={'installer':{'path':str(installer),'bytes':installer.stat().st_size,'sha256':sha(installer)},'database':{'path':str(db),'bytes':db.stat().st_size,'sha256':sha(db),'integrity':integrity,'tables':table_count},'zip':{'path':str(zip_path),'bytes':zip_path.stat().st_size,'sha256':sha(zip_path),'bad':bad,'entries':len(names)},'directory':{'path':str(final),'files':len([p for p in final.rglob('*') if p.is_file()]),'bytes':sum(p.stat().st_size for p in final.rglob('*') if p.is_file())}}
(root/'dist'/'final-delivery-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(summary,ensure_ascii=False,indent=2))
