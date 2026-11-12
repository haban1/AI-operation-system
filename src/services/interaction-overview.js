import { rows } from '../db.js';

export const visibleInteractionMessagesSql = `m.deleted_at IS NULL
  AND m.platform_code <> 'mini_program'
  AND COALESCE(m.decision,'') <> 'SELF_MESSAGE'
  AND COALESCE(m.status,'') <> 'IGNORED_SELF'
  AND NOT (m.status='SUPERSEDED' AND m.decision='DUPLICATE_PROCESSED_MESSAGE')
  AND NOT (m.decision IN ('HANDOFF_SUBMITTED','HANDOFF_NOTIFY_FAILED')
    AND COALESCE(m.wecom_notification_status,'NOT_REQUIRED') <> 'SENT')`;

export function interactionOverview() {
  return rows(`SELECT m.account_id,m.platform_code,m.message_type,COUNT(*) AS total,
    SUM(CASE WHEN m.handled_at IS NULL
      AND m.status NOT IN ('AUTO_REPLIED','MANUAL_HANDLED','CLOSED','IGNORED_SELF','IGNORED_OFFICIAL','SOURCE_GONE','SUPERSEDED')
      AND (m.status IN ('MANUAL_REQUIRED','KNOWLEDGE_GAP','AI_REPLY_TIMEOUT')
        OR m.decision IN ('MANUAL_REQUIRED','KNOWLEDGE_GAP','AI_REPLY_TIMEOUT')) THEN 1 ELSE 0 END) AS pending,
    MAX(COALESCE(m.collected_at,m.created_at)) AS last_collected_at
    FROM messages m JOIN accounts a ON a.id=m.account_id JOIN platforms p ON p.code=m.platform_code
    WHERE ${visibleInteractionMessagesSql} AND m.message_type IN ('COMMENT','PRIVATE_MESSAGE')
    GROUP BY m.account_id,m.platform_code,m.message_type ORDER BY m.account_id,m.message_type`);
}
