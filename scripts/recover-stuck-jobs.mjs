import { initDb, rows, run, now, json } from '../src/db.js';

initDb();
const jobs = rows("SELECT * FROM agent_jobs WHERE status='RUNNING'");
for (const job of jobs) {
  const payload = json(job.payload, {});
  const stamp = now();
  const result = { message: 'Local Agent 重启，原运行中任务已终止，请重新提交', recoveredAt: stamp };
  run("UPDATE agent_jobs SET status='FAILED',result=?,completed_at=? WHERE id=?", JSON.stringify(result), stamp, job.id);
  if (job.job_type === 'PUBLISH' && payload.targetId) {
    run("UPDATE publish_targets SET status='FAILED',result=?,updated_at=? WHERE id=?", JSON.stringify(result), stamp, payload.targetId);
    if (payload.taskId) run("UPDATE publish_tasks SET status='FAILED',updated_at=? WHERE id=?", stamp, payload.taskId);
  }
  if (job.job_type === 'REPLY' && payload.messageId) {
    run("UPDATE messages SET status='MANUAL_REQUIRED',decision='TECHNICAL_ERROR',reason=?,updated_at=? WHERE id=?", result.message, stamp, payload.messageId);
  }
  console.log(`Recovered Job#${job.id} ${job.job_type}`);
}
console.log(`Recovered ${jobs.length} running job(s).`);
