# Audit template config (jsonb)

Stored in `audit_templates.config`; validated by `app.template_config_valid()` (a CHECK constraint). A published
`(name, version)` is immutable; change a template by inserting a new version. Lengths are integer 1/64".

```jsonc
{
  "policy": { "nonCriticalIssueState": "manager_review_required" },   // or "ready_with_exceptions"
  "sections": [{
    "key": "walls", "title": "Wall conditions",
    "items": [{
      "key": "wall_length", "label": "Wall length (vs approved drawing)",
      "kind": "tolerance",            // "check" | "tolerance" | "observation"
      "critical": false,              // critical FAIL = NOT READY (stop-gate). Observation items cannot be critical.
      "requires": { "photo": 1, "measurement": true, "note": true, "drawingRef": true },   // all optional
      "rule": { "plus64": 32, "minus64": 32, "reviewBand64": 64,          // tolerance items only; reviewBand optional
                "source": "company_standard", "sourceRef": "...", "method": "tape measure" }
    }]
  }]
}
```

- `tolerance` items: client sends `actual64` and `expected64` (expected comes from the approved drawing); plus/minus/band come
  from `rule`, and the server computes PASS / REVIEW / FAIL. `reviewBand64` is the max TOTAL deviation from expected that is
  still REVIEW (>= max(plus, minus)).
- `check` items: result PASS / FAIL / REVIEW / NOT_APPLICABLE. `observation` items: OBSERVED only (never affects readiness).
- `requires.supervisorApproval` is accepted by the validator but NOT implemented yet: items with it are rejected at write time.
- `supabase/seed.sql` holds an EXAMPLE template built from the Stage 1 checklist; it is not a company-approved standard.
