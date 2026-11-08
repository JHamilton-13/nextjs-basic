-- LOCAL / TEST SEED ONLY. Not a migration; never applied automatically.
-- Sample template built from the Stage 1 checklist in the project brief. It is an EXAMPLE, not a company-approved
-- standard. Tolerance data (wall length, ceiling height: +/-1/2", review band 1" total deviation) comes from the
-- owner's 2026-11-07 decision. Only MEP rough-in conflict items are critical (stop-gate).
insert into public.audit_templates (id, name, version, config)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'EXAMPLE - Pre-Install Site Audit (sample, not company-approved)', 1,
$json${
 "policy": {
  "nonCriticalIssueState": "manager_review_required"
 },
 "sections": [
  {
   "key": "general",
   "title": "General site conditions",
   "items": [
    {
     "key": "access",
     "label": "Access to installation area",
     "kind": "check",
     "critical": false
    },
    {
     "key": "elevator_stairs",
     "label": "Elevator and stair access",
     "kind": "check",
     "critical": false
    },
    {
     "key": "loading",
     "label": "Loading and unloading conditions",
     "kind": "check",
     "critical": false
    },
    {
     "key": "parking_staging",
     "label": "Parking and material staging",
     "kind": "check",
     "critical": false
    },
    {
     "key": "cleanliness",
     "label": "Work area cleanliness",
     "kind": "check",
     "critical": false
    },
    {
     "key": "lighting",
     "label": "Lighting",
     "kind": "check",
     "critical": false
    },
    {
     "key": "hvac",
     "label": "HVAC conditions",
     "kind": "check",
     "critical": false
    },
    {
     "key": "surface_protection",
     "label": "Protection of finished surfaces",
     "kind": "check",
     "critical": false
    },
    {
     "key": "site_security",
     "label": "Site security",
     "kind": "check",
     "critical": false
    }
   ]
  },
  {
   "key": "walls",
   "title": "Wall conditions",
   "items": [
    {
     "key": "wall_length",
     "label": "Wall length (vs approved drawing)",
     "kind": "tolerance",
     "critical": false,
     "requires": {
      "measurement": true,
      "drawingRef": true
     },
     "rule": {
      "plus64": 32,
      "minus64": 32,
      "reviewBand64": 64,
      "source": "company_standard",
      "sourceRef": "Owner decision 2026-11-07",
      "method": "tape measure"
     }
    },
    {
     "key": "wall_plumb",
     "label": "Wall plumbness (observation)",
     "kind": "observation",
     "critical": false
    },
    {
     "key": "wall_flat",
     "label": "Wall flatness (observation)",
     "kind": "observation",
     "critical": false
    },
    {
     "key": "wall_bow",
     "label": "Wall bowing (observation)",
     "kind": "observation",
     "critical": false
    },
    {
     "key": "corners",
     "label": "Inside/outside corner conditions (observation)",
     "kind": "observation",
     "critical": false
    },
    {
     "key": "stud_locations",
     "label": "Stud locations",
     "kind": "check",
     "critical": false
    },
    {
     "key": "backing_blocking",
     "label": "Backing and blocking",
     "kind": "check",
     "critical": false
    },
    {
     "key": "finished_walls",
     "label": "Finished wall conditions",
     "kind": "check",
     "critical": false
    }
   ]
  },
  {
   "key": "floors",
   "title": "Floor conditions",
   "items": [
    {
     "key": "floor_level",
     "label": "Floor levelness (observation)",
     "kind": "observation",
     "critical": false
    },
    {
     "key": "floor_transitions",
     "label": "Floor transitions (observation)",
     "kind": "observation",
     "critical": false
    },
    {
     "key": "finished_flooring",
     "label": "Finished flooring",
     "kind": "check",
     "critical": false
    },
    {
     "key": "subfloor",
     "label": "Subfloor conditions",
     "kind": "check",
     "critical": false
    },
    {
     "key": "height_variation",
     "label": "Height variations (observation)",
     "kind": "observation",
     "critical": false
    }
   ]
  },
  {
   "key": "ceilings",
   "title": "Ceiling conditions",
   "items": [
    {
     "key": "ceiling_height",
     "label": "Ceiling height (vs approved drawing)",
     "kind": "tolerance",
     "critical": false,
     "requires": {
      "measurement": true,
      "drawingRef": true
     },
     "rule": {
      "plus64": 32,
      "minus64": 32,
      "reviewBand64": 64,
      "source": "company_standard",
      "sourceRef": "Owner decision 2026-11-07",
      "method": "tape measure"
     }
    },
    {
     "key": "ceiling_level",
     "label": "Ceiling levelness (observation)",
     "kind": "observation",
     "critical": false
    },
    {
     "key": "crown_conditions",
     "label": "Crown molding conditions",
     "kind": "check",
     "critical": false
    },
    {
     "key": "soffits",
     "label": "Soffits",
     "kind": "check",
     "critical": false
    },
    {
     "key": "ceiling_obstructions",
     "label": "Ceiling obstructions",
     "kind": "check",
     "critical": false
    },
    {
     "key": "clearance",
     "label": "Available clearance",
     "kind": "check",
     "critical": false
    }
   ]
  },
  {
   "key": "mep",
   "title": "MEP rough-in conflicts (stop-gate)",
   "items": [
    {
     "key": "plumbing_rough_in",
     "label": "Plumbing rough-ins vs drawing/appliance specs",
     "kind": "check",
     "critical": true,
     "requires": {
      "photo": 1
     }
    },
    {
     "key": "outlets",
     "label": "Electrical outlets",
     "kind": "check",
     "critical": true,
     "requires": {
      "photo": 1
     }
    },
    {
     "key": "switches",
     "label": "Switches",
     "kind": "check",
     "critical": true,
     "requires": {
      "photo": 1
     }
    },
    {
     "key": "junction_boxes",
     "label": "Junction boxes",
     "kind": "check",
     "critical": true,
     "requires": {
      "photo": 1
     }
    },
    {
     "key": "appliance_connections",
     "label": "Appliance connections",
     "kind": "check",
     "critical": true,
     "requires": {
      "photo": 1
     }
    },
    {
     "key": "hvac_registers",
     "label": "HVAC registers",
     "kind": "check",
     "critical": true,
     "requires": {
      "photo": 1
     }
    },
    {
     "key": "sprinklers",
     "label": "Sprinklers",
     "kind": "check",
     "critical": true,
     "requires": {
      "photo": 1
     }
    },
    {
     "key": "other_obstructions",
     "label": "Other obstructions",
     "kind": "check",
     "critical": true,
     "requires": {
      "photo": 1
     }
    }
   ]
  },
  {
   "key": "drawings",
   "title": "Drawing verification",
   "items": [
    {
     "key": "drawing_revision",
     "label": "Correct shop drawing revision",
     "kind": "check",
     "critical": false
    },
    {
     "key": "room_elevation",
     "label": "Correct room and elevation",
     "kind": "check",
     "critical": false
    },
    {
     "key": "dimensions_verified",
     "label": "Dimensions verified",
     "kind": "check",
     "critical": false
    },
    {
     "key": "appliance_specs",
     "label": "Appliance specifications verified",
     "kind": "check",
     "critical": false
    },
    {
     "key": "cabinet_locations",
     "label": "Cabinet locations verified",
     "kind": "check",
     "critical": false
    },
    {
     "key": "conflicts",
     "label": "Potential conflicts identified",
     "kind": "check",
     "critical": false
    }
   ]
  }
 ]
}$json$::jsonb)
on conflict (id) do nothing;
