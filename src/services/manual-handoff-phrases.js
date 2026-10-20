import { rows } from '../db.js';

export function enabledManualHandoffPhrases() {
  return rows(`SELECT p.phrase AS phrase,p.normalized_phrase AS normalized_phrase,'ENABLED' AS status
    FROM manual_handoff_phrases p WHERE p.status='ENABLED'
    UNION ALL
    SELECT a.alias_text AS phrase,a.normalized_text AS normalized_phrase,'ENABLED' AS status
    FROM manual_handoff_phrase_aliases a JOIN manual_handoff_phrases p ON p.id=a.phrase_id
    WHERE p.status='ENABLED' AND a.status='ENABLED' AND a.validation_status='VALID' AND a.phrase_version=p.version`);
}
