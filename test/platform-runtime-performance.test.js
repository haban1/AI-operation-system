import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {platformRuntimeRows} from '../src/services/platform-runtime.js';

function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE platforms(code TEXT PRIMARY KEY,name TEXT,sort_order INTEGER,desired_state TEXT,runtime_updated_at TEXT,runtime_updated_by TEXT,lifecycle_state TEXT);
 CREATE TABLE accounts(id INTEGER PRIMARY KEY,platform_code TEXT,enabled INTEGER,login_status TEXT);
 CREATE TABLE agent_jobs(id INTEGER PRIMARY KEY,payload TEXT,status TEXT);
 CREATE INDEX idx_jobs_platform_status ON agent_jobs(json_extract(payload,'$.platformCode'),status,id);
 INSERT INTO platforms VALUES('douyin','抖音',1,'RUNNING',NULL,NULL,'ACTIVE'),('xiaohongshu','小红书',2,'STOPPED',NULL,NULL,'ACTIVE'),('weibo','微博',3,'RUNNING',NULL,NULL,'PLANNED'),('bilibili','B站',4,'RUNNING',NULL,NULL,'ACTIVE');
 INSERT INTO accounts VALUES(1,'douyin',1,'READY'),(2,'douyin',1,'EXPIRED'),(3,'douyin',0,'READY'),(4,'xiaohongshu',1,'READY'),(5,'weibo',1,'READY');`);
 const insert=db.prepare('INSERT INTO agent_jobs(payload,status) VALUES(?,?)');
 for(const [code,status,n] of [['douyin','SUCCESS',20000],['douyin','QUEUED',3],['douyin','RUNNING',2],['xiaohongshu','QUEUED',4],['weibo','NEEDS_CONFIRMATION',10]])for(let i=0;i<n;i++)insert.run(JSON.stringify({platformCode:code}),status);
 for(const value of [null,123,true,{},['douyin']])insert.run(JSON.stringify({platformCode:value}),'QUEUED');
 return db;
}
test('platform status counts seek the expression index, not all historical jobs',t=>{
 const db=fixture(t);let plan;
 const result=platformRuntimeRows({activePlatformCodes:['douyin','xiaohongshu','weibo','bilibili'],rows:(sql,...args)=>{plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args);const actual=db.prepare(sql).all(...args);const before=db.prepare(sql.replaceAll('=+p.code','=p.code')).all(...args);assert.deepEqual(actual,before);return actual;}});
 const counts=plan.filter(x=>/idx_jobs_platform_status/.test(x.detail));assert.equal(counts.length,2);assert.ok(counts.every(x=>/SEARCH j .*idx_jobs_platform_status/.test(x.detail)),JSON.stringify(plan));
 assert.deepEqual(result.map(x=>[x.code,x.queued_job_count,x.running_job_count,x.effective_state]),[['douyin',3,2,'RUNNING'],['xiaohongshu',4,0,'STOPPED'],['weibo',0,0,'STOPPED'],['bilibili',0,0,'STOPPED']]);
 assert.equal(result[0].enabled_account_count,2);assert.equal(result[0].ready_account_count,1);
});
test('runtime summary reflects job and platform changes immediately without caching',t=>{
 const db=fixture(t);const read=()=>platformRuntimeRows({activePlatformCodes:['douyin'],rows:(sql,...args)=>db.prepare(sql).all(...args)})[0];
 assert.equal(read().queued_job_count,3);db.exec("UPDATE agent_jobs SET status='SUCCESS' WHERE status='QUEUED'; UPDATE platforms SET desired_state='STOPPED' WHERE code='douyin'");
 assert.equal(read().queued_job_count,0);assert.equal(read().effective_state,'STOPPED');
});
