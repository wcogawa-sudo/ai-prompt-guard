# Kibana queries and detection rules

Index pattern: `prompt-guard-events*`

## Install the index template

```bash
curl -X PUT "$ES_URL/_index_template/prompt-guard" \
  -H "Authorization: ApiKey $ES_API_KEY" -H "Content-Type: application/json" \
  --data @elastic/index-template.json
```

Do this before the first event arrives, so the fields are typed correctly.

## SOC alert rules (Security → Rules → Custom query)

| Rule | KQL | Severity |
|---|---|---|
| Blocked sensitive data (cards, secrets) | `alert.soc : true and event.action : ("prompt_blocked" or "paste_blocked")` | High |
| Bulk data paste (looks like an export) | `bulk : true` | High |
| User sent unredacted data via override | `event.action : ("prompt_sent_unredacted" or "paste_unredacted")` | Medium |
| Redaction failed on a page | `event.action : "redaction_failed"` | Medium (adapter likely broken) |
| Site UI changed (adapter degraded) | `event.action : "adapter_degraded"` | Low (maintenance) |
| Collector found raw PII the extension missed | `collector.rescrubbed : true` | Low (detector gap) |

## Behaviour: cancel then retry (possible evasion)

A threshold or EQL rule. The same user cancels a warning and then sends a prompt in the same conversation within 5 minutes:

```eql
sequence by user.name, ai.conversation_hash with maxspan=5m
  [any where event.action == "prompt_cancelled"]
  [any where event.action == "prompt_sent"]
```

A `prompt_sent` right after a cancel means the second attempt had **no** detections. The user may have reworded the data to slip past the detectors. That's worth a look, not an automatic incident.

## Dashboard ideas

- Prompts per AI site per day (`event.action : prompt_*`)
- Top data types detected (`detections.type`, nested)
- Warning outcomes: accepted vs cancelled vs override (`user.decision`)
- False-positive reports by type (`event.action : false_positive_report`) → tune detectors
- Hosts that stopped reporting (no events in 7 days while active before) → extension removed or disabled
