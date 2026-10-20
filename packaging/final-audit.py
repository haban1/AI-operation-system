import pathlib, hashlib, zipfile, json, sqlite3, re
root=pathlib.Path.cwd()
final=root/'dist'/'天河AI数字员工平台-精简交付包-20260814'
db=final/'03_数据库迁移'/'天河AI数字员工平台-业务数据库-20260814.db'
for suffix in ('-shm','-wal'):
    p=pathlib.Path(str(db)+suffix)
    if p.exists(): p.unlink()
con=sqlite3.connect(f'file:{db.as_posix()}?mode=ro&immutable=1',uri=True)
integrity=[r[0] for r in con.execute('PRAGMA integrity_check')]
table_count=con.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchone()[0]
con.close()
def sha(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda:f.read(4*1024*1024),b''):h.update(chunk)
    return h.hexdigest().upper()
checks=final/'checksums.sha256'
if checks.exists(): checks.unlink()
files=sorted([p for p in final.rglob('*') if p.is_file()],key=lambda x:x.relative_to(final).as_posix())
checks.write_text('\n'.join(f'{sha(p)} *{p.relative_to(final).as_posix()}' for p in files)+'\n',encoding='utf-8-sig')
zip_path=root/'dist'/'天河AI数字员工平台-精简交付包-20260814.zip'
if zip_path.exists(): zip_path.unlink()
with zipfile.ZipFile(zip_path,'w',zipfile.ZIP_DEFLATED,compresslevel=9,allowZip64=True) as z:
    for p in sorted([p for p in final.rglob('*') if p.is_file()],key=lambda x:x.relative_to(final.parent).as_posix()):
        z.write(p,p.relative_to(final.parent).as_posix())
with zipfile.ZipFile(zip_path) as z:
    bad=z.testzip(); names=z.namelist()
patterns=[r'(^|/)README\.md$',r'(^|/)package-lock\.json$',r'(^|/)\.env$',r'(^|/)data/',r'(^|/)logs/',r'(^|/)outputs/',r'(^|/)scripts/',r'(^|/)platform-workflows/',r'(^|/)sample-material/',r'(^|/)05_',r'源码',r'设计报告',r'备份']
forbidden=[n for n in names if any(re.search(p,n,re.I) for p in patterns)]
installer=final/'01_安装包'/'Tianhe-AI-Digital-Employee-Setup-0.1.0.exe'
xlsx=sorted((final/'04_知识库Excel').rglob('*.xlsx'))
summary={'installer':{'path':str(installer),'bytes':installer.stat().st_size,'sha256':sha(installer)},'database':{'path':str(db),'bytes':db.stat().st_size,'sha256':sha(db),'integrity':integrity,'tables':table_count},'zip':{'path':str(zip_path),'bytes':zip_path.stat().st_size,'sha256':sha(zip_path),'bad':bad,'entries':len(names),'forbidden':forbidden},'directory':{'path':str(final),'files':len([p for p in final.rglob('*') if p.is_file()]),'bytes':sum(p.stat().st_size for p in final.rglob('*') if p.is_file()),'sidecars':[str(p) for p in final.rglob('*.db-*')]},'xlsx':{'count':len(xlsx),'paths':[str(p) for p in xlsx]}}
(root/'dist'/'final-delivery-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(summary,ensure_ascii=False,indent=2))
