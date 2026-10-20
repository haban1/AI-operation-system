import test from 'node:test';
import assert from 'node:assert/strict';
import { wechatAdminRoute } from '../src/services/wechat-admin-proxy.js';
import { proxyWechatAdmin } from '../src/services/wechat-admin-proxy.js';
import { config } from '../src/config.js';
import http from 'node:http';

test('WeChat proxy limits management methods, paths and queries', () => {
  assert.equal(wechatAdminRoute('GET','/api/wechat/friends','?refresh=true'),'/wechat-robot/friends?refresh=true');
  assert.equal(wechatAdminRoute('POST','/api/wechat/broadcasts'),'/wechat-robot/broadcasts');
  assert.equal(wechatAdminRoute('GET','/api/wechat/broadcasts'),'/wechat-robot/broadcasts');
  assert.equal(wechatAdminRoute('POST','/api/wechat/handoffs/abc/resume'),'/wechat-robot/handoffs/abc/resume');
  for (const [method,path,query] of [['POST','/api/wechat/callback'],['POST','/api/wechat/mass-send'],['GET','/api/wechat/../auth'],['GET','/friends'],['GET','/api/wechat/broadcasts/a/image'],['GET','/api/wechat/friends','?refresh=true&refresh=false'],['GET','/api/wechat/friends','?token=leak'],['DELETE','/api/wechat/handoffs']]) {
    assert.equal(wechatAdminRoute(method,path,query),null);
  }
});

test('Retired WeChat mutation endpoints never contact 8000', async () => {
  let observed;
  const upstream = http.createServer(async (req,res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    observed = {headers:req.headers,body:Buffer.concat(chunks).toString(),url:req.url};
    res.writeHead(202, {'Content-Type':'application/json'}); res.end('{"id":"mock-only"}');
  });
  const gateway = http.createServer((req,res) => proxyWechatAdmin(req,res,new URL(req.url,'http://local')));
  const saved = {wechatAdminBaseUrl:config.wechatAdminBaseUrl, wechatAdminToken:config.wechatAdminToken, wechatRobotAdminUrl:config.wechatRobotAdminUrl, wechatRobotAdminFollowHost:config.wechatRobotAdminFollowHost};
  try {
    await new Promise(resolve => upstream.listen(0,'127.0.0.1',resolve));
    await new Promise(resolve => gateway.listen(0,'127.0.0.1',resolve));
    config.wechatAdminBaseUrl = `http://127.0.0.1:${upstream.address().port}`;
    config.wechatAdminToken = 'server-private';
    const body = new FormData(); body.append('content','模拟消息'); body.append('image',new Blob(['mock-bytes'],{type:'image/png'}),'demo.png');
    const result = await fetch(`http://127.0.0.1:${gateway.address().port}/api/wechat/broadcasts`, {method:'POST',body,headers:{Cookie:'browser-session',Authorization:'Bearer browser'}});
    assert.equal(result.status,410);
    assert.equal(observed,undefined);
    assert.match((await result.json()).message,/已迁移/);
    const adminConfigUrl = `http://127.0.0.1:${gateway.address().port}/api/wechat/robot-admin`;
    config.wechatRobotAdminUrl = 'http://127.0.0.1:8080';
    config.wechatRobotAdminFollowHost = false;
    assert.deepEqual(await (await fetch(adminConfigUrl)).json(),{url:'http://127.0.0.1:8080/'});
    config.wechatRobotAdminFollowHost = true;
    assert.deepEqual(await (await fetch(adminConfigUrl)).json(),{url:'http://127.0.0.1:8080/',followHost:true});
    for (const invalid of ['javascript:alert(1)', 'http://user:password@localhost/', '']) {
      config.wechatRobotAdminUrl = invalid;
      assert.equal((await fetch(adminConfigUrl)).status,503);
    }
    assert.equal((await fetch(adminConfigUrl,{method:'POST'})).status,404);
  } finally {
    Object.assign(config,saved);
    await Promise.all([new Promise(resolve => upstream.close(resolve)),new Promise(resolve => gateway.close(resolve))]);
  }
});
