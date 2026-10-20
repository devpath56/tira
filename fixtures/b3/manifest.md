# B3 blind fixture, round 1: manifest

Revealed 2026-10-20, after Devansh's verdicts were locked (`verdicts.json`). Score: `node scripts/b3-score.ts`.

M = 8 planted divergences; 39 clean transitions in both files.
Counts: OK 39, MISSING 2, DUPLICATE 1, ORPHAN 1, WRONG-ENTITY 2, PHANTOM 2.

| # | Expected verdict | Transition | event_id | How |
|---|---|---|---|---|
| 1 | MISSING | NAMED session:s7 by s7 | `fx:50e5e86c8fa7ee5458eea6258f485f356203d240f1584f65055ed4bf30ab0a14` | the factory committed s7's naming; tira never received it |
| 2 | DUPLICATE | DISPATCHED brief:b6@1 by orchestrator | `fx:dd3ced3c37938068e54a73080ad48e65e48090408e4db8450c5c6ef236388b4c` | the factory journaled b6's dispatch twice (a retry); tira deduplicated it |
| 3 | MISSING | DISPATCHED brief:b10@1 by orchestrator | `fx:d66354df4cbb8a6c0f3528239622f8960ee54ef0b5b11143bb1dff3d930e4ae5` | the factory committed b10's dispatch; tira never received it |
| 4 | ORPHAN | DISPATCHED brief:zz@1 by orchestrator | `fx:ab0d3a84a70c5924823cfa42bc250e2ffa3926ce27a6eb951cb588b57dda55f7` | a dispatch of brief zz, which was never created: tira refused it (unknown-entity); the factory recorded it as committed |
| 5 | WRONG-ENTITY | CLAIMED brief:b4@1 by s4 | `fx:0e040d14b59857699215300ffb5512d5e360b06e4717121826f9ba46d9450e8f` | tira has s4's claim on b4@1; the factory's record of the same event_id names b7@1 |
| 6 | PHANTOM | CLAIMED brief:b7@1 by s5 | `fx:7f663f03435e1090044acdf0dec0638578f9e91556e0b4ce9e333d480f8733fe` | tira has s5's claim on b7; the factory has no record of it (rolled back after emitting) |
| 7 | WRONG-ENTITY | FILED drop:b3@1 by s3 | `fx:7d449a22d31a072065043cda22727519832d860e9903b1338db9c30875aa1bee` | tira has s3's drop for b3@1; the factory's record of the same event_id names b9@1 |
| 8 | PHANTOM | RENAMED session:s2 by s2 | `fx:b44d8235446f0a3608ef4b21826ce1ae65ddc1e2f8f9d73f936f73849b873725` | tira has s2's rename; the factory has no record of it |

Every other event_id in factory-state.jsonl is OK. `manifest.json` lists all of them, for mechanical scoring.
